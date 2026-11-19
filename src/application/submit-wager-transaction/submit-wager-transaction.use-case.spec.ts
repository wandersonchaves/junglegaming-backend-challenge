import { beforeEach, describe, expect, test } from 'bun:test';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { CurrencyMismatchError, InvalidMoneyError } from '../../domain/errors/domain.error';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { InvalidTransactionError } from '../../domain/wager/wager.errors';
import { CreateWallet } from '../create-wallet/create-wallet.use-case';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../errors';
import { FixedClock, InMemoryUnitOfWork, SequentialIds } from '../testing/in-memory';
import {
  SubmitWagerTransaction,
  SubmitWagerTransactionCommand,
} from './submit-wager-transaction.use-case';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const brl = (amount: string) => ({ amount, currency: 'BRL' });

describe('SubmitWagerTransaction', () => {
  let uow: InMemoryUnitOfWork;
  let submit: SubmitWagerTransaction;
  let walletId: string;
  let sequence = 0;

  const command = (
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand => {
    sequence += 1;
    const externalTransactionId = overrides.externalTransactionId ?? `tx-${sequence}`;
    return {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: PLAYER,
      walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: brl('25.00'),
      ...overrides,
    };
  };

  const balance = () => uow.store.wallets.get(walletId)?.balance.toString();

  beforeEach(async () => {
    sequence = 0;
    uow = new InMemoryUnitOfWork();
    const ids = new SequentialIds();
    const clock = new FixedClock();
    submit = new SubmitWagerTransaction(uow, clock, ids);
    const wallet = await new CreateWallet(uow, clock, ids).execute({
      playerId: PLAYER,
      initialBalance: brl('100.00'),
    });
    walletId = wallet.id;
  });

  describe('BET', () => {
    test('debits the wallet and answers PROCESSED with the new balance', async () => {
      const result = await submit.execute(command({ money: brl('25.00') }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(result.balance).toEqual(brl('75.00'));
      expect(result.idempotentReplay).toBe(false);
      expect(balance()).toBe('75.00');
    });

    test('writes one DEBIT ledger entry that points at the transaction', async () => {
      const result = await submit.execute(command({ money: brl('25.00') }));

      const debits = uow.store.ledger.filter((e) => e.direction === 'DEBIT');
      expect(debits).toHaveLength(1);
      expect(debits[0]?.transactionId).toBe(result.transactionId);
    });

    test('rejects with INSUFFICIENT_FUNDS, keeps the balance and writes no ledger entry', async () => {
      const ledgerBefore = uow.store.ledger.length;

      const result = await submit.execute(command({ money: brl('100.01') }));

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(balance()).toBe('100.00');
      expect(uow.store.ledger).toHaveLength(ledgerBefore);
    });

    test('keeps the rejected transaction for audit', async () => {
      const result = await submit.execute(command({ money: brl('500.00') }));

      expect(uow.store.transactions.get(result.transactionId)?.status).toBe(WagerTransactionStatus.Rejected);
    });

    test('lets a bet spend the exact balance', async () => {
      const result = await submit.execute(command({ money: brl('100.00') }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(balance()).toBe('0.00');
    });

    test('publishes Processed and WalletBalanceChanged', async () => {
      const before = uow.store.events.length;

      await submit.execute(command());

      const types = uow.store.events.slice(before).map((e) => e.eventType);
      expect(types).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    });

    test('publishes only Rejected for a rejected bet', async () => {
      const before = uow.store.events.length;

      await submit.execute(command({ money: brl('500.00') }));

      expect(uow.store.events.slice(before).map((e) => e.eventType)).toEqual([
        'WagerTransactionRejected',
      ]);
    });
  });

  describe('WIN and LOSS', () => {
    test('WIN credits the wallet', async () => {
      const result = await submit.execute(command({ kind: WagerTransactionKind.Win, money: brl('40.00') }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(balance()).toBe('140.00');
    });

    test('LOSS is PROCESSED but moves no money and writes no ledger entry', async () => {
      const ledgerBefore = uow.store.ledger.length;
      const eventsBefore = uow.store.events.length;

      const result = await submit.execute(command({ kind: WagerTransactionKind.Loss }));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(balance()).toBe('100.00');
      expect(uow.store.ledger).toHaveLength(ledgerBefore);
      expect(uow.store.events.slice(eventsBefore).map((e) => e.eventType)).toEqual([
        'WagerTransactionProcessed',
      ]);
    });
  });

  describe('idempotency', () => {
    test('repeating a processed request returns the original result as a replay', async () => {
      const original = command({ money: brl('25.00') });
      const first = await submit.execute(original);

      const second = await submit.execute(original);

      expect(second.idempotentReplay).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
      expect(second.status).toBe(WagerTransactionStatus.Processed);
      expect(second.balance).toEqual(brl('75.00'));
      expect(balance()).toBe('75.00');
    });

    test('a replay answers with the balance seen back then, not the current one', async () => {
      const first = command({ money: brl('25.00') });
      await submit.execute(first);
      await submit.execute(command({ money: brl('10.00') }));

      const replay = await submit.execute(first);

      expect(replay.balance).toEqual(brl('75.00'));
      expect(balance()).toBe('65.00');
    });

    test('a replay does not write another ledger entry or event', async () => {
      const original = command();
      await submit.execute(original);
      const ledger = uow.store.ledger.length;
      const events = uow.store.events.length;

      await submit.execute(original);

      expect(uow.store.ledger).toHaveLength(ledger);
      expect(uow.store.events).toHaveLength(events);
    });

    test('replays a rejection with its failure code', async () => {
      const original = command({ money: brl('999.00') });
      await submit.execute(original);

      const replay = await submit.execute(original);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.status).toBe(WagerTransactionStatus.Rejected);
      expect(replay.failureCode).toBe('INSUFFICIENT_FUNDS');
    });

    test('the same key with a different payload is a conflict, not a replay', async () => {
      const original = command({ money: brl('25.00') });
      await submit.execute(original);

      await expect(submit.execute({ ...original, money: brl('26.00') })).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
      expect(balance()).toBe('75.00');
    });

    test('the same external transaction id under another key is a conflict', async () => {
      const original = command({ externalTransactionId: 'same-ext' });
      await submit.execute(original);

      await expect(
        submit.execute({ ...original, idempotencyKey: 'another-key' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    test('amounts that differ only in notation hash the same ("25.5" and "25.50")', async () => {
      const original = command({ money: brl('25.5') });
      await submit.execute(original);

      const replay = await submit.execute({ ...original, money: brl('25.50') });

      expect(replay.idempotentReplay).toBe(true);
    });
  });

  describe('validation', () => {
    test('rejects OPENING from the outside', async () => {
      await expect(
        submit.execute(command({ kind: WagerTransactionKind.Opening })),
      ).rejects.toBeInstanceOf(InvalidTransactionError);
    });

    test('rejects a zero amount', async () => {
      await expect(submit.execute(command({ money: brl('0.00') }))).rejects.toBeInstanceOf(
        InvalidTransactionError,
      );
    });

    test('rejects a malformed amount', async () => {
      await expect(submit.execute(command({ money: brl('1e3') }))).rejects.toBeInstanceOf(
        InvalidMoneyError,
      );
    });

    test('a REFUND without a reference is invalid', async () => {
      await expect(
        submit.execute(command({ kind: WagerTransactionKind.Refund })),
      ).rejects.toBeInstanceOf(InvalidTransactionError);
    });

    test('an unknown wallet is not found', async () => {
      await expect(
        submit.execute(command({ walletId: '0192f291-27dd-7d3f-8071-5f8685deef37' })),
      ).rejects.toBeInstanceOf(WalletNotFoundError);
    });

    test('a wallet that belongs to another player is refused', async () => {
      await expect(
        submit.execute(command({ playerId: '0192f28f-5dc0-7d58-bdb2-000000000000' })),
      ).rejects.toBeInstanceOf(WalletPlayerMismatchError);
    });

    test('a currency different from the wallet is refused and the balance is untouched', async () => {
      await expect(
        submit.execute(command({ money: { amount: '10.00', currency: 'USD' } })),
      ).rejects.toBeInstanceOf(CurrencyMismatchError);
      expect(balance()).toBe('100.00');
    });
  });

  describe('REFUND and ROLLBACK', () => {
    const reversal = (kind: WagerTransactionKind, reference: string, money = '25.00') =>
      command({ kind, referenceExternalTransactionId: reference, money: brl(money) });

    test('REFUND credits back a processed BET', async () => {
      await submit.execute(command({ externalTransactionId: 'bet-1', money: brl('25.00') }));

      const result = await submit.execute(reversal(WagerTransactionKind.Refund, 'bet-1'));

      expect(result.status).toBe(WagerTransactionStatus.Processed);
      expect(balance()).toBe('100.00');
    });

    test('stores the internal id of the referenced transaction', async () => {
      const bet = await submit.execute(command({ externalTransactionId: 'bet-1' }));

      const refund = await submit.execute(reversal(WagerTransactionKind.Refund, 'bet-1'));

      expect(uow.store.transactions.get(refund.transactionId)?.referenceTransactionId).toBe(
        bet.transactionId,
      );
    });

    test('a BET cannot be refunded twice', async () => {
      await submit.execute(command({ externalTransactionId: 'bet-1' }));
      await submit.execute(reversal(WagerTransactionKind.Refund, 'bet-1'));

      const second = await submit.execute(reversal(WagerTransactionKind.Refund, 'bet-1'));

      expect(second.status).toBe(WagerTransactionStatus.Rejected);
      expect(second.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      expect(balance()).toBe('100.00');
    });

    test('ROLLBACK of a BET credits, ROLLBACK of a WIN debits', async () => {
      await submit.execute(command({ externalTransactionId: 'bet-1' }));
      await submit.execute(
        command({ externalTransactionId: 'win-1', kind: WagerTransactionKind.Win, money: brl('40.00') }),
      );
      expect(balance()).toBe('115.00');

      await submit.execute(reversal(WagerTransactionKind.Rollback, 'win-1', '40.00'));
      expect(balance()).toBe('75.00');

      await submit.execute(reversal(WagerTransactionKind.Rollback, 'bet-1'));
      expect(balance()).toBe('100.00');
    });

    test('a ROLLBACK that would overdraw is rejected with its own code', async () => {
      await submit.execute(
        command({ externalTransactionId: 'win-1', kind: WagerTransactionKind.Win, money: brl('50.00') }),
      );
      await submit.execute(command({ externalTransactionId: 'bet-1', money: brl('140.00') }));
      expect(balance()).toBe('10.00');

      const result = await submit.execute(reversal(WagerTransactionKind.Rollback, 'win-1', '50.00'));

      expect(result.status).toBe(WagerTransactionStatus.Rejected);
      expect(result.failureCode).toBe('REVERSAL_WOULD_OVERDRAW');
      expect(balance()).toBe('10.00');
    });

    test('an unknown reference waits as PENDING_REFERENCE without touching the wallet', async () => {
      const eventsBefore = uow.store.events.length;

      const result = await submit.execute(reversal(WagerTransactionKind.Refund, 'not-yet'));

      expect(result.status).toBe(WagerTransactionStatus.PendingReference);
      expect(balance()).toBe('100.00');
      expect(uow.store.events.slice(eventsBefore).map((e) => e.eventType)).toEqual([
        'WagerTransactionPendingReference',
      ]);
    });

    test('REFUND cannot point at a WIN', async () => {
      await submit.execute(
        command({ externalTransactionId: 'win-1', kind: WagerTransactionKind.Win, money: brl('10.00') }),
      );

      const result = await submit.execute(reversal(WagerTransactionKind.Refund, 'win-1', '10.00'));

      expect(result.failureCode).toBe('INVALID_REFERENCE_KIND');
    });

    test('a reversal with a different amount is rejected', async () => {
      await submit.execute(command({ externalTransactionId: 'bet-1', money: brl('25.00') }));

      const result = await submit.execute(reversal(WagerTransactionKind.Refund, 'bet-1', '20.00'));

      expect(result.failureCode).toBe('AMOUNT_MISMATCH');
    });

    test('a reference from another round is rejected', async () => {
      await submit.execute(command({ externalTransactionId: 'bet-1', roundId: 'round-A' }));

      const result = await submit.execute(
        command({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'bet-1',
          roundId: 'round-B',
        }),
      );

      expect(result.failureCode).toBe('REFERENCE_MISMATCH');
    });

    test('a reference that was itself rejected is not a valid target', async () => {
      await submit.execute(command({ externalTransactionId: 'bet-big', money: brl('999.00') }));

      const result = await submit.execute(reversal(WagerTransactionKind.Refund, 'bet-big', '999.00'));

      expect(result.failureCode).toBe('REFERENCE_NOT_PROCESSED');
    });
  });

  test('wallet balance always equals the ledger sum after a mixed sequence', async () => {
    await submit.execute(command({ externalTransactionId: 'b1', money: brl('30.00') }));
    await submit.execute(command({ externalTransactionId: 'w1', kind: WagerTransactionKind.Win, money: brl('12.34') }));
    await submit.execute(command({ externalTransactionId: 'b2', money: brl('500.00') }));
    await submit.execute(
      command({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'b1', money: brl('30.00') }),
    );

    const fromLedger = uow.store.ledger.reduce(
      (sum, e) => (e.direction === 'CREDIT' ? sum + Number(e.money.toString()) : sum - Number(e.money.toString())),
      0,
    );
    expect(Number(balance())).toBeCloseTo(fromLedger, 2);
  });
});
