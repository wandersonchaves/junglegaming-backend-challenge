import { describe, expect, test } from 'bun:test';
import { OutboxMessage, backoffDelayMs } from './outbox-message';

const occurredAt = new Date('2026-11-20T10:00:00.000Z');
const event = {
  eventId: '0192f298-345e-7e38-af88-e43f851a819d',
  aggregateId: 'wallet-1',
  eventType: 'WalletBalanceChanged',
  occurredAt,
  toJSON: () => ({ eventId: '0192f298-345e-7e38-af88-e43f851a819d', data: { walletId: 'wallet-1' } }),
};

describe('OutboxMessage.enqueue', () => {
  test('is pending, has no attempts and is due right away', () => {
    const message = OutboxMessage.enqueue(event);

    expect(message.id).toBe(event.eventId);
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.attempts).toBe(0);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(occurredAt)).toBe(true);
  });

  test('stores a serialized copy of the envelope as the payload', () => {
    const message = OutboxMessage.enqueue(event);

    expect(message.payload).toEqual({ eventId: event.eventId, data: { walletId: 'wallet-1' } });
  });
});

describe('OutboxMessage publication', () => {
  test('markPublished makes it not pending and never due again', () => {
    const message = OutboxMessage.enqueue(event);
    const at = new Date('2026-11-20T10:00:05.000Z');

    message.markPublished(at);

    expect(message.isPending()).toBe(false);
    expect(message.publishedAt).toEqual(at);
    expect(message.isDue(new Date('2027-01-01T00:00:00.000Z'))).toBe(false);
  });

  test('scheduleRetry counts the attempt and delays the next one', () => {
    const message = OutboxMessage.enqueue(event);
    const now = new Date('2026-11-20T10:00:01.000Z');

    message.scheduleRetry(now);

    expect(message.attempts).toBe(1);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 1_000));
    expect(message.isDue(now)).toBe(false);
    expect(message.isDue(new Date(now.getTime() + 1_000))).toBe(true);
  });

  test('the backoff doubles on every attempt and is capped', () => {
    expect(backoffDelayMs(1)).toBe(1_000);
    expect(backoffDelayMs(2)).toBe(2_000);
    expect(backoffDelayMs(3)).toBe(4_000);
    expect(backoffDelayMs(4)).toBe(8_000);
    expect(backoffDelayMs(30)).toBe(5 * 60_000);
  });

  test('a retry after a retry pushes the schedule further', () => {
    const message = OutboxMessage.enqueue(event);
    const now = new Date('2026-11-20T10:00:00.000Z');

    message.scheduleRetry(now);
    message.scheduleRetry(now);

    expect(message.attempts).toBe(2);
    expect(message.nextAttemptAt).toEqual(new Date(now.getTime() + 2_000));
  });

  test('rehydrate restores attempts and dates without validating', () => {
    const message = OutboxMessage.rehydrate({
      id: 'x',
      aggregateId: 'a',
      eventType: 'T',
      payload: { k: 1 },
      occurredAt,
      attempts: 3,
      nextAttemptAt: occurredAt,
    });

    expect(message.attempts).toBe(3);
    expect(message.isPending()).toBe(true);
    expect(message.nextAttemptAt).toEqual(occurredAt);
  });
});
