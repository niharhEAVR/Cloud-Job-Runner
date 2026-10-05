import express from "express";
import { randomUUID } from "crypto";
import { jobQueue } from "./queue.js";

const app = express();

app.use(express.json());

app.post("/jobs", async (req, res) => {
  const { command } = req.body ?? {};

  if (!command || typeof command !== "string") {
    res.status(400).json({ error: "command is required" });
    return;
  }

  const jobId = randomUUID();

  await jobQueue.add("execute-command", { jobId, command });

  res.status(202).json({ jobId, status: "queued" });
});

app.get("/", (_req, res) => {
  res.json({
    service: "cloud-job-runner",
    status: "running",
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});