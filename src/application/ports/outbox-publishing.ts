import { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface MessagePublisher {
  /** Throws when the broker did not accept the message. */
  publish(message: OutboxMessage): Promise<void>;
}

export interface OutboxBatchWork<T> {
  (messages: OutboxMessage[], save: (message: OutboxMessage) => Promise<void>): Promise<T>;
}

export interface OutboxBatchStore {
  /**
   * Locks up to `limit` due messages, skipping the ones another publisher already holds,
   * runs the work and commits. Locks last until the work is done.
   */
  claim<T>(limit: number, now: Date, work: OutboxBatchWork<T>): Promise<T>;
  /** Age in seconds of the oldest message not published yet, or 0. */
  lagSeconds(now: Date): Promise<number>;
}
