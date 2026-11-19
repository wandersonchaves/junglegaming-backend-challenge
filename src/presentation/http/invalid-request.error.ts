import { DomainError } from '../../domain/errors/domain.error';

/** The request is malformed: missing header, wrong field type, unknown kind. */
export class InvalidRequestError extends DomainError {
  readonly code = 'INVALID_REQUEST';
}
