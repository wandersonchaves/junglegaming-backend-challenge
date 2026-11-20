import { beforeEach, describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { MessagePublisher } from '../ports/outbox-publishing';
import { FixedClock, InMemoryOutboxStore } from '../testing/in-memory';
import { PublishOutbox } from './publish-outbox.use-case';

const clock = new FixedClock(new Date('2026-11-20T10:00:00.000Z'));

const event = (id: string) => ({
  eventId: id,
  aggregateId: 'wallet-1',
  eventType: 'WalletBalanceChanged',
  occurredAt: new Date('2026-11-20T09:59:00.000Z'),
  toJSON: () => ({ eventId: id }),
});

class RecordingPublisher implements MessagePublisher {
  readonly published: string[] = [];
  failFor = new Set<string>();
  async publish(message: OutboxMessage): Promise<void> {
    if (this.failFor.has(message.id)) throw new Error('broker down');
    this.published.push(message.id);
  }
}

describe('PublishOutbox', () => {
  let store: InMemoryOutboxStore;
  let publisher: RecordingPublisher;
  let useCase: PublishOutbox;

  beforeEach(() => {
    store = new InMemoryOutboxStore();
    publisher = new RecordingPublisher();
    useCase = new PublishOutbox(store, publisher, clock, 10);
    for (const id of ['e1', 'e2', 'e3']) store.messages.push(OutboxMessage.enqueue(event(id)));
  });

  test('publishes every due message and marks it published', async () => {
    const result = await useCase.execute();

    expect(result).toEqual({ published: 3, failed: 0 });
    expect(publisher.published).toEqual(['e1', 'e2', 'e3']);
    expect(store.messages.every((m) => !m.isPending())).toBe(true);
  });

  test('a message already published is not published again', async () => {
    await useCase.execute();
    const second = await useCase.execute();

    expect(second).toEqual({ published: 0, failed: 0 });
    expect(publisher.published).toHaveLength(3);
  });

  test('a failure schedules a retry with backoff and does not stop the batch', async () => {
    publisher.failFor.add('e2');

    const result = await useCase.execute();

    expect(result).toEqual({ published: 2, failed: 1 });
    const failed = store.messages.find((m) => m.id === 'e2');
    expect(failed?.isPending()).toBe(true);
    expect(failed?.attempts).toBe(1);
    expect(failed?.isDue(clock.now())).toBe(false);
  });

  test('a message that failed is published once the broker is back and its delay passed', async () => {
    publisher.failFor.add('e2');
    await useCase.execute();
    publisher.failFor.clear();

    const later = new PublishOutbox(store, publisher, new FixedClock(new Date('2026-11-20T10:00:05.000Z')));
    const result = await later.execute();

    expect(result.published).toBe(1);
    expect(publisher.published).toContain('e2');
  });

  test('two publishers running at once never publish the same message twice', async () => {
    const other = new PublishOutbox(store, publisher, clock, 10);

    await Promise.all([useCase.execute(), other.execute()]);

    expect(publisher.published.sort()).toEqual(['e1', 'e2', 'e3']);
  });

  test('respects the batch size', async () => {
    const small = new PublishOutbox(store, publisher, clock, 2);

    const result = await small.execute();

    expect(result.published).toBe(2);
  });
});
