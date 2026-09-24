import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: { svc: 'live-ai' },
    redact: {
      paths: ['password', '*.password', 'apiKey', '*.apiKey', 'token', '*.token', 'authorization', '*.authorization', 'headers.authorization'],
      censor: '***',
    },
  });
}
