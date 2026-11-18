import { InvalidLedgerEntryError } from '../errors/domain.error';
import { Money } from '../money/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) { }

  /** Validates the arithmetic: balanceBefore -/+ money === balanceAfter. */
  static create(state: LedgerEntryState): WalletLedgerEntry {
    if (!state.money.isPositive()) {
      throw new InvalidLedgerEntryError('amount must be greater than zero');
    }
    const entry = WalletLedgerEntry.rehydrate(state);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError('balances do not match the amount and direction');
    }
    return entry;
  }

  /** Rebuilds an entry already persisted. Does not validate again. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}
