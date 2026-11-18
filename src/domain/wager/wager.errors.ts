import { DomainError } from '../errors/domain.error';

export class InvalidTransactionError extends DomainError {
  readonly code = 'INVALID_TRANSACTION';
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}
