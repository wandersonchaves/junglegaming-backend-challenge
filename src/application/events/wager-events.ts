import { MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wager/failure-code';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import { Wallet } from '../../domain/wallet/wallet';
import { EventContext, IntegrationEvent } from './integration-event';

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: string;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  balanceAfter: MoneyProps | null;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), balanceAfter: tx.balanceAfter?.toJSON() ?? null },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: tx.id,
      data: { ...transactionData(tx), failureCode: tx.failureCode as FailureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: tx.id,
      data: {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId as string,
      },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}
