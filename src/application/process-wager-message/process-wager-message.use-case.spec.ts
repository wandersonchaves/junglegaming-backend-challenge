import { beforeEach, describe, expect, test } from 'bun:test';
import { InvalidMoneyError } from '../../domain/errors/domain.error';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { CreateWallet } from '../create-wallet/create-wallet.use-case';
import { IdempotencyConflictError } from '../errors';
import { FixedClock, InMemoryUnitOfWork, SequentialIds } from '../testing/in-memory';
import { SubmitWagerTransaction } from '../submit-wager-transaction/submit-wager-transaction.use-case';
import { InvalidMessageError, classifyError } from './message-errors';
import { ProcessWagerMessage } from './process-wager-message.use-case';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

describe('ProcessWagerMessage', () => {
  let uow: InMemoryUnitOfWork;
  let process: ProcessWagerMessage;
  let walletId: string;

  const body = (overrides: Record<string, unknown> = {}, messageId = 'msg-1') =>
    JSON.stringify({
      messageId,
      type: 'WagerTransactionRequested',
      occurredAt: '2026-11-20T10:00:00.000Z',
      data: {
        providerId: 'provider-a',
        externalTransactionId: 'tx-1',
        idempotencyKey: 'provider-a:tx-1',
        playerId: PLAYER,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        ...overrides,
      },
    });

  const balance = () => uow.store.wallets.get(walletId)?.balance.toString();

  beforeEach(async () => {
    uow = new InMemoryUnitOfWork();
    const ids = new SequentialIds();
    const clock = new FixedClock();
    process = new ProcessWagerMessage(new SubmitWagerTransaction(uow, clock, ids));
    const wallet = await new CreateWallet(uow, clock, ids).execute({
      playerId: PLAYER,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    walletId = wallet.id;
  });

  test('applies the transaction carried by the message', async () => {
    const result = await process.execute(body());

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(balance()).toBe('75.00');
  });

  test('the same message delivered again has no extra effect', async () => {
    await process.execute(body());

    const again = await process.execute(body());

    expect(again.idempotentReplay).toBe(true);
    expect(balance()).toBe('75.00');
    expect(uow.store.ledger.filter((e) => e.direction === 'DEBIT')).toHaveLength(1);
  });

  test('the message is recorded in the inbox', async () => {
    await process.execute(body());

    expect([...uow.store.inbox.keys()]).toEqual(['wager-transactions-consumer/msg-1']);
  });

  test('the same transaction under another message id is still deduplicated by its key', async () => {
    await process.execute(body({}, 'msg-1'));

    const again = await process.execute(body({}, 'msg-2'));

    expect(again.idempotentReplay).toBe(true);
    expect(balance()).toBe('75.00');
  });

  test('a business rejection is a normal result, not an error', async () => {
    const result = await process.execute(body({ money: { amount: '500.00', currency: 'BRL' } }));

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('the same message id with another transaction is a conflict', async () => {
    await process.execute(body({}, 'msg-1'));

    await expect(
      process.execute(
        body({ externalTransactionId: 'tx-2', idempotencyKey: 'provider-a:tx-2' }, 'msg-1'),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  describe('invalid messages', () => {
    test('not JSON', async () => {
      await expect(process.execute('{oops')).rejects.toBeInstanceOf(InvalidMessageError);
    });

    test('wrong type', async () => {
      await expect(
        process.execute(JSON.stringify({ messageId: 'm', type: 'Other', data: {} })),
      ).rejects.toBeInstanceOf(InvalidMessageError);
    });

    test('unknown kind', async () => {
      await expect(process.execute(body({ kind: 'GIFT' }))).rejects.toBeInstanceOf(InvalidMessageError);
    });

    test('missing field', async () => {
      await expect(process.execute(body({ walletId: undefined }))).rejects.toBeInstanceOf(
        InvalidMessageError,
      );
    });

    test('a malformed amount fails as invalid money', async () => {
      await expect(
        process.execute(body({ money: { amount: '1e3', currency: 'BRL' } })),
      ).rejects.toBeInstanceOf(InvalidMoneyError);
    });
  });
});

describe('classifyError', () => {
  test('data errors are permanent: they go to the dead-letter queue', () => {
    expect(classifyError(new InvalidMessageError('x'))).toBe('permanent');
    expect(classifyError(new InvalidMoneyError('x'))).toBe('permanent');
    expect(classifyError(new IdempotencyConflictError('x'))).toBe('permanent');
  });

  test('anything else is transient: the message is retried', () => {
    expect(classifyError(new Error('connection reset'))).toBe('transient');
  });
});
