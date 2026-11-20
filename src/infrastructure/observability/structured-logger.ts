import { LoggerService } from '@nestjs/common';

export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * One JSON object per line. Log ids and codes, never amounts or whole payloads:
 * the fields above are the ones the README asks for.
 */
export class StructuredLogger {
  constructor(private readonly context: string) { }

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: Level, message: string, fields: LogFields): void {
    if (process.env.LOG_LEVEL === 'silent') return;
    process.stdout.write(
      `${JSON.stringify({ time: new Date().toISOString(), level, context: this.context, message, ...fields })}\n`,
    );
  }
}

/** Routes Nest's own logs through the same JSON format. */
export class JsonNestLogger implements LoggerService {
  private readonly logger = new StructuredLogger('nest');

  log(message: unknown, ...rest: unknown[]): void {
    this.logger.info(String(message), { nestContext: lastString(rest) });
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.logger.error(String(message), { nestContext: lastString(rest) });
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.logger.warn(String(message), { nestContext: lastString(rest) });
  }
}

function lastString(values: unknown[]): string | undefined {
  const last = values[values.length - 1];
  return typeof last === 'string' ? last : undefined;
}
