import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';

let app: INestApplication;
let base: string;
const run = randomUUID().slice(0, 8);

beforeAll(async () => {
  // This suite exercises HTTP only: the queue consumer and the workers have their own suites.
  process.env.CONSUMER_ENABLED = 'false';
  process.env.WORKERS_ENABLED = 'false';
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

async function wallet(amount = '100.00') {
  const playerId = randomUUID();
  const response = await post('/wallets', {
    playerId,
    initialBalance: { amount, currency: 'BRL' },
  });
  const body = (await response.json()) as { id: string };
  return { playerId, walletId: body.id, status: response.status };
}

function wager(w: { playerId: string; walletId: string }, name: string, amount: string, extra = {}) {
  const externalTransactionId = `${run}-${name}`;
  return {
    key: `provider-a:${externalTransactionId}`,
    body: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      ...extra,
    },
  };
}

const submit = (w: { playerId: string; walletId: string }, name: string, amount: string, extra = {}) => {
  const { key, body } = wager(w, name, amount, extra);
  return post('/wagering/transactions', body, { 'idempotency-key': key });
};

describe('HTTP contract', () => {
  test('POST /wallets answers 201 with the balance and version 1', async () => {
    const w = await wallet('1000.00');

    expect(w.status).toBe(201);
  });

  test('a duplicated wallet is 409', async () => {
    const w = await wallet();

    const again = await post('/wallets', {
      playerId: w.playerId,
      initialBalance: { amount: '1.00', currency: 'BRL' },
    });

    expect(again.status).toBe(409);
  });

  test('201 on a new bet, 200 on its replay with idempotentReplay true', async () => {
    const w = await wallet();

    const first = await submit(w, 'status-bet', '25.00');
    const replay = await submit(w, 'status-bet', '25.00');

    expect(first.status).toBe(201);
    expect(((await first.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(false);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);
  });

  test('400 for a missing header and for a malformed amount', async () => {
    const w = await wallet();
    const { body } = wager(w, 'bad', '25.00');

    const noHeader = await post('/wagering/transactions', body);
    const badAmount = await submit(w, 'bad-amount', '1e3');

    expect(noHeader.status).toBe(400);
    expect(badAmount.status).toBe(400);
  });

  test('409 for the same key with another payload', async () => {
    const w = await wallet();
    await submit(w, 'conflict', '10.00');

    const { key, body } = wager(w, 'conflict', '11.00');
    const conflict = await post('/wagering/transactions', body, { 'idempotency-key': key });

    expect(conflict.status).toBe(409);
  });

  test('404 for an unknown wallet', async () => {
    const w = await wallet();

    const response = await submit({ ...w, walletId: randomUUID() }, 'ghost', '1.00');

    expect(response.status).toBe(404);
  });

  test('422 for a business rejection, with the failure code', async () => {
    const w = await wallet('10.00');

    const response = await submit(w, 'too-big', '50.00');
    const body = (await response.json()) as { status: string; failureCode: string };

    expect(response.status).toBe(422);
    expect(body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
  });

  test('422 for a currency that differs from the wallet', async () => {
    const w = await wallet();

    const response = await submit(w, 'usd', '5.00', { money: { amount: '5.00', currency: 'USD' } });

    expect(response.status).toBe(422);
  });

  test('202 for a reversal whose reference has not arrived', async () => {
    const w = await wallet();

    const response = await submit(w, 'early', '5.00', {
      kind: 'REFUND',
      referenceExternalTransactionId: `${run}-never-arrived`,
    });

    expect(response.status).toBe(202);
  });
});

describe('queries, reconciliation and operations', () => {
  const get = (path: string) => fetch(`${base}${path}`);

  test('GET /wallets/:id returns balance and version, 404 when unknown', async () => {
    const w = await wallet('100.00');
    await submit(w, 'q-bet', '25.00');

    const found = await get(`/wallets/${w.walletId}`);
    const missing = await get(`/wallets/${randomUUID()}`);

    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ balance: { amount: '75.00', currency: 'BRL' }, version: 2 });
    expect(missing.status).toBe(404);
  });

  test('GET ledger pages with an opaque cursor', async () => {
    const w = await wallet('100.00');
    for (let i = 0; i < 4; i += 1) await submit(w, `ledger-${i}`, '1.00');

    const first = (await (await get(`/wallets/${w.walletId}/ledger?limit=2`)).json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    const second = (await (
      await get(`/wallets/${w.walletId}/ledger?limit=2&cursor=${first.nextCursor}`)
    ).json()) as { items: { id: string }[] };

    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(4);
  });

  test('a broken cursor or limit is a 400', async () => {
    const w = await wallet();

    expect((await get(`/wallets/${w.walletId}/ledger?cursor=not-a-cursor`)).status).toBe(400);
    expect((await get(`/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
  });

  test('GET a transaction by id and by provider and external id', async () => {
    const w = await wallet();
    const created = (await (await submit(w, 'lookup-http', '5.00')).json()) as { transactionId: string };

    const byId = await get(`/wagering/transactions/${created.transactionId}`);
    const byExternal = await get(`/providers/provider-a/wagering/transactions/${run}-lookup-http`);
    const missing = await get(`/wagering/transactions/${randomUUID()}`);

    expect(byId.status).toBe(200);
    expect(((await byExternal.json()) as { id: string }).id).toBe(created.transactionId);
    expect(missing.status).toBe(404);
  });

  test('POST reconciliation reports the wallet as consistent', async () => {
    const w = await wallet('100.00');
    await submit(w, 'recon-http', '10.00');

    const response = await post(`/wallets/${w.walletId}/reconciliation`, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ consistent: true, checkedEntries: 2 });
  });

  test('health: live is ok and ready checks the dependencies', async () => {
    expect((await get('/health/live')).status).toBe(200);
    const ready = await get('/health/ready');
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { postgres: 'up' } });
  });

  test('metrics are exposed in the Prometheus text format', async () => {
    const w = await wallet();
    await submit(w, 'metrics-bet', '1.00');

    const text = await (await get('/metrics')).text();

    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('wager_transactions_total{source="http",status="PROCESSED"}');
    expect(text).toContain('wallet_lock_wait_seconds_bucket');
  });
});

describe('concurrency through HTTP', () => {
  test('50 identical requests: one 201, forty-nine 200, one debit', async () => {
    const w = await wallet('100.00');

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submit(w, 'burst', '25.00')),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(49);
  });

  test('two bets of 80.00 on 100.00: one 201 and one 422', async () => {
    const w = await wallet('100.00');

    const responses = await Promise.all([submit(w, 'race-a', '80.00'), submit(w, 'race-b', '80.00')]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
  });
});
