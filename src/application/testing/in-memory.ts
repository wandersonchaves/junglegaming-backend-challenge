import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { Wallet } from '../../domain/wallet/wallet';
import { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { FIRST_REFERENCE_RETRY_MS } from '../reprocess-pending-references/reprocess-pending-references.use-case';
import { ConcurrentModificationError, UniqueViolationError } from '../errors';
import { IntegrationEvent } from '../events/integration-event';
import { Clock, IdGenerator } from '../ports/clock-and-ids';
import { OutboxBatchStore, OutboxBatchWork } from '../ports/outbox-publishing';
import { TransactionContext, UnitOfWork } from '../ports/unit-of-work';

/** Test doubles for the application layer. Not used in production code. */
export class InMemoryStore {
  wallets = new Map<string, Wallet>();
  transactions = new Map<string, WagerTransaction>();
  ledger: WalletLedgerEntry[] = [];
  events: IntegrationEvent<unknown>[] = [];
  inbox = new Map<string, InboxMessage>();
  /** attempts and next attempt for transactions waiting for a reference */
  pending = new Map<string, { attempts: number; nextAttemptAt: Date }>();
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
      inbox: new Map(s.inbox),
      pending: new Map(s.pending),
    };
    try {
      return await work(this.context());
    } catch (error) {
      s.wallets = snapshot.wallets;
      s.transactions = snapshot.transactions;
      s.ledger = snapshot.ledger;
      s.events = snapshot.events;
      s.inbox = snapshot.inbox;
      s.pending = snapshot.pending;
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
      inbox: {
        tryReceive: async (message) => {
          const key = `${message.consumerName}/${message.messageId}`;
          if (s.inbox.has(key)) return false;
          s.inbox.set(key, message);
          return true;
        },
        markProcessed: async () => { },
      },
      pendingReferences: {
        findDue: async (limit, now) =>
          [...s.transactions.values()]
            .filter((t) => t.status === WagerTransactionStatus.PendingReference)
            .map((t) => ({
              tx: t,
              record: s.pending.get(t.id) ?? {
                attempts: 0,
                nextAttemptAt: new Date(t.createdAt.getTime() + FIRST_REFERENCE_RETRY_MS),
              },
            }))
            .filter(({ record }) => record.nextAttemptAt.getTime() <= now.getTime())
            .slice(0, limit)
            .map(({ tx, record }) => ({
              transactionId: tx.id,
              walletId: tx.walletId,
              attempts: record.attempts,
            })),
        lock: async (id) => {
          const tx = s.transactions.get(id);
          if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return null;
          return { transaction: tx, attempts: s.pending.get(id)?.attempts ?? 0 };
        },
        recordAttempt: async (id, attempts, nextAttemptAt) => {
          s.pending.set(id, { attempts, nextAttemptAt });
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


/** Outbox store for tests: keeps OutboxMessage objects and hands out the due ones. */
export class InMemoryOutboxStore implements OutboxBatchStore {
  readonly messages: OutboxMessage[] = [];
  private claimed = new Set<string>();

  async claim<T>(limit: number, now: Date, work: OutboxBatchWork<T>): Promise<T> {
    const due = this.messages
      .filter((m) => m.isDue(now) && !this.claimed.has(m.id))
      .slice(0, limit);
    due.forEach((m) => this.claimed.add(m.id));
    try {
      return await work(due, async () => { });
    } finally {
      due.forEach((m) => this.claimed.delete(m.id));
    }
  }

  async lagSeconds(now: Date): Promise<number> {
    const pending = this.messages.filter((m) => m.isPending());
    if (pending.length === 0) return 0;
    const oldest = Math.min(...pending.map((m) => m.occurredAt.getTime()));
    return Math.max(0, (now.getTime() - oldest) / 1000);
  }
}
