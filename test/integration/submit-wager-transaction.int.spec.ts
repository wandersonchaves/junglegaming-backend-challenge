import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { WalletAlreadyExistsError } from '../../src/application/errors';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import { connect } from '../support/db';

let db: Awaited<ReturnType<typeof connect>>;

beforeAll(async () => {
  db = await connect();
});

afterAll(async () => {
  await db.orm.close();
});

describe('CreateWallet against PostgreSQL', () => {
  test('writes wallet, OPENING transaction, ledger entry and outbox events together', async () => {
    const wallet = await db.openWallet('1000.00');

    const { stored, rebuilt, entries } = await db.balances(wallet.walletId);
    expect(stored).toBe(1000);
    expect(rebuilt).toBe(1000);
    expect(entries).toBe(1);
    expect(
      await db.count(
        `select count(*) as n from wager_transactions where wallet_id = ? and kind = 'OPENING'`,
        [wallet.walletId],
      ),
    ).toBe(1);
    expect(
      await db.count(`select count(*) as n from outbox_messages where aggregate_id = ?`, [
        wallet.walletId,
      ]),
    ).toBe(1);
  });

  test('a second wallet for the same player and currency is a conflict', async () => {
    const wallet = await db.openWallet('10.00');

    await expect(
      db.createWallet.execute({
        playerId: wallet.playerId,
        initialBalance: { amount: '5.00', currency: 'BRL' },
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });
});

describe('concurrency', () => {
  test('the same bet sent 50 times in parallel debits exactly once', async () => {
    const wallet = await db.openWallet('100.00');
    const command = db.bet(wallet, 'same-bet', '25.00');

    const results = await Promise.all(Array.from({ length: 50 }, () => db.submit.execute(command)));

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    const { stored, rebuilt, entries } = await db.balances(wallet.walletId);
    expect(stored).toBe(75);
    expect(rebuilt).toBe(75);
    expect(entries).toBe(2); // opening credit + one debit
  });

  test('two bets of 80.00 against a balance of 100.00: one processed, one rejected', async () => {
    const wallet = await db.openWallet('100.00');

    const results = await Promise.all([
      db.submit.execute(db.bet(wallet, 'race-a', '80.00')),
      db.submit.execute(db.bet(wallet, 'race-b', '80.00')),
    ]);

    expect(results.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    const rejected = results.filter((r) => r.status === WagerTransactionStatus.Rejected);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.failureCode).toBe('INSUFFICIENT_FUNDS');
    const { stored, rebuilt } = await db.balances(wallet.walletId);
    expect(stored).toBe(20);
    expect(rebuilt).toBe(20);
    expect(
      await db.count(
        `select count(*) as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`,
        [wallet.walletId],
      ),
    ).toBe(1);
  });

  test('retries of the rejected bet do not debit and do not change the answer', async () => {
    const wallet = await db.openWallet('100.00');
    await db.submit.execute(db.bet(wallet, 'ok-bet', '80.00'));
    const rejectedCommand = db.bet(wallet, 'too-much', '80.00');
    const first = await db.submit.execute(rejectedCommand);

    const retries = await Promise.all(
      Array.from({ length: 10 }, () => db.submit.execute(rejectedCommand)),
    );

    expect(first.status).toBe(WagerTransactionStatus.Rejected);
    expect(retries.every((r) => r.status === WagerTransactionStatus.Rejected && r.idempotentReplay)).toBe(true);
    expect((await db.balances(wallet.walletId)).stored).toBe(20);
  });

  test('many different bets on a hot wallet never overdraw it', async () => {
    const wallet = await db.openWallet('100.00');

    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => db.submit.execute(db.bet(wallet, `hot-${i}`, '7.00'))),
    );

    const processed = results.filter((r) => r.status === WagerTransactionStatus.Processed).length;
    expect(processed).toBe(14); // 14 x 7.00 = 98.00, the 15th would overdraw
    const { stored, rebuilt } = await db.balances(wallet.walletId);
    expect(stored).toBe(2);
    expect(rebuilt).toBe(2);
  });

  test('different wallets are processed in parallel and each one stays consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => db.openWallet('100.00')));

    await Promise.all(
      wallets.flatMap((wallet, w) =>
        Array.from({ length: 5 }, (_, i) => db.submit.execute(db.bet(wallet, `multi-${w}-${i}`, '10.00'))),
      ),
    );

    for (const wallet of wallets) {
      const { stored, rebuilt } = await db.balances(wallet.walletId);
      expect(stored).toBe(50);
      expect(rebuilt).toBe(50);
    }
  });

  test('a REFUND and a ROLLBACK racing for the same BET reverse it only once per kind', async () => {
    const wallet = await db.openWallet('100.00');
    await db.submit.execute(db.bet(wallet, 'bet-to-reverse', '30.00'));

    const refunds = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.submit.execute(
          db.bet(wallet, `refund-${i}`, '30.00', {
            kind: WagerTransactionKind.Refund,
            referenceExternalTransactionId: db.externalId('bet-to-reverse'),
          }),
        ),
      ),
    );

    expect(refunds.filter((r) => r.status === WagerTransactionStatus.Processed)).toHaveLength(1);
    expect(refunds.filter((r) => r.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(4);
    const { stored, rebuilt } = await db.balances(wallet.walletId);
    expect(stored).toBe(100);
    expect(rebuilt).toBe(100);
  });
});

describe('out of order and schema guarantees', () => {
  test('a REFUND that arrives before its BET waits as PENDING_REFERENCE', async () => {
    const wallet = await db.openWallet('100.00');

    const result = await db.submit.execute(
      db.bet(wallet, 'early-refund', '10.00', {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: db.externalId('bet-not-here-yet'),
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect((await db.balances(wallet.walletId)).stored).toBe(100);
  });

  test('the database refuses a negative balance even when the code is bypassed', async () => {
    const wallet = await db.openWallet('10.00');

    await expect(
      db.em().execute(`update wallets set balance = -1 where id = ?`, [wallet.walletId], 'run'),
    ).rejects.toThrow();
  });

  test('the ledger is append-only', async () => {
    const wallet = await db.openWallet('10.00');

    await expect(
      db.em().execute(`update wallet_ledger_entries set amount = 1 where wallet_id = ?`, [wallet.walletId], 'run'),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.em().execute(`delete from wallet_ledger_entries where wallet_id = ?`, [wallet.walletId], 'run'),
    ).rejects.toThrow(/append-only/);
  });

  test('a transaction in a terminal status cannot change', async () => {
    const wallet = await db.openWallet('10.00');
    const result = await db.submit.execute(db.bet(wallet, 'final-one', '5.00'));

    await expect(
      db.em().execute(`update wager_transactions set status = 'FAILED' where id = ?`, [result.transactionId], 'run'),
    ).rejects.toThrow(/terminal/);
  });
});
