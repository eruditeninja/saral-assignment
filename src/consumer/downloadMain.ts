import { startDownloadConsumer, stopDownloadConsumer } from './downloadConsumer';
import { logger } from '../shared/logger';
import prisma from '../shared/prisma';
import { closeAllProviders } from '../shared/providers';

async function main() {
  logger.info('Starting Download Consumer service...');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Download Consumer...');
    stopDownloadConsumer();
    await prisma.$disconnect();
    await closeAllProviders();
    logger.info('Download Consumer shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await startDownloadConsumer();
}

if (require.main === module) {
  main();
}
