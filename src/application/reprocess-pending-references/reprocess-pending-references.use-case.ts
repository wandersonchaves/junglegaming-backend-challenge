import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import { EventContext, IntegrationEvent } from '../events/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../events/wager-events';
import { Clock, IdGenerator } from '../ports/clock-and-ids';
import { UnitOfWork } from '../ports/unit-of-work';
import { decideWagerTransaction } from '../wager-decision';

/** After this many attempts without finding the reference, the reversal is rejected (about 25 minutes). */
export const MAX_REFERENCE_ATTEMPTS = 10;
/** Wait before the first retry of a reversal that arrived early. */
export const FIRST_REFERENCE_RETRY_MS = 5_000;
const BASE_DELAY_MS = FIRST_REFERENCE_RETRY_MS;
const MAX_DELAY_MS = 5 * 60_000;

/** Wait before the next attempt: 5s, 10s, 20s, ... capped at 5 minutes. */
export function referenceRetryDelayMs(attempts: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** Math.max(attempts - 1, 0), MAX_DELAY_MS);
}

export interface ReprocessResult {
  checked: number;
  processed: number;
  rejected: number;
  stillWaiting: number;
}

export class ReprocessPendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batchSize = 20,
  ) { }

  async execute(): Promise<ReprocessResult> {
    const due = await this.uow.run((ctx) => ctx.pendingReferences.findDue(this.batchSize, this.clock.now()));
    const result: ReprocessResult = { checked: 0, processed: 0, rejected: 0, stillWaiting: 0 };

    for (const item of due) {
      const outcome = await this.reprocessOne(item.transactionId, item.walletId);
      if (outcome === 'skipped') continue;
      result.checked += 1;
      if (outcome === 'processed') result.processed += 1;
      else if (outcome === 'rejected') result.rejected += 1;
      else result.stillWaiting += 1;
    }
    return result;
  }

  private reprocessOne(
    transactionId: string,
    walletId: string,
  ): Promise<'processed' | 'rejected' | 'waiting' | 'skipped'> {
    return this.uow.run(async (ctx) => {
      // Same lock order as the submit use case: wallet first, then the transaction row.
      const wallet = await ctx.wallets.findByIdForUpdate(walletId);
      const pending = await ctx.pendingReferences.lock(transactionId);
      if (!wallet || !pending) return 'skipped';

      const { transaction: tx, attempts } = pending;
      const now = this.clock.now();
      const previousVersion = wallet.version;
      const eventContext = (): EventContext => ({
        eventId: this.ids.next(),
        correlationId: tx.id,
        occurredAt: now,
      });
      const events: IntegrationEvent<unknown>[] = [];

      const outcome = await decideWagerTransaction(ctx, tx, wallet, this.ids, now);

      if (outcome.type === 'pending') {
        const next = attempts + 1;
        if (next < MAX_REFERENCE_ATTEMPTS) {
          await ctx.pendingReferences.recordAttempt(
            tx.id,
            next,
            new Date(now.getTime() + referenceRetryDelayMs(next)),
          );
          return 'waiting';
        }
        tx.reject(FailureCode.ReferenceNotFound);
        events.push(WagerTransactionRejected.from(tx, eventContext()));
        await ctx.transactions.update(tx);
        await ctx.outbox.add(events);
        return 'rejected';
      }

      if (outcome.type === 'rejected') {
        tx.reject(outcome.code);
        events.push(WagerTransactionRejected.from(tx, eventContext()));
        await ctx.transactions.update(tx);
        await ctx.outbox.add(events);
        return 'rejected';
      }

      tx.markProcessed(outcome.reference?.id, now, wallet.balance);
      events.push(WagerTransactionProcessed.from(tx, eventContext()));
      if (outcome.entry) events.push(WalletBalanceChanged.from(wallet, outcome.entry, eventContext()));
      await ctx.transactions.update(tx);
      if (outcome.entry) {
        await ctx.ledger.insert(outcome.entry);
        await ctx.wallets.save(wallet, previousVersion);
      }
      await ctx.outbox.add(events);
      return tx.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
    });
  }
}
