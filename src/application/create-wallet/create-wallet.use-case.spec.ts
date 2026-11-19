import { describe, expect, test } from 'bun:test';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { LedgerDirection } from '../../domain/wallet/wallet-ledger-entry';
import { InvalidMoneyError } from '../../domain/errors/domain.error';
import { WalletAlreadyExistsError } from '../errors';
import { FixedClock, InMemoryUnitOfWork, SequentialIds } from '../testing/in-memory';
import { CreateWallet } from './create-wallet.use-case';

const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';

function setup() {
  const uow = new InMemoryUnitOfWork();
  const useCase = new CreateWallet(uow, new FixedClock(), new SequentialIds());
  return { uow, useCase };
}

describe('CreateWallet', () => {
  test('opens the wallet at version 1 with the initial balance', async () => {
    const { useCase } = setup();

    const wallet = await useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(wallet.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(wallet.version).toBe(1);
  });

  test('records an OPENING transaction and a CREDIT ledger entry for a positive balance', async () => {
    const { useCase, uow } = setup();

    await useCase.execute({ playerId: PLAYER, initialBalance: { amount: '1000.00', currency: 'BRL' } });

    const [opening] = [...uow.store.transactions.values()];
    expect(opening?.kind).toBe(WagerTransactionKind.Opening);
    expect(opening?.status).toBe(WagerTransactionStatus.Processed);
    expect(uow.store.ledger).toHaveLength(1);
    expect(uow.store.ledger[0]?.direction).toBe(LedgerDirection.Credit);
    expect(uow.store.ledger[0]?.balanceBefore.toString()).toBe('0.00');
    expect(uow.store.ledger[0]?.balanceAfter.toString()).toBe('1000.00');
  });

  test('a zero balance creates no transaction and no ledger entry', async () => {
    const { useCase, uow } = setup();

    await useCase.execute({ playerId: PLAYER, initialBalance: { amount: '0.00', currency: 'BRL' } });

    expect(uow.store.transactions.size).toBe(0);
    expect(uow.store.ledger).toHaveLength(0);
  });

  test('publishes WalletBalanceChanged only when there is an opening credit', async () => {
    const { useCase, uow } = setup();

    await useCase.execute({ playerId: PLAYER, initialBalance: { amount: '10.00', currency: 'BRL' } });

    expect(uow.store.events.map((e) => e.eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
  });

  test('refuses a second wallet for the same player and currency', async () => {
    const { useCase } = setup();
    const command = { playerId: PLAYER, initialBalance: { amount: '1.00', currency: 'BRL' } };
    await useCase.execute(command);

    await expect(useCase.execute(command)).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('allows the same player to hold wallets in different currencies', async () => {
    const { useCase } = setup();
    await useCase.execute({ playerId: PLAYER, initialBalance: { amount: '1.00', currency: 'BRL' } });

    const second = await useCase.execute({
      playerId: PLAYER,
      initialBalance: { amount: '1.00', currency: 'USD' },
    });

    expect(second.balance.currency).toBe('USD');
  });

  test('rejects a negative initial balance', async () => {
    const { useCase } = setup();

    await expect(
      useCase.execute({ playerId: PLAYER, initialBalance: { amount: '-1.00', currency: 'BRL' } }),
    ).rejects.toBeInstanceOf(InvalidMoneyError);
  });
});
