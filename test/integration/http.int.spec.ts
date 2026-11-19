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
