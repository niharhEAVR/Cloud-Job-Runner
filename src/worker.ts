import { Worker } from "bullmq";
import { Redis } from "ioredis";

const connection = new Redis({
    host: process.env.REDIS_HOST || "localhost",
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null,
});

const worker = new Worker(
    "jobs",
    async (job) => {
        console.log("Received job:", job.data);

        const { jobId, command } = job.data;

        console.log(`Executing job ${jobId}`);
        console.log(`Command: ${command}`);

        // Temporary implementation.
        // We will later replace this with
        // isolated Docker execution.

        await new Promise((resolve) => {
            setTimeout(resolve, 2000);
        });

        console.log(`Job ${jobId} completed`);

        return {
            jobId,
            output: `Simulated execution of: ${command}`,
        };
    },
    {
        connection,
    }
);

worker.on("completed", (job) => {
    console.log(`Job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
    console.error(`Job ${job?.id} failed:`, error);
});