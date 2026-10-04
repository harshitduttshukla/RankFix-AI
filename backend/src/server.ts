import { createApp } from './app.js';
import { prisma } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const server = createApp().listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));

async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
