import { UnrecoverableError, Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { createLogger, serializeError } from "./logger.js";
import type { CommandJobData, CommandJobResult } from "./queue.js";
import { createRedisConnection } from "./redis.js";

const logger = createLogger({ service: "worker", queue: config.queue.name });
const connection = createRedisConnection(logger.child({ component: "redis" }));

class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Job exceeded timeout of ${timeoutMs}ms`);
    this.name = "JobTimeoutError";
  }
}

function validateJobData(data: unknown): CommandJobData {
  const { jobId, command } = (data ?? {}) as Partial<CommandJobData>;
  if (typeof jobId !== "string" || !jobId || typeof command !== "string" || !command) {
    throw new UnrecoverableError("Invalid job payload: jobId and command must be non-empty strings");
  }
  return { jobId, command };
}

// Temporary implementation. We will later replace this with isolated Docker execution.
function executeCommand(command: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => resolve(`Simulated execution of: ${command}`),
      config.worker.simulatedJobDurationMs,
    );
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function runWithTimeout<T>(
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new JobTimeoutError(timeoutMs)), timeoutMs);
  try {
    return await task(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function attemptInfo(job: Job) {
  return {
    attempt: job.attemptsMade + 1,
    maxAttempts: job.opts.attempts ?? 1,
  };
}

async function processJob(job: Job<CommandJobData, CommandJobResult>): Promise<CommandJobResult> {
  const { jobId, command } = validateJobData(job.data);
  const jobLogger = logger.child({ jobId, bullJobId: job.id, jobName: job.name });
  const startedAt = Date.now();

  jobLogger.info("Job started", { ...attemptInfo(job), command });
  await job.log(`Attempt ${attemptInfo(job).attempt} started`);

  const output = await runWithTimeout(config.worker.jobTimeoutMs, (signal) =>
    executeCommand(command, signal),
  );

  jobLogger.info("Job execution finished", { durationMs: Date.now() - startedAt });
  await job.log(`Attempt ${attemptInfo(job).attempt} finished`);

  return { jobId, output };
}

const worker = new Worker<CommandJobData, CommandJobResult>(config.queue.name, processJob, {
  connection,
  concurrency: config.worker.concurrency,
});

worker.on("ready", () => {
  logger.info("Worker ready", {
    concurrency: config.worker.concurrency,
    jobTimeoutMs: config.worker.jobTimeoutMs,
  });
});

worker.on("completed", (job, result) => {
  logger.info("Job completed", {
    jobId: job.data.jobId,
    bullJobId: job.id,
    attemptsMade: job.attemptsMade,
    durationMs: job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined,
    output: result.output,
  });
});

worker.on("failed", (job, error) => {
  if (!job) {
    logger.error("Job failed (job no longer available)", { error });
    return;
  }
  const maxAttempts = job.opts.attempts ?? 1;
  const willRetry = !(error instanceof UnrecoverableError) && job.attemptsMade < maxAttempts;
  const fields = {
    jobId: job.data?.jobId,
    bullJobId: job.id,
    attemptsMade: job.attemptsMade,
    maxAttempts,
    error: serializeError(error),
  };
  if (willRetry) {
    logger.warn("Job attempt failed, will retry", fields);
  } else {
    logger.error("Job failed permanently", fields);
  }
});

worker.on("stalled", (jobId) => {
  logger.warn("Job stalled and was moved back to wait", { bullJobId: jobId });
});

worker.on("lockRenewalFailed", (jobIds) => {
  logger.warn("Job lock renewal failed", { bullJobIds: jobIds });
});

worker.on("error", (error) => {
  logger.error("Worker error", { error });
});

let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("Worker shutting down", { reason, timeoutMs: config.worker.shutdownTimeoutMs });

  const forceExit = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit");
    process.exit(1);
  }, config.worker.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await worker.close();
    await connection.quit();
    logger.info("Worker stopped");
  } catch (error) {
    logger.error("Error during shutdown", { error });
    exitCode = 1;
  } finally {
    clearTimeout(forceExit);
    process.exit(exitCode);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM", 0));
process.on("SIGINT", () => void shutdown("SIGINT", 0));
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { error: serializeError(reason) });
});
process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", { error });
  void shutdown("uncaughtException", 1);
});
