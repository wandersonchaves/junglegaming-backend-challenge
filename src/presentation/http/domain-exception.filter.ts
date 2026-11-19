import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { CurrencyMismatchError, DomainError, InvalidMoneyError } from '../../domain/errors/domain.error';
import { InvalidTransactionError } from '../../domain/wager/wager.errors';
import {
  IdempotencyConflictError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../application/errors';
import { InvalidRequestError } from './invalid-request.error';

/**
 * One mapping for every endpoint, so a provider can decide what to do from the status alone:
 *  400 fix the payload · 404 unknown resource · 409 conflict, do not resend as is
 *  422 business rule said no · 503 transient, retry later (same Idempotency-Key)
 * Accepted-but-pending (202) and processed (200/201) answers come from the controllers.
 */
export function statusFor(error: unknown): number {
  if (
    error instanceof InvalidRequestError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidTransactionError
  ) {
    return 400;
  }
  if (error instanceof WalletNotFoundError || error instanceof TransactionNotFoundError) return 404;
  if (error instanceof WalletAlreadyExistsError || error instanceof IdempotencyConflictError) return 409;
  if (error instanceof CurrencyMismatchError || error instanceof WalletPlayerMismatchError) return 422;
  if (error instanceof TransientInfrastructureError) return 503;
  return 500;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (error instanceof HttpException) {
      response.status(error.getStatus()).json(error.getResponse());
      return;
    }

    const status = statusFor(error);
    if (status === 503) response.setHeader('Retry-After', '1');
    if (status >= 500) {
      this.logger.error(JSON.stringify({ message: 'request failed', error: String(error) }));
    }

    if (error instanceof DomainError) {
      response.status(status).json({ code: error.code, message: error.message });
    } else if (status === 503) {
      response.status(503).json({ code: 'SERVICE_UNAVAILABLE', message: 'try again shortly' });
    } else {
      response.status(500).json({ code: 'INTERNAL_ERROR', message: 'unexpected error' });
    }
  }
}
