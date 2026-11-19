import { createHash } from 'node:crypto';
import { Money, MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { UniqueViolationError, WalletAlreadyExistsError } from '../errors';
import type { EventContext } from '../events/integration-event';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../events/wager-events';
import { Clock, IdGenerator } from '../ports/clock-and-ids';
import { UnitOfWork } from '../ports/unit-of-work';

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) { }

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialBalance = Money.from(command.initialBalance)
    const now = this.clock.now()
    const wallet = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      now,
    })

    try {
      await this.uow.run(async (ctx) => {
        await ctx.wallets.insert(wallet)
        if (!initialBalance.isPositive()) return;

        // The opening credit is a normal transaction with its own ledger entry,
        // written in the same SQL transaction as the wallet.
        const key = `opening:${wallet.id}`
        const opening = WagerTransaction.createOpening({
          id: this.ids.next(),
          providerId: 'system',
          externalTransactionId: key,
          idempotencyKey: key,
          payloadHash: createHash('sha256').update(key).digest('hex'),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'opening',
          gameId: 'opening',
          money: initialBalance,
          createdAt: now,
        })
        opening.markProcessed(undefined, now, initialBalance)
        await ctx.transactions.insert(opening)

        const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: initialBalance,
          createdAt: now,
        })
        await ctx.ledger.insert(entry)

        const event: EventContext = {
          eventId: this.ids.next(),
          correlationId: opening.id,
          occurredAt: now,
        }
        await ctx.outbox.add([
          WagerTransactionProcessed.from(opening, event),
          WalletBalanceChanged.from(wallet, entry, { ...event, eventId: this.ids.next() })
        ])
      })
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        throw new WalletAlreadyExistsError(`player ${command.playerId} already has a ${initialBalance.currency} wallet`)
      }
      throw error;
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    }
  }
}
