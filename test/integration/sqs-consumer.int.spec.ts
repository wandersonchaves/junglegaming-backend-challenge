import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { DeleteMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ProcessWagerMessage } from '../../src/application/process-wager-message/process-wager-message.use-case';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction/submit-wager-transaction.use-case';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-wager-consumer';
import { RandomUuidGenerator, SystemClock } from '../../src/infrastructure/system/system-clock';
import { connect } from '../support/db';
import { createQueues, wagerMessage } from '../support/sqs';

let db: Awaited<ReturnType<typeof connect>>;
let sqs: Awaited<ReturnType<typeof createQueues>>;
let process_: ProcessWagerMessage;

beforeAll(async () => {
  db = await connect();
  sqs = await createQueues();
  process_ = new ProcessWagerMessage(new SubmitWagerTransaction(db.uow, new SystemClock(), new RandomUuidGenerator()));
});

afterAll(async () => {
  await db.orm.close();
});

const consumer = (overrides: { client?: SQSClient; process?: ProcessWagerMessage; maxAttempts?: number } = {}) =>
  new SqsWagerConsumer(
    overrides.client ?? sqs.client,
    {
      queueUrl: sqs.queueUrl,
      dlqUrl: sqs.dlqUrl,
      waitTimeSeconds: 0,
      maxAttempts: overrides.maxAttempts ?? 5,
      backoffSeconds: () => 1,
    },
    overrides.process ?? process_,
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until the queue stays empty for a few rounds in a row (FIFO hands out one group at a time). */
async function drain(c: SqsWagerConsumer, quietRounds = 4): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 100 && quiet < quietRounds; i += 1) {
    quiet = (await c.pollOnce()) === 0 ? quiet + 1 : 0;
    if (quiet > 0) await sleep(150);
  }
}

describe('SQS consumer', () => {
  test('processes a message, writes the inbox and acks it', async () => {
    const wallet = await db.openWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    await sqs.send(
      sqs.queueUrl,
      wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}` }),
      wallet.walletId,
    );

    await drain(consumer());

    expect((await db.balances(wallet.walletId)).stored).toBe(75);
    expect(
      await db.count(
        `select count(*) as n from inbox_messages where message_id = ? and processed_at is not null`,
        [messageId],
      ),
    ).toBe(1);
    expect(await sqs.peek(sqs.queueUrl)).toHaveLength(0);
    expect(await sqs.peek(sqs.dlqUrl)).toHaveLength(0);
  });

  test('the same message sent twice has the effect of one', async () => {
    const wallet = await db.openWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    const body = wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}` });
    await sqs.send(sqs.queueUrl, body, wallet.walletId);
    await sqs.send(sqs.queueUrl, body, wallet.walletId); // different SQS deduplication id, same messageId

    await drain(consumer());

    const { stored, rebuilt, entries } = await db.balances(wallet.walletId);
    expect(stored).toBe(75);
    expect(rebuilt).toBe(75);
    expect(entries).toBe(2);
  });

  test('a worker that dies after the commit and before the ack: redelivery has no extra effect', async () => {
    const wallet = await db.openWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    await sqs.send(
      sqs.queueUrl,
      wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}` }),
      wallet.walletId,
    );

    // Same client, except the first delete never reaches SQS: the "crash before the ack".
    let lostDeletes = 1;
    const flaky = new Proxy(sqs.client, {
      get(target, property, receiver) {
        if (property !== 'send') return Reflect.get(target, property, receiver);
        return (command: unknown, ...rest: unknown[]) => {
          if (command instanceof DeleteMessageCommand && lostDeletes > 0) {
            lostDeletes -= 1;
            return Promise.reject(new Error('process died before the ack'));
          }
          return (target.send as (...args: unknown[]) => unknown)(command, ...rest);
        };
      },
    }) as SQSClient;

    await consumer({ client: flaky }).pollOnce();
    expect((await db.balances(wallet.walletId)).stored).toBe(75); // the commit happened
    await sleep(2_500); // the visibility timeout passes, the message returns
    await drain(consumer());

    const { stored, rebuilt, entries } = await db.balances(wallet.walletId);
    expect(stored).toBe(75);
    expect(rebuilt).toBe(75);
    expect(entries).toBe(2);
    expect(await sqs.peek(sqs.queueUrl)).toHaveLength(0);
  });

  test('a business rejection is acked, not retried and not dead-lettered', async () => {
    const wallet = await db.openWallet('10.00');
    const messageId = `msg-${randomUUID()}`;
    await sqs.send(
      sqs.queueUrl,
      wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}`, amount: '500.00' }),
      wallet.walletId,
    );

    await drain(consumer());

    expect(
      await db.count(
        `select count(*) as n from wager_transactions where wallet_id = ? and status = 'REJECTED'`,
        [wallet.walletId],
      ),
    ).toBe(1);
    expect(await sqs.peek(sqs.queueUrl)).toHaveLength(0);
  });

  test('a poison message goes straight to the dead-letter queue with its reason', async () => {
    const group = `poison-${randomUUID()}`;
    await sqs.send(sqs.queueUrl, '{this is not json', group);

    await drain(consumer());

    const parked = (await sqs.peek(sqs.dlqUrl)).filter((m) => m.Attributes?.MessageGroupId === group);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.MessageAttributes?.failureReason?.StringValue).toBe('INVALID_MESSAGE');
    expect(
      (await sqs.peek(sqs.queueUrl)).filter((m) => m.Attributes?.MessageGroupId === group),
    ).toHaveLength(0);
  });

  test('a transient failure is retried and parked in the DLQ when the attempts run out', async () => {
    const wallet = await db.openWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    let attempts = 0;
    const failing = {
      execute: async () => {
        attempts += 1;
        throw new Error('database unavailable');
      },
    } as unknown as ProcessWagerMessage;
    await sqs.send(
      sqs.queueUrl,
      wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}` }),
      wallet.walletId,
    );
    const c = consumer({ process: failing, maxAttempts: 3 });

    for (let i = 0; i < 12 && attempts < 3; i += 1) {
      await c.pollOnce();
      if (attempts < 3) await sleep(1_000);
    }

    expect(attempts).toBe(3);
    const parked = (await sqs.peek(sqs.dlqUrl)).filter((m) => m.Attributes?.MessageGroupId === wallet.walletId);
    expect(parked).toHaveLength(1);
    expect(parked[0]?.MessageAttributes?.failureReason?.StringValue).toContain('RETRIES_EXHAUSTED');
    expect((await db.balances(wallet.walletId)).stored).toBe(100);
  });

  test('a transient failure that clears is processed on a later attempt', async () => {
    const wallet = await db.openWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    let calls = 0;
    const flaky = {
      execute: (body: string) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('connection reset'));
        return process_.execute(body);
      },
    } as unknown as ProcessWagerMessage;
    await sqs.send(
      sqs.queueUrl,
      wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}` }),
      wallet.walletId,
    );
    const c = consumer({ process: flaky });

    for (let i = 0; i < 12 && calls < 2; i += 1) {
      await c.pollOnce();
      if (calls < 2) await sleep(1_000);
    }

    expect((await db.balances(wallet.walletId)).stored).toBe(75);
    expect(calls).toBe(2);
  });

  test('graceful shutdown: stop() returns promptly and the message that arrived is not lost', async () => {
    const wallet = await db.openWallet('100.00');
    const messageId = `msg-${randomUUID()}`;
    await sqs.send(
      sqs.queueUrl,
      wagerMessage(messageId, { ...wallet, externalTransactionId: `ext-${messageId}` }),
      wallet.walletId,
    );
    const running = new SqsWagerConsumer(
      sqs.client,
      { queueUrl: sqs.queueUrl, dlqUrl: sqs.dlqUrl, waitTimeSeconds: 1 },
      process_,
    );

    running.start();
    await sleep(1_500);
    const stoppedAt = Date.now();
    await running.stop();

    expect(Date.now() - stoppedAt).toBeLessThan(3_000);
    expect((await db.balances(wallet.walletId)).stored).toBe(75);
    // The aborted long poll may still be open on the broker side and would take the next message
    // sent to this queue. Let it expire so it does not leak into the next test.
    await sleep(1_500);
  });

  test('50 messages for one wallet and for several wallets keep every balance consistent', async () => {
    const hot = await db.openWallet('1000.00');
    const others = await Promise.all(Array.from({ length: 5 }, () => db.openWallet('100.00')));
    const sends: Promise<void>[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = `msg-${randomUUID()}`;
      sends.push(sqs.send(sqs.queueUrl, wagerMessage(id, { ...hot, externalTransactionId: `ext-${id}`, amount: '10.00' }), hot.walletId));
    }
    for (const wallet of others) {
      for (let i = 0; i < 4; i += 1) {
        const id = `msg-${randomUUID()}`;
        sends.push(sqs.send(sqs.queueUrl, wagerMessage(id, { ...wallet, externalTransactionId: `ext-${id}`, amount: '10.00' }), wallet.walletId));
      }
    }
    await Promise.all(sends);
    const c1 = consumer();
    const c2 = consumer();

    await Promise.all([drain(c1), drain(c2)]);
    expect((await db.balances(hot.walletId)).stored).toBe(700);
    expect((await db.balances(hot.walletId)).rebuilt).toBe(700);
    for (const wallet of others) {
      expect((await db.balances(wallet.walletId)).stored).toBe(60);
    }
  });
});
