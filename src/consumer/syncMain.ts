import { startSyncConsumer, stopSyncConsumer } from './syncConsumer';
import { logger } from '../shared/logger';
import prisma from '../shared/prisma';
import { closeAllProviders } from '../shared/providers';

async function main() {
  logger.info('Starting Sync Job Consumer service...');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Sync Job Consumer...');
    stopSyncConsumer();
    await prisma.$disconnect();
    await closeAllProviders();
    logger.info('Sync Job Consumer shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await startSyncConsumer();
}

if (require.main === module) {
  main();
}
