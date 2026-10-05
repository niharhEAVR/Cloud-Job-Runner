import { Queue } from "bullmq";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { createRedisConnection } from "./redis.js";

export interface CommandJobData {
  jobId: string;
  command: string;
}

export interface CommandJobResult {
  jobId: string;
  output: string;
}

const connection = createRedisConnection(createLogger({ service: "api", component: "queue" }));

export const jobQueue = new Queue<CommandJobData, CommandJobResult>(config.queue.name, {
  connection,
  defaultJobOptions: {
    attempts: config.jobs.attempts,
    backoff: {
      type: config.jobs.backoffType,
      delay: config.jobs.backoffDelayMs,
    },
    removeOnComplete: { count: config.jobs.removeOnCompleteCount },
    removeOnFail: { count: config.jobs.removeOnFailCount },
  },
});
