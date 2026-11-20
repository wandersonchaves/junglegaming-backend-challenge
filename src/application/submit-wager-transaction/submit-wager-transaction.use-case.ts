import { CurrencyMismatchError } from '../../domain/errors/domain.error';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';
import type { Wallet } from '../../domain/wallet/wallet';
import { IdempotencyConflictError, UniqueViolationError, WalletNotFoundError, WalletPlayerMismatchError } from '../errors';
import type { EventContext, IntegrationEvent } from '../events/integration-event';
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../events/wager-events';
import { hashPayload } from '../payload-hash';
import { Clock, IdGenerator } from '../ports/clock-and-ids';
import { UnitOfWork, type TransactionContext } from '../ports/unit-of-work';
import { decideWagerTransaction } from '../wager-decision';

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

/** Present when the request came from a queue message: the message is recorded in the same transaction. */
export interface InboxEnvelope {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) { }

  async execute(
    command: SubmitWagerTransactionCommand,
    inbox?: InboxEnvelope,
  ): Promise<SubmitWagerTransactionResult> {
    const payloadHash = hashPayload(command);
    // Fails fast on invalid input (OPENING, zero amount, missing reference) before touching the database.
    this.buildTransaction(command, payloadHash);

    try {
      return await this.attempt(command, payloadHash, inbox);
    } catch (error) {
      // Two requests with the same key passed the check at once and one lost the unique constraint.
      // The winner is committed by now, so a second attempt finds it and answers as a replay.
      if (error instanceof UniqueViolationError) {
        return this.attempt(command, payloadHash, inbox);
      }
      throw error;
    }
  }

  private attempt(
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    inbox?: InboxEnvelope,
  ): Promise<SubmitWagerTransactionResult> {
    return this.uow.run(async (ctx) => {
      const message = inbox
        ? InboxMessage.receive({ ...inbox, receivedAt: this.clock.now() })
        : undefined;

      // The inbox row is written in this very transaction, so a message that is in the inbox
      // was also fully processed: redelivered copies are answered without doing the work again.
      if (message && !(await ctx.inbox.tryReceive(message))) {
        const known = await this.findExisting(ctx, command);
        if (known) return this.replay(known, command, payloadHash);
        throw new IdempotencyConflictError('this message id was already consumed for another transaction');
      }

      const result = await this.handle(ctx, command, payloadHash);

      if (message) {
        message.markProcessed(this.clock.now());
        await ctx.inbox.markProcessed(message);
      }
      return result;
    });
  }

  private async handle(
    ctx: TransactionContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
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

    const outcome = await decideWagerTransaction(ctx, tx, wallet, this.ids, now);

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
