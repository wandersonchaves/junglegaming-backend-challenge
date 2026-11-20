import { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { OutboxBatchStore, OutboxBatchWork } from '../../application/ports/outbox-publishing';
import { mapDatabaseError } from './database-errors';
import { asDate, asOptionalDate } from './row-mapping';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
}

const toMessage = (row: OutboxRow): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    occurredAt: asDate(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: asOptionalDate(row.next_attempt_at),
    publishedAt: asOptionalDate(row.published_at),
  });

export class PgOutboxBatchStore implements OutboxBatchStore {
  constructor(private readonly orm: MikroORM) { }

  async claim<T>(limit: number, now: Date, work: OutboxBatchWork<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const sql = em as SqlEntityManager;
        // SKIP LOCKED: a publisher takes only the rows no other publisher holds right now.
        const rows = await sql.execute<OutboxRow[]>(
          `select * from outbox_messages
            where published_at is null and next_attempt_at <= ?
            order by next_attempt_at, occurred_at
            limit ?
            for update skip locked`,
          [now, limit],
        );
        return work(rows.map(toMessage), async (message) => {
          await sql.execute(
            `update outbox_messages set attempts = ?, next_attempt_at = ?, published_at = ? where id = ?`,
            [message.attempts, message.nextAttemptAt ?? null, message.publishedAt ?? null, message.id],
            'run',
          );
        });
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async lagSeconds(now: Date): Promise<number> {
    const [row] = await this.orm.em.fork().execute<{ lag: string | null }[]>(
      `select extract(epoch from (?::timestamptz - min(occurred_at)))::text as lag
         from outbox_messages where published_at is null`,
      [now],
    );
    return row?.lag ? Math.max(0, Number(row.lag)) : 0;
  }
}
