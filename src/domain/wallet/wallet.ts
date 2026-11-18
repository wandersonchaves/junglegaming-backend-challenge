import { Money } from '../money/money';
import { WalletLedgerEntry } from './wallet-ledger-entry';

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

const NOT_IMPLEMENTED = 'not implemented';

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(_props: OpenWalletProps): Wallet {
    throw new Error(NOT_IMPLEMENTED);
  }

  static rehydrate(_state: WalletState): Wallet {
    throw new Error(NOT_IMPLEMENTED);
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
  debit(_movement: MovementProps): WalletLedgerEntry {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Adds money and returns the matching ledger entry. */
  credit(_movement: MovementProps): WalletLedgerEntry {
    throw new Error(NOT_IMPLEMENTED);
  }
}
