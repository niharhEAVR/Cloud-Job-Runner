import { Redis } from "ioredis";
import { config } from "./config.js";
import type { Logger } from "./logger.js";

export function createRedisConnection(logger: Logger): Redis {
  const connection = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    ...(config.redis.password ? { password: config.redis.password } : {}),
    maxRetriesPerRequest: null,
  });

  connection.on("ready", () => {
    logger.info("Redis connection ready", {
      redisHost: config.redis.host,
      redisPort: config.redis.port,
    });
  });
  connection.on("error", (error) => {
    logger.error("Redis connection error", { error });
  });
  connection.on("reconnecting", (delayMs: number) => {
    logger.warn("Redis reconnecting", { delayMs });
  });

  return connection;
}
