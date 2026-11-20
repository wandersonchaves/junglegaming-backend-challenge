import { describe, expect, test } from 'bun:test';
import { InboxMessage } from './inbox-message';

const at = new Date('2026-11-20T10:00:00.000Z');
const props = { consumerName: 'wager-consumer', messageId: 'msg-1', payloadHash: 'a'.repeat(64), receivedAt: at };

describe('InboxMessage', () => {
  test('is received without a processed date', () => {
    const message = InboxMessage.receive(props);

    expect(message.messageId).toBe('msg-1');
    expect(message.consumerName).toBe('wager-consumer');
    expect(message.receivedAt).toEqual(at);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  test('markProcessed records the date', () => {
    const message = InboxMessage.receive(props);
    const done = new Date('2026-11-20T10:00:01.000Z');

    message.markProcessed(done);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(done);
  });

  test('a message cannot be marked as processed twice', () => {
    const message = InboxMessage.receive(props);
    message.markProcessed(at);

    expect(() => message.markProcessed(at)).toThrow();
  });

  test('rehydrate restores a processed message as is', () => {
    const message = InboxMessage.rehydrate({ ...props, processedAt: at });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(at);
  });
});
