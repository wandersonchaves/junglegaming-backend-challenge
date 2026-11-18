import { Money } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';
import { CurrencyMismatchError, InsufficientFundsError } from '../errors/domain.error';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
}

export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) { }

  static open(props: OpenWalletProps): Wallet {
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    )
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    )
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Subtracts money and returns the matching ledger entry. */
  debit(movement: MovementProps): WalletLedgerEntry {
    return this.apply(movement, LedgerDirection.Debit)
  }

  /** Adds money and returns the matching ledger entry. */
  credit(movement: MovementProps): WalletLedgerEntry {
    return this.apply(movement, LedgerDirection.Credit)
  }

  private apply(movement: MovementProps, direction: LedgerDirection): WalletLedgerEntry {
    if (movement.money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `wallet is in ${this.currency}, movement is in ${movement.money.currency}`,
      );
    }

    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this._balance.subtract(movement.money)
        : this._balance.add(movement.money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError('balance is not enough for this movement');
    }

    const entry = WalletLedgerEntry.create({
      id: movement.entryId,
      walletId: this.id,
      transactionId: movement.transactionId,
      direction,
      money: movement.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: movement.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = movement.at;

    return entry;
  }
}
