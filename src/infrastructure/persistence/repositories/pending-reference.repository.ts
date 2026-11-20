import { SqlEntityManager } from '@mikro-orm/postgresql';
import {
  LockedPendingReference,
  PendingReferenceItem,
  PendingReferenceRepository,
} from '../../../application/ports/repositories';
import { toTransaction } from './wager-transaction.repository';

export class PgPendingReferenceRepository implements PendingReferenceRepository {
  constructor(private readonly em: SqlEntityManager) { }

  async findDue(limit: number, now: Date): Promise<PendingReferenceItem[]> {
    const rows = await this.em.execute<{ id: string; wallet_id: string; reference_attempts: number }[]>(
      `select id, wallet_id, reference_attempts from wager_transactions
        where status = 'PENDING_REFERENCE' and reference_next_attempt_at <= ?
        order by reference_next_attempt_at, id
        limit ?`,
      [now, limit],
    );
    return rows.map((r) => ({
      transactionId: r.id,
      walletId: r.wallet_id,
      attempts: r.reference_attempts,
    }));
  }

  /** SKIP LOCKED: two workers never pick up the same reversal at the same time. */
  async lock(transactionId: string): Promise<LockedPendingReference | null> {
    const rows = await this.em.execute<Parameters<typeof toTransaction>[0][] & { reference_attempts: number }[]>(
      `select * from wager_transactions
        where id = ? and status = 'PENDING_REFERENCE'
        for update skip locked`,
      [transactionId],
    );
    const row = rows[0] as (Parameters<typeof toTransaction>[0] & { reference_attempts: number }) | undefined;
    return row ? { transaction: toTransaction(row), attempts: row.reference_attempts } : null;
  }

  async recordAttempt(transactionId: string, attempts: number, nextAttemptAt: Date): Promise<void> {
    await this.em.execute(
      `update wager_transactions set reference_attempts = ?, reference_next_attempt_at = ? where id = ?`,
      [attempts, nextAttemptAt, transactionId],
      'run',
    );
  }
}
