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

const NOT_IMPLEMENTED = 'not implemented';

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
  ) {}

  /** Validates the arithmetic: balanceBefore -/+ money === balanceAfter. */
  static create(_state: LedgerEntryState): WalletLedgerEntry {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Rebuilds an entry already persisted. Does not validate again. */
  static rehydrate(_state: LedgerEntryState): WalletLedgerEntry {
    throw new Error(NOT_IMPLEMENTED);
  }

  isBalanced(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }
}
