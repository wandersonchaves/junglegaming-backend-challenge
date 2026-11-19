import { CurrencyMismatchError, InsufficientFundsError } from '../../domain/errors/domain.error';
import { Money, MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { Clock, IdGenerator } from '../ports/clock-and-ids';
import { UnitOfWork, type TransactionContext } from '../ports/unit-of-work';
import { IdempotencyConflictError, UniqueViolationError, WalletNotFoundError, WalletPlayerMismatchError } from '../errors';
import type { EventContext, IntegrationEvent } from '../events/integration-event';
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../events/wager-events';
import { hashPayload } from '../payload-hash';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

type Outcome =
  | { type: 'applied'; entry?: WalletLedgerEntry; reference?: WagerTransaction }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending' };

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) { }

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const payloadHash = hashPayload(command);
    // Fails fast on invalid input (OPENING, zero amount, missing reference) before touching the database.
    this.buildTransaction(command, payloadHash);

    try {
      return await this.attempt(command, payloadHash);
    } catch (error) {
      // Two requests with the same key passed the check at once and one lost the unique constraint.
      // The winner is committed by now, so a second attempt finds it and answers as a replay.
      if (error instanceof UniqueViolationError) {
        return this.attempt(command, payloadHash);
      }
      throw error;
    }
  }

  private attempt(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    return this.uow.run(async (ctx) => {
      // Replays answer without taking the wallet lock.
      const known = await this.findExisting(ctx, command);
      if (known) return this.replay(known, command, payloadHash);

      const wallet = await ctx.wallets.findByIdForUpdate(command.walletId);
      if (!wallet) throw new WalletNotFoundError(`wallet ${command.walletId} does not exist`);

      // Requests with the same key queue on the lock. Whoever got in first already committed,
      // so look again now that the lock is ours.
      const committed = await this.findExisting(ctx, command);
      if (committed) return this.replay(committed, command, payloadHash);

      if (wallet.playerId !== command.playerId) {
        throw new WalletPlayerMismatchError('wallet does not belong to this player');
      }
      if (wallet.currency !== command.money.currency) {
        throw new CurrencyMismatchError(
          `wallet is in ${wallet.currency}, transaction is in ${command.money.currency}`,
        );
      }

      return this.process(ctx, command, payloadHash, wallet);
    });
  }

  private async process(
    ctx: TransactionContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    wallet: Wallet,
  ): Promise<SubmitWagerTransactionResult> {
    const tx = this.buildTransaction(command, payloadHash);
    const now = this.clock.now();
    const previousVersion = wallet.version;

    const outcome = await this.decide(ctx, tx, wallet, now);

    const events: IntegrationEvent<unknown>[] = [];
    const eventContext = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId ?? tx.id,
      occurredAt: now,
    });

    switch (outcome.type) {
      case 'applied':
        tx.markProcessed(outcome.reference?.id, now, wallet.balance);
        events.push(WagerTransactionProcessed.from(tx, eventContext()));
        if (outcome.entry) {
          events.push(WalletBalanceChanged.from(wallet, outcome.entry, eventContext()));
        }
        break;
      case 'rejected':
        tx.reject(outcome.code);
        events.push(WagerTransactionRejected.from(tx, eventContext()));
        break;
      case 'pending':
        tx.markPendingReference();
        events.push(WagerTransactionPendingReference.from(tx, eventContext()));
        break;
    }

    // The transaction goes in with its final status (the ledger points at it),
    // then the ledger entry and the new balance, then the events. One SQL transaction.
    await ctx.transactions.insert(tx);
    if (outcome.type === 'applied' && outcome.entry) {
      await ctx.ledger.insert(outcome.entry);
      await ctx.wallets.save(wallet, previousVersion);
    }
    await ctx.outbox.add(events);

    return this.toResult(tx, false);
  }

  /** Applies the business rules and mutates the wallet only when the movement is allowed. */
  private async decide(
    ctx: TransactionContext,
    tx: WagerTransaction,
    wallet: Wallet,
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
      entryId: this.ids.next(),
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

  private async findExisting(
    ctx: TransactionContext,
    command: SubmitWagerTransactionCommand,
  ): Promise<WagerTransaction | null> {
    return (
      (await ctx.transactions.findByIdempotencyKey(command.idempotencyKey)) ??
      (await ctx.transactions.findByProviderExternalId(
        command.providerId,
        command.externalTransactionId,
      ))
    );
  }

  private replay(
    existing: WagerTransaction,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): SubmitWagerTransactionResult {
    if (existing.idempotencyKey !== command.idempotencyKey || !existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        'this idempotency key or external transaction id was already used with a different payload',
      );
    }
    return this.toResult(existing, true);
  }

  private toResult(tx: WagerTransaction, idempotentReplay: boolean): SubmitWagerTransactionResult {
    return {
      transactionId: tx.id,
      status: tx.status,
      failureCode: tx.failureCode,
      balance: tx.balanceAfter?.toJSON(),
      idempotentReplay,
    };
  }

  private buildTransaction(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: Money.from(command.money),
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: this.clock.now(),
    });
  }
}
