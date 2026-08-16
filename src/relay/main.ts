import { startRelay, stopRelay } from './index';
import { logger } from '../shared/logger';
import prisma from '../shared/prisma';
import { closeAllProviders } from '../shared/providers';

async function main() {
  logger.info('Starting Relay Service process...');
  startRelay();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down Relay Service...');
    stopRelay();
    await prisma.$disconnect();
    await closeAllProviders();
    logger.info('Relay Service shutdown complete.');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main();
}
