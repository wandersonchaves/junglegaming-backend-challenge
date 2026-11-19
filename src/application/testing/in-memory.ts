import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { ConcurrentModificationError, UniqueViolationError } from '../errors';
import { IntegrationEvent } from '../events/integration-event';
import { Clock, IdGenerator } from '../ports/clock-and-ids';
import { TransactionContext, UnitOfWork } from '../ports/unit-of-work';

/** Test doubles for the application layer. Not used in production code. */
export class InMemoryStore {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
}

const cloneWallet = (w: Wallet): Wallet =>
  Wallet.rehydrate({
    id: w.id,
    playerId: w.playerId,
    currency: w.currency,
    balance: w.balance,
    version: w.version,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  });

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(public readonly store = new InMemoryStore()) { }

  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    const s = this.store;
    const snapshot = {
      wallets: new Map([...s.wallets].map(([k, v]) => [k, cloneWallet(v)] as const)),
      transactions: new Map(s.transactions),
      ledger: [...s.ledger],
      events: [...s.events],
    };
    try {
      return await work(this.context());
    } catch (error) {
      s.wallets = snapshot.wallets;
      s.transactions = snapshot.transactions;
      s.ledger = snapshot.ledger;
      s.events = snapshot.events;
      throw error;
    }
  }

  private context(): TransactionContext {
    const s = this.store;
    return {
      wallets: {
        findById: async (id) => (s.wallets.has(id) ? cloneWallet(s.wallets.get(id) as Wallet) : null),
        findByIdForUpdate: async (id) =>
          s.wallets.has(id) ? cloneWallet(s.wallets.get(id) as Wallet) : null,
        insert: async (wallet) => {
          const duplicate = [...s.wallets.values()].some(
            (w) => w.playerId === wallet.playerId && w.currency === wallet.currency,
          );
          if (duplicate) throw new UniqueViolationError('wallets_player_currency_key');
          s.wallets.set(wallet.id, cloneWallet(wallet));
        },
        save: async (wallet, expectedVersion) => {
          const stored = s.wallets.get(wallet.id);
          if (!stored || stored.version !== expectedVersion) {
            throw new ConcurrentModificationError(wallet.id);
          }
          s.wallets.set(wallet.id, cloneWallet(wallet));
        },
      },
      transactions: {
        findById: async (id) => s.transactions.get(id) ?? null,
        findByIdempotencyKey: async (key) =>
          [...s.transactions.values()].find((t) => t.idempotencyKey === key) ?? null,
        findByProviderExternalId: async (providerId, externalId) =>
          [...s.transactions.values()].find(
            (t) => t.providerId === providerId && t.externalTransactionId === externalId,
          ) ?? null,
        insert: async (tx) => {
          const duplicate = [...s.transactions.values()].some(
            (t) =>
              t.idempotencyKey === tx.idempotencyKey ||
              (t.providerId === tx.providerId && t.externalTransactionId === tx.externalTransactionId),
          );
          if (duplicate) throw new UniqueViolationError('wager_tx_idempotency_key_key');
          s.transactions.set(tx.id, tx);
        },
        update: async (tx) => {
          s.transactions.set(tx.id, tx);
        },
        hasProcessedReversal: async (referenceId: string, kind: WagerTransactionKind) =>
          [...s.transactions.values()].some(
            (t) =>
              t.referenceTransactionId === referenceId &&
              t.kind === kind &&
              t.status === WagerTransactionStatus.Processed,
          ),
      },
      ledger: {
        insert: async (entry) => {
          s.ledger.push(entry);
        },
      },
      outbox: {
        add: async (events) => {
          s.events.push(...events);
        },
      },
    };
  }
}

export class FixedClock implements Clock {
  constructor(private current = new Date('2026-11-19T12:00:00.000Z')) { }
  now(): Date {
    return this.current;
  }
}

export class SequentialIds implements IdGenerator {
  private counter = 0;
  next(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }
}
