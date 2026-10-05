# Cloud Job Runner

A small job runner: an Express API accepts commands over HTTP and enqueues them in Redis via [BullMQ](https://docs.bullmq.io/); a separate worker process consumes and executes them.

```
client ──POST /jobs──▶ api ──Queue.add──▶ Redis (BullMQ queue) ◀──Worker── worker
```

## Running

```bash
docker compose up --build
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"command":"echo hello"}'
# => {"jobId":"<uuid>","status":"queued"}
docker compose logs -f worker
```

Locally without Docker (needs a Redis on `localhost:6379`):

```bash
npm install
npm run dev:api
npm run dev:worker
```

## Source layout

| File | Purpose |
| --- | --- |
| `src/config.ts` | Reads and validates all environment variables (fails fast on invalid values). |
| `src/logger.ts` | Minimal structured JSON logger (one JSON object per line, `LOG_LEVEL` aware). |
| `src/redis.ts` | Creates the ioredis connection used by BullMQ and logs connection events. |
| `src/queue.ts` | BullMQ `Queue` (producer) with default job options: retries, backoff, retention. |
| `src/api.ts` | HTTP API (`POST /jobs`, `GET /`). |
| `src/worker.ts` | BullMQ `Worker` (consumer): job processing, logging, error handling, shutdown. |

## Worker architecture

### Job lifecycle

1. `POST /jobs` validates `command`, generates a UUID and calls `jobQueue.add("execute-command", { jobId, command }, { jobId })`. The UUID is used as the BullMQ job id, so the id returned to the client is the same id that appears in Redis and in every log line.
2. The job is stored in Redis with the queue's default options (`attempts`, `backoff`, `removeOnComplete`, `removeOnFail`) and placed in the `wait` list.
3. The worker (up to `WORKER_CONCURRENCY` jobs in parallel) moves the job to `active` and runs `processJob`:
   - validates the payload; an invalid payload throws `UnrecoverableError`, which fails the job immediately without retrying;
   - executes the command under `JOB_TIMEOUT_MS` using an `AbortController`. Execution is currently **simulated** (waits `SIMULATED_JOB_DURATION_MS`); it is the place where isolated Docker execution will be plugged in;
   - writes attempt start/finish entries to the BullMQ job log (`job.log`), visible in tools such as Bull Board.
4. On success the result `{ jobId, output }` is stored as the job's return value and the job moves to `completed`.
5. On error (thrown exception or timeout) BullMQ either schedules a retry or moves the job to `failed`.

### Retries

Retries are configured on the queue (`defaultJobOptions` in `src/queue.ts`), so they apply to every job the API enqueues:

- `JOB_ATTEMPTS` total attempts (default 3, i.e. 2 retries).
- `JOB_BACKOFF_TYPE` `exponential` (default) or `fixed`, starting at `JOB_BACKOFF_DELAY_MS`. With the defaults the retries run after ~1s and ~2s.
- `UnrecoverableError` skips the remaining attempts.
- Finished jobs are trimmed to the last `JOB_KEEP_COMPLETED` completed / `JOB_KEEP_FAILED` failed jobs so Redis memory does not grow without bound.

### Logging

Both processes log one JSON object per line to stdout (`debug`/`info`) or stderr (`warn`/`error`), which works directly with `docker compose logs` and CloudWatch. Each job log line includes `jobId`; worker events logged:

| Event | Level | `msg` |
| --- | --- | --- |
| attempt starts | info | `Job started` (with `attempt` / `maxAttempts`) |
| attempt fails, will retry | warn | `Job attempt failed, will retry` |
| job fails for good | error | `Job failed permanently` |
| job completes | info | `Job completed` (with `durationMs`, `output`) |
| stalled job / lock renewal failure | warn | `Job stalled ...` / `Job lock renewal failed` |
| worker / Redis connection errors | error | `Worker error` / `Redis connection error` |

### Error handling and shutdown

- `worker.on("error")` and Redis connection listeners log infrastructure errors instead of letting them crash the process; ioredis reconnects automatically.
- On `SIGTERM`/`SIGINT` (e.g. `docker compose stop`, ECS task stop) the worker stops taking new jobs, waits for active jobs to finish (`worker.close()`), closes Redis and exits. If that takes longer than `WORKER_SHUTDOWN_TIMEOUT_MS` it force-exits; BullMQ's stalled-job check then returns the unfinished job to the queue. `stop_grace_period` in `docker-compose.yml` (30s) is longer than the default shutdown timeout (25s).
- Unhandled rejections are logged; uncaught exceptions are logged and trigger a graceful shutdown with exit code 1.

## Configuration

All settings are environment variables; invalid values make the process exit at startup with a descriptive error. `docker-compose.yml` passes them through with the defaults below, so they can be overridden from the shell or an `.env` file (e.g. `JOB_ATTEMPTS=5 docker compose up`).

| Variable | Used by | Default | Description |
| --- | --- | --- | --- |
| `PORT` | api | `3000` | HTTP port. |
| `REDIS_HOST` | both | `localhost` | Redis host (`redis` in Compose). |
| `REDIS_PORT` | both | `6379` | Redis port. |
| `REDIS_PASSWORD` | both | _(unset)_ | Redis password (optional). |
| `QUEUE_NAME` | both | `jobs` | BullMQ queue name. Must match between api and worker. |
| `LOG_LEVEL` | both | `info` | `debug`, `info`, `warn` or `error`. |
| `JOB_ATTEMPTS` | api | `3` | Total attempts per job, including the first. |
| `JOB_BACKOFF_TYPE` | api | `exponential` | `exponential` or `fixed`. |
| `JOB_BACKOFF_DELAY_MS` | api | `1000` | Base retry delay. |
| `JOB_KEEP_COMPLETED` | api | `1000` | Completed jobs kept in Redis. |
| `JOB_KEEP_FAILED` | api | `5000` | Failed jobs kept in Redis. |
| `WORKER_CONCURRENCY` | worker | `1` | Jobs processed in parallel per worker process. |
| `JOB_TIMEOUT_MS` | worker | `30000` | Per-attempt execution timeout. |
| `SIMULATED_JOB_DURATION_MS` | worker | `2000` | Duration of the simulated execution. |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | worker | `25000` | Max time to wait for active jobs on shutdown. |

Retry options are applied when a job is enqueued, so they are read by the **api** process.

### Trying the retry path

Force every attempt to time out and watch the retries:

```bash
JOB_TIMEOUT_MS=500 docker compose up --build -d
curl -X POST localhost:3000/jobs -H 'Content-Type: application/json' -d '{"command":"sleep"}'
docker compose logs -f worker   # 2x "will retry", then "Job failed permanently"
```

## Deployment (single EC2 instance)

`deploy/ec2/` runs the whole stack on one EC2 instance with Docker Compose:

```
Internet ──HTTP :80──▶ EC2 security group (only port 80 open)
                         └─ Docker host (Ubuntu 24.04)
                              ├─ api     container, host port 80 → 3000
                              ├─ worker  container (no ports)
                              └─ redis   container (no host ports; AOF persistence on a named volume)
                              all three on the private Compose network; api/worker reach Redis as `redis:6379`
```

- `docker-compose.prod.yml` overrides the base file: removes Redis's published port, maps the API to host port 80, enables Redis AOF persistence (`noeviction`, as BullMQ requires), and sets `restart: unless-stopped` so containers come back after crashes and reboots.
- `deploy/ec2/deploy.sh` uses the AWS CLI's normal credential chain (env vars, profile or SSO; nothing is stored in the repo). It creates a security group with only TCP 80 open, launches the instance with `user-data.sh`, and attaches an Elastic IP. No SSH port is opened.
- `deploy/ec2/user-data.sh` runs on first boot. It installs Docker, clones the repo at `REPO_REF`, and runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. The bootstrap log is `/var/log/cloud-job-runner-bootstrap.log`.

```bash
AWS_REGION=us-east-1 ./deploy/ec2/deploy.sh        # prints the public API URL
curl -X POST http://<public-ip>/jobs -H 'Content-Type: application/json' -d '{"command":"echo hello"}'
AWS_REGION=us-east-1 ./deploy/ec2/teardown.sh      # deletes the instance, Elastic IP and security group
```

Optional env vars for `deploy.sh`: `STACK_NAME` (default `cloud-job-runner`, used for names and tags), `INSTANCE_TYPE` (default `t4g.small`, ARM), `REPO_URL`, `REPO_REF` (default `main`).

Limitations: plain HTTP (HTTPS needs a domain and a certificate), no authentication on `POST /jobs`, and a single host, so there is no failover.
