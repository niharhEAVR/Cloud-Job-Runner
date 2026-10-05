import express from "express";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { jobQueue } from "./queue.js";

const logger = createLogger({ service: "api" });
const app = express();

app.use(express.json());

app.post("/jobs", async (req, res) => {
  const { command } = req.body ?? {};

  if (!command || typeof command !== "string") {
    res.status(400).json({ error: "command is required" });
    return;
  }

  const jobId = randomUUID();

  await jobQueue.add("execute-command", { jobId, command }, { jobId });

  logger.info("Job enqueued", { jobId, queue: config.queue.name });

  res.status(202).json({ jobId, status: "queued" });
});

app.get("/", (_req, res) => {
  res.json({
    service: "cloud-job-runner",
    status: "running",
  });
});

app.listen(config.port, () => {
  logger.info("API listening", { port: config.port });
});
