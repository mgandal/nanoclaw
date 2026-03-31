import pino from 'pino';
import PinoPretty from 'pino-pretty';

export const logger = pino(
  { level: process.env.LOG_LEVEL || 'info' },
  PinoPretty({ colorize: true }),
);

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
