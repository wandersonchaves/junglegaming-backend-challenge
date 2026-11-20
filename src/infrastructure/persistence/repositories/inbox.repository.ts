import { SqlEntityManager } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { InboxRepository } from '../../../application/ports/repositories';

export class PgInboxRepository implements InboxRepository {
  constructor(private readonly em: SqlEntityManager) { }

  /**
   * The primary key (consumer_name, message_id) decides. If a concurrent transaction is inserting
   * the same message, this statement waits for it to commit or roll back, then answers.
   */
  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await this.em.execute<{ message_id: string }[]>(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning message_id`,
      [message.consumerName, message.messageId, message.payloadHash, message.receivedAt],
    );
    return rows.length === 1;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [message.processedAt ?? null, message.consumerName, message.messageId],
      'run',
    );
  }
}
