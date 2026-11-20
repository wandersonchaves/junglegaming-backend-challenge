import { Clock } from '../ports/clock-and-ids';
import { MessagePublisher, OutboxBatchStore } from '../ports/outbox-publishing';

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

/**
 * Publishes pending outbox messages. Several publishers can run at once: each one only sees the
 * messages it managed to lock, so the same message is not handed to two publishers.
 * Delivery is at-least-once (a crash between publish and commit sends the message again),
 * which is why every event carries a stable eventId for consumers to deduplicate.
 */
export class PublishOutbox {
  constructor(
    private readonly store: OutboxBatchStore,
    private readonly publisher: MessagePublisher,
    private readonly clock: Clock,
    private readonly batchSize = 50,
  ) { }

  execute(): Promise<PublishOutboxResult> {
    return this.store.claim(this.batchSize, this.clock.now(), async (messages, save) => {
      const result: PublishOutboxResult = { published: 0, failed: 0 };
      for (const message of messages) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          result.published += 1;
        } catch {
          message.scheduleRetry(this.clock.now());
          result.failed += 1;
        }
        await save(message);
      }
      return result;
    });
  }
}
