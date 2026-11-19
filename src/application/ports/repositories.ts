import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { IntegrationEvent } from '../events/integration-event';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** Reads the wallet and holds a row lock until the surrounding transaction ends. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** Throws UniqueViolationError when the player already has a wallet in that currency. */
  insert(wallet: Wallet): Promise<void>;
  /** Persists balance and version. Throws ConcurrentModificationError if the version moved. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null>;
  /** Throws UniqueViolationError on a duplicate idempotency key or provider id. */
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
  hasProcessedReversal(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
}

export interface OutboxRepository {
  add(events: ReadonlyArray<IntegrationEvent<unknown>>): Promise<void>;
}
