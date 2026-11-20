import { InsufficientFundsError } from '../domain/errors/domain.error';
import { FailureCode } from '../domain/wager/failure-code';
import { WagerTransaction } from '../domain/wager/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager/wager-transaction-status';
import { Wallet } from '../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet/wallet-ledger-entry';
import { IdGenerator } from './ports/clock-and-ids';
import { TransactionContext } from './ports/unit-of-work';

export type Outcome =
  | { type: 'applied'; entry?: WalletLedgerEntry; reference?: WagerTransaction }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending' };

/**
 * The business rules for one transaction against a locked wallet.
 * Shared by the submit use case and by the worker that retries pending references.
 * It mutates the wallet only when the movement is allowed.
 */
export async function decideWagerTransaction(
  ctx: TransactionContext,
  tx: WagerTransaction,
  wallet: Wallet,
  ids: IdGenerator,
  now: Date,
): Promise<Outcome> {
  let reference: WagerTransaction | undefined;

  if (tx.requiresReference()) {
    reference =
      (await ctx.transactions.findByProviderExternalId(
        tx.providerId,
        tx.referenceExternalTransactionId as string,
      )) ?? undefined;

    // The reference may still be on its way: wait for it instead of rejecting.
    if (
      !reference ||
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { type: 'pending' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { type: 'rejected', code: FailureCode.ReferenceNotProcessed };
    }

    const mismatch = tx.checkReference(reference);
    if (mismatch) return { type: 'rejected', code: mismatch };

    if (await ctx.transactions.hasProcessedReversal(reference.id, tx.kind)) {
      return { type: 'rejected', code: FailureCode.ReferenceAlreadyReversed };
    }
  }

  if (!tx.affectsBalance()) return { type: 'applied', reference };

  const movement = {
    entryId: ids.next(),
    transactionId: tx.id,
    money: tx.money,
    at: now,
  };
  try {
    const entry =
      tx.ledgerDirectionFor(reference) === LedgerDirection.Debit
        ? wallet.debit(movement)
        : wallet.credit(movement);
    return { type: 'applied', entry, reference };
  } catch (error) {
    if (error instanceof InsufficientFundsError) {
      // A reversal that would overdraw is a different situation from a bet without funds.
      const code = tx.requiresReference()
        ? FailureCode.ReversalWouldOverdraw
        : FailureCode.InsufficientFunds;
      return { type: 'rejected', code };
    }
    throw error;
  }
}
