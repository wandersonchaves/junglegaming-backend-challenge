import { describe, expect, it } from 'bun:test';
import { InvalidLedgerEntryError } from '../errors/domain.error';
import { Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-18T12:00:00.000Z');

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  createdAt: at,
};

describe('WalletLedgerEntry.create', () => {
  it('accepts a balanced debit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('accepts a balanced credit', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('75.00'),
      balanceAfter: brl('100.00'),
    });
    expect(entry.isBalanced()).toBe(true);
  });

  it('rejects an entry whose arithmetic does not add up', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  it('rejects a zero or negative amount', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('10.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});
