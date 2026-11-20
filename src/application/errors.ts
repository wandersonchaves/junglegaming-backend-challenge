import { DomainError } from '../domain/errors/domain.error';

export class WalletNotFoundError extends DomainError {
  readonly code = 'WALLET_NOT_FOUND';
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = 'WALLET_ALREADY_EXISTS';
}

export class WalletPlayerMismatchError extends DomainError {
  readonly code = 'WALLET_PLAYER_MISMATCH';
}

/** Same idempotency key with a different payload, or same external id under another key. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

export class InvalidCursorError extends DomainError {
  readonly code = 'INVALID_CURSOR';
}

export class TransactionNotFoundError extends DomainError {
  readonly code = 'TRANSACTION_NOT_FOUND';
}

/** Raised by the persistence adapters when a unique constraint rejects an insert. */
export class UniqueViolationError extends Error {
  constructor(public readonly constraint: string | undefined) {
    super(`unique constraint violated${constraint ? `: ${constraint}` : ''}`);
    this.name = 'UniqueViolationError';
  }
}

/** The wallet row changed between the read and the write (version check failed). */
export class ConcurrentModificationError extends Error {
  constructor(walletId: string) {
    super(`wallet ${walletId} was modified concurrently`);
    this.name = 'ConcurrentModificationError';
  }
}

/** Database or broker unavailable. The caller may retry. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}
