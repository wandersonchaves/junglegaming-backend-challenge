import { SqlEntityManager } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { IntegrationEvent } from '../../../application/events/integration-event';
import { OutboxRepository } from '../../../application/ports/repositories';

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) { }

  async add(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void> {
    for (const event of events) {
      const message = OutboxMessage.enqueue(event);
      await this.em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         values (?, ?, ?, ?::jsonb, ?, ?)`,
        [
          message.id,
          message.aggregateId,
          message.eventType,
          JSON.stringify(message.payload),
          message.occurredAt,
          message.nextAttemptAt ?? message.occurredAt,
        ],
        'run',
      );
    }
  }
}
