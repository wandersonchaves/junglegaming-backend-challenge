import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError } from '../errors/domain.error';
import { Money } from '../money/money';
import { LedgerDirection } from './wallet-ledger-entry';
import { Wallet } from './wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-18T12:00:00.000Z');

const openWallet = (initial = '100.00') =>
  Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(initial), now });

const movement = (amount: string, n = 1) => ({
  entryId: `entry-${n}`,
  transactionId: `tx-${n}`,
  money: brl(amount),
  at: now,
});

describe('Wallet.open', () => {
  it('starts at version 1 with the initial balance and currency', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.debit', () => {
  it('reduces the balance, bumps the version and returns a matching ledger entry', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(movement('25.00'));

    expect(wallet.balance.toString()).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('75.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('allows spending the exact balance', () => {
    const wallet = openWallet('80.00');
    wallet.debit(movement('80.00'));
    expect(wallet.balance.toString()).toBe('0.00');
  });

  it('refuses to go negative and leaves the wallet untouched', () => {
    const wallet = openWallet('100.00');
    wallet.debit(movement('80.00', 1));

    expect(() => wallet.debit(movement('80.00', 2))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  it('refuses a movement in another currency', () => {
    const wallet = openWallet();
    const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.debit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.credit', () => {
  it('increases the balance, bumps the version and returns a matching ledger entry', () => {
    const wallet = openWallet('10.00');
    const entry = wallet.credit(movement('15.50'));

    expect(wallet.balance.toString()).toBe('25.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('10.00');
    expect(entry.balanceAfter.toString()).toBe('25.50');
  });

  it('refuses a movement in another currency', () => {
    const wallet = openWallet();
    const usd = { ...movement('1.00'), money: Money.from({ amount: '1.00', currency: 'USD' }) };
    expect(() => wallet.credit(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet invariant', () => {
  it('balance always equals the initial balance plus the ledger entries', () => {
    const wallet = openWallet('100.00');
    const entries = [wallet.debit(movement('30.00', 1)), wallet.credit(movement('5.25', 2)), wallet.debit(movement('10.10', 3))];

    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Debit ? acc.subtract(e.money) : acc.add(e.money)),
      brl('100.00'),
    );
    expect(wallet.balance.equals(rebuilt)).toBe(true);
  });
});

describe('Wallet.rehydrate', () => {
  it('restores persisted state as is', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: now,
      updatedAt: now,
    });
    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});
