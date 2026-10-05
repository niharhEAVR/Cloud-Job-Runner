import { Queue } from "bullmq";
import { Redis } from "ioredis";

const connection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

export const jobQueue = new Queue("jobs", {
  connection,
});