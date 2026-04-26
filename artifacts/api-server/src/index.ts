import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot";

// PORT is optional. On bot-only hosts (bothost.ru, single-process VPS, etc.)
// the bot can run in pure long-polling mode without a public HTTP port.
// On hosts that DO provide PORT (Render, Railway, Fly.io, Heroku, …) we
// still start the Express server so health checks and the webhook
// dispatcher work as before.
const rawPort = process.env["PORT"];

if (rawPort) {
  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
} else {
  logger.info(
    "PORT not set — running in bot-only mode (no HTTP server). " +
      "Set PORT to enable the Express health check and webhook dispatcher.",
  );
}

startBot().catch((err) => {
  logger.error({ err }, "Failed to start Telegram bot");
  process.exit(1);
});
