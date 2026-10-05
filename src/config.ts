const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const BACKOFF_TYPES = ["fixed", "exponential"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type BackoffType = (typeof BACKOFF_TYPES)[number];

function readString(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function readOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

function readEnum<T extends string>(
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, got "${raw}"`);
  }
  return raw as T;
}

export const config = {
  port: readInt("PORT", 3000, 1),
  logLevel: readEnum<LogLevel>("LOG_LEVEL", LOG_LEVELS, "info"),
  redis: {
    host: readString("REDIS_HOST", "localhost"),
    port: readInt("REDIS_PORT", 6379, 1),
    password: readOptionalString("REDIS_PASSWORD"),
  },
  queue: {
    name: readString("QUEUE_NAME", "jobs"),
  },
  jobs: {
    attempts: readInt("JOB_ATTEMPTS", 3, 1),
    backoffType: readEnum<BackoffType>("JOB_BACKOFF_TYPE", BACKOFF_TYPES, "exponential"),
    backoffDelayMs: readInt("JOB_BACKOFF_DELAY_MS", 1000),
    removeOnCompleteCount: readInt("JOB_KEEP_COMPLETED", 1000),
    removeOnFailCount: readInt("JOB_KEEP_FAILED", 5000),
  },
  worker: {
    concurrency: readInt("WORKER_CONCURRENCY", 1, 1),
    jobTimeoutMs: readInt("JOB_TIMEOUT_MS", 30000, 1),
    simulatedJobDurationMs: readInt("SIMULATED_JOB_DURATION_MS", 2000),
    shutdownTimeoutMs: readInt("WORKER_SHUTDOWN_TIMEOUT_MS", 25000, 1),
  },
} as const;
