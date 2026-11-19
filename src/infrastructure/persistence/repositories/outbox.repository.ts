import { SqlEntityManager } from '@mikro-orm/postgresql';
import { IntegrationEvent } from '../../../application/events/integration-event';
import { OutboxRepository } from '../../../application/ports/repositories';

export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly em: SqlEntityManager) { }

  async add(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void> {
    for (const event of events) {
      await this.em.execute(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
         values (?, ?, ?, ?::jsonb, ?)`,
        [
          event.eventId,
          event.aggregateId,
          event.eventType,
          JSON.stringify(event.toJSON()),
          event.occurredAt,
        ],
        'run',
      );
    }
  }
}
