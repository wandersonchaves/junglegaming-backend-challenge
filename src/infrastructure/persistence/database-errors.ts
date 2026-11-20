import { TransientInfrastructureError, UniqueViolationError } from '../../application/errors';
import { metrics } from '../observability/metrics';

const UNIQUE_VIOLATION = '23505';
// 40001 serialization_failure, 40P01 deadlock_detected, 57P01 admin_shutdown, 08xxx connection exceptions
const TRANSIENT_CODES = new Set(['40001', '40P01', '57P01', '57P03', '53300']);
const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

interface DriverError {
  code?: string;
  constraint?: string;
  cause?: unknown;
}

/** Turns driver errors into the technical errors the application layer understands. */
export function mapDatabaseError(error: unknown): unknown {
  const driver = findDriverError(error);
  if (!driver) return error;

  if (driver.code === UNIQUE_VIOLATION) {
    metrics.uniqueViolations.inc({ constraint: driver.constraint ?? 'unknown' });
    return new UniqueViolationError(driver.constraint);
  }
  if (
    driver.code &&
    (TRANSIENT_CODES.has(driver.code) ||
      driver.code.startsWith('08') ||
      TRANSIENT_NODE_CODES.has(driver.code))
  ) {
    return new TransientInfrastructureError('database temporarily unavailable', { cause: error });
  }
  return error;
}

function findDriverError(error: unknown): DriverError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as DriverError;
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return undefined;
}
