import {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  PendingReferenceRepository,
  WagerTransactionRepository,
  WalletRepository,
} from './repositories';

/** Repositories bound to one SQL transaction. Valid only inside UnitOfWork.run. */
export interface TransactionContext {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly outbox: OutboxRepository;
  readonly inbox: InboxRepository;
  readonly pendingReferences: PendingReferenceRepository;
}

export interface UnitOfWork {
  /** Runs the work in one transaction: commit when it resolves, roll back when it throws. */
  run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T>;
}
