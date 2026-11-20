import { CurrencyMismatchError, DomainError, InvalidMoneyError } from '../../domain/errors/domain.error';
import { InvalidTransactionError } from '../../domain/wager/wager.errors';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../errors';

/** The queue message is not a valid WagerTransactionRequested. Retrying cannot fix it. */
export class InvalidMessageError extends DomainError {
  readonly code = 'INVALID_MESSAGE';
}

export type ErrorKind = 'permanent' | 'transient';

/**
 * Business outcomes (PROCESSED, REJECTED, PENDING_REFERENCE) are not errors: the consumer acks them.
 * An error is permanent when the same message would fail the same way every time, so it goes
 * to the dead-letter queue. Anything else (database down, lock timeout, bug) is transient: the
 * message returns to the queue with a delay and the SQS redrive policy caps the attempts.
 */
export function classifyError(error: unknown): ErrorKind {
  if (
    error instanceof InvalidMessageError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidTransactionError ||
    error instanceof WalletNotFoundError ||
    error instanceof WalletPlayerMismatchError ||
    error instanceof CurrencyMismatchError ||
    error instanceof IdempotencyConflictError
  ) {
    return 'permanent';
  }
  return 'transient';
}

export function failureReason(error: unknown): string {
  return error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'UNKNOWN';
}
