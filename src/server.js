// ==================================================================
// Server bootstrap + graceful shutdown.
// ==================================================================
import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { disconnectPrisma, pingDatabase } from './shared/prisma.js';
import { applicationPdfService } from './modules/esign/services/applicationPdf.service.js';

async function start() {
  try {
    await pingDatabase();
    logger.info('Database connected');
  } catch (err) {
    logger.error({ err }, 'Failed to connect to database, exiting');
    process.exit(1);
  }

  return app.listen(env.PORT, () => {
    logger.info(`IPRS backend running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  });
}

const server = await start();

// --- Graceful shutdown ---
async function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close(async () => {
    await applicationPdfService.closeBrowser();
    await disconnectPrisma();
    logger.info('Server closed, process exiting.');
    process.exit(0);
  });

  // Force-exit if connections refuse to close
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Fail-fast on unhandled errors ---
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception, exiting');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection, exiting');
  process.exit(1);
});
