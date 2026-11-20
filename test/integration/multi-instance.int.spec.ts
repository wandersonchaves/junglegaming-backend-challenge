import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { connect } from '../support/db';
import { createQueues, wagerMessage } from '../support/sqs';

/**
 * Three real application processes share one PostgreSQL and one set of queues:
 * HTTP requests are spread across them, queue messages are consumed by all of them,
 * one process is killed in the middle and brought back. The invariant at the end is the one
 * the README asks for: stored balance equals the balance rebuilt from the ledger.
 */
const PORTS = [3201, 3202, 3203];

let db: Awaited<ReturnType<typeof connect>>;
let sqs: Awaited<ReturnType<typeof createQueues>>;
const processes = new Map<number, ReturnType<typeof Bun.spawn>>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = (port: number, path: string) => `http://localhost:${port}${path}`;

function start(port: number): void {
  processes.set(
    port,
    Bun.spawn(['bun', 'run', 'src/main.ts'], {
      stdout: 'inherit',
      stderr: 'inherit',
      env: {
        ...process.env,
        PORT: String(port),
        LOG_LEVEL: 'warn',
        CONSUMER_WAIT_SECONDS: '1',
        AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
        WAGER_QUEUE_URL: sqs.queueUrl,
        WAGER_DLQ_URL: sqs.dlqUrl,
        WAGER_EVENTS_QUEUE_URL: sqs.eventsUrl,
        CONSUMER_ENABLED: 'true',
        WORKERS_ENABLED: 'true',
      },
    }),
  );
}

async function waitReady(port: number, seconds = 30): Promise<void> {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      if ((await fetch(url(port, '/health/ready'))).status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`instance on ${port} never became ready`);
}

/** What a provider does: on a connection error, resend the same request, same key, elsewhere. */
async function send(path: string, body: unknown, key: string, firstPort: number): Promise<Response> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = PORTS[(PORTS.indexOf(firstPort) + attempt) % PORTS.length] as number;
    try {
      return await fetch(url(port, path), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify(body),
      });
    } catch {
      await sleep(200);
    }
  }
  throw new Error('no instance answered');
}

beforeAll(async () => {
  db = await connect();
  sqs = await createQueues();
  PORTS.forEach(start);
  await Promise.all(PORTS.map((port) => waitReady(port)));
}, 60_000);

afterAll(async () => {
  for (const child of processes.values()) child.kill('SIGKILL');
  await db.orm.close();
});

describe('three instances', () => {
  test('hot wallets, duplicates, a killed instance and a restart: every wallet stays consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => db.openWallet('100.00')));
    const work: Promise<unknown>[] = [];

    for (const [w, wallet] of wallets.entries()) {
      for (let i = 0; i < 12; i += 1) {
        const external = db.externalId(`multi-${w}-${i}`);
        if (i % 2 === 0) {
          // HTTP, sent twice through different instances at the same time
          const command = db.bet(wallet, `multi-${w}-${i}`, '10.00');
          const first = PORTS[(w + i) % 3] as number;
          const second = PORTS[(w + i + 1) % 3] as number;
          work.push(send('/wagering/transactions', command, command.idempotencyKey, first));
          work.push(send('/wagering/transactions', command, command.idempotencyKey, second));
        } else {
          // queue, delivered twice with different SQS ids but the same messageId
          const messageId = `msg-${randomUUID()}`;
          const body = wagerMessage(messageId, { ...wallet, externalTransactionId: external, amount: '10.00' });
          work.push(sqs.send(sqs.queueUrl, body, wallet.walletId));
          work.push(sqs.send(sqs.queueUrl, body, wallet.walletId));
        }
      }
    }

    await sleep(300);
    processes.get(3202)?.kill('SIGKILL'); // dies in the middle of the load
    await sleep(1_000);
    start(3202); // comes back
    await Promise.all(work);
    await waitReady(3202);

    // wait for the queue to be fully consumed
    const deadline = Date.now() + 60_000;
    let settled = false;
    while (Date.now() < deadline && !settled) {
      const states = await Promise.all(wallets.map((w) => db.balances(w.walletId)));
      settled = states.every((s) => s.stored === 0);
      if (!settled) await sleep(500);
    }

    for (const wallet of wallets) {
      const { stored, rebuilt, entries } = await db.balances(wallet.walletId);
      expect(stored).toBe(0); // 12 bets of 10.00 against 100.00: exactly 10 fit
      expect(rebuilt).toBe(0);
      expect(entries).toBe(11); // opening + 10 debits, never more
      expect(
        await db.count(
          `select count(*) as n from wager_transactions where wallet_id = ? and kind = 'BET' and status = 'PROCESSED'`,
          [wallet.walletId],
        ),
      ).toBe(10);
    }
  }, 120_000);

  test('a refund that arrives before its bet is applied by the workers of the running instances', async () => {
    const wallet = await db.openWallet('100.00');
    const refund = db.bet(wallet, 'multi-refund', '25.00', {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: db.externalId('multi-bet-first'),
    });
    const early = await send('/wagering/transactions', refund, refund.idempotencyKey, 3201);
    expect(early.status).toBe(202);
    const bet = db.bet(wallet, 'multi-bet-first', '25.00');
    await send('/wagering/transactions', bet, bet.idempotencyKey, 3203);

    const deadline = Date.now() + 45_000;
    let balance = (await db.balances(wallet.walletId)).stored;
    while (Date.now() < deadline && balance !== 100) {
      await sleep(1_000);
      balance = (await db.balances(wallet.walletId)).stored;
    }

    const { stored, rebuilt } = await db.balances(wallet.walletId);
    expect(stored).toBe(100);
    expect(rebuilt).toBe(100);
  }, 60_000);

  test('the events of every wallet end up published, and every instance reconciles clean', async () => {
    const deadline = Date.now() + 30_000;
    let pending = 1;
    while (Date.now() < deadline && pending > 0) {
      pending = await db.count(`select count(*) as n from outbox_messages where published_at is null`, []);
      if (pending > 0) await sleep(500);
    }
    expect(pending).toBe(0);

    const wallet = await db.openWallet('50.00');
    for (const port of PORTS) {
      const reconciliation = await fetch(url(port, `/wallets/${wallet.walletId}/reconciliation`), { method: 'POST' });
      expect(reconciliation.status).toBe(200);
      expect(((await reconciliation.json()) as { consistent: boolean }).consistent).toBe(true);
    }
    const metrics = await (await fetch(url(3201, '/metrics'))).text();
    expect(metrics).toContain('wager_transactions_total');
    expect(metrics).toContain('outbox_lag_seconds');
  }, 60_000);

  test('SIGTERM shuts an instance down cleanly and promptly', async () => {
    const child = processes.get(3203) as ReturnType<typeof Bun.spawn>;
    const startedAt = Date.now();

    child.kill('SIGTERM');
    const code = await Promise.race([child.exited, sleep(15_000).then(() => 'timeout' as const)]);

    expect(code).not.toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);
});
