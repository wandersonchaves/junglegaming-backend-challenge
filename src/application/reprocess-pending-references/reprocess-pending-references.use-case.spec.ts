import { beforeEach, describe, expect, test } from 'bun:test';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { CreateWallet } from '../create-wallet/create-wallet.use-case';
import { Clock } from '../ports/clock-and-ids';
import {
  SubmitWagerTransaction,
  SubmitWagerTransactionCommand,
} from '../submit-wager-transaction/submit-wager-transaction.use-case';
import { InMemoryUnitOfWork, SequentialIds } from '../testing/in-memory';
import {
  MAX_REFERENCE_ATTEMPTS,
  ReprocessPendingReferences,
  referenceRetryDelayMs,
} from './reprocess-pending-references.use-case';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

class MovingClock implements Clock {
  constructor(private current = new Date('2026-11-20T10:00:00.000Z')) { }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('ReprocessPendingReferences', () => {
  let uow: InMemoryUnitOfWork;
  let clock: MovingClock;
  let submit: SubmitWagerTransaction;
  let worker: ReprocessPendingReferences;
  let walletId: string;

  const command = (overrides: Partial<SubmitWagerTransactionCommand>): SubmitWagerTransactionCommand => {
    const externalTransactionId = overrides.externalTransactionId ?? 'tx';
    return {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: PLAYER,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides,
    };
  };

  const refund = () =>
    command({
      externalTransactionId: 'refund-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });

  const balance = () => uow.store.wallets.get(walletId)?.balance.toString();

  beforeEach(async () => {
    uow = new InMemoryUnitOfWork();
    clock = new MovingClock();
    const ids = new SequentialIds();
    submit = new SubmitWagerTransaction(uow, clock, ids);
    worker = new ReprocessPendingReferences(uow, clock, ids);
    const wallet = await new CreateWallet(uow, clock, ids).execute({
      playerId: PLAYER,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    walletId = wallet.id;
  });

  test('applies the reversal once its reference has arrived', async () => {
    const early = await submit.execute(refund());
    expect(early.status).toBe(WagerTransactionStatus.PendingReference);
    await submit.execute(command({ externalTransactionId: 'bet-1' }));
    expect(balance()).toBe('75.00');
    clock.advance(6_000);

    const result = await worker.execute();

    expect(result).toMatchObject({ checked: 1, processed: 1 });
    expect(uow.store.transactions.get(early.transactionId)?.status).toBe(WagerTransactionStatus.Processed);
    expect(balance()).toBe('100.00');
  });

  test('does not look again before the retry is due', async () => {
    await submit.execute(refund());

    const result = await worker.execute();

    expect(result.checked).toBe(0);
  });

  test('keeps waiting and backs off while the reference is missing', async () => {
    const early = await submit.execute(refund());
    clock.advance(6_000);

    const first = await worker.execute();
    const tooSoon = await worker.execute();

    expect(first.stillWaiting).toBe(1);
    expect(tooSoon.checked).toBe(0);
    expect(uow.store.pending.get(early.transactionId)?.attempts).toBe(1);
  });

  test('after the maximum number of attempts the reversal is rejected with REFERENCE_NOT_FOUND', async () => {
    const early = await submit.execute(refund());
    const eventsBefore = uow.store.events.length;

    for (let i = 0; i < MAX_REFERENCE_ATTEMPTS; i += 1) {
      clock.advance(6 * 60_000);
      await worker.execute();
    }

    const tx = uow.store.transactions.get(early.transactionId);
    expect(tx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx?.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(uow.store.events.slice(eventsBefore).map((e) => e.eventType)).toEqual(['WagerTransactionRejected']);
    expect(balance()).toBe('100.00');
  });

  test('a reference that turns out to be rejected rejects the reversal', async () => {
    const early = await submit.execute(refund());
    await submit.execute(command({ externalTransactionId: 'bet-1', money: { amount: '999.00', currency: 'BRL' } }));
    clock.advance(6_000);

    await worker.execute();

    const tx = uow.store.transactions.get(early.transactionId);
    expect(tx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx?.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  test('publishes the events of the late processing', async () => {
    await submit.execute(refund());
    await submit.execute(command({ externalTransactionId: 'bet-1' }));
    clock.advance(6_000);
    const before = uow.store.events.length;

    await worker.execute();

    expect(uow.store.events.slice(before).map((e) => e.eventType)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('the retry delay doubles up to a cap', () => {
    expect(referenceRetryDelayMs(1)).toBe(5_000);
    expect(referenceRetryDelayMs(2)).toBe(10_000);
    expect(referenceRetryDelayMs(3)).toBe(20_000);
    expect(referenceRetryDelayMs(20)).toBe(5 * 60_000);
  });
});
