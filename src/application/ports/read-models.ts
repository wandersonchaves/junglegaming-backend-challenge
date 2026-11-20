import { MoneyProps } from '../../domain/money/money';

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  status: string;
  failureCode: string | null;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  balanceAfter: MoneyProps | null;
  createdAt: string;
  processedAt: string | null;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/** Read side: answers queries without going through the domain objects. */
export interface ReadModel {
  findWallet(id: string): Promise<WalletView | null>;
  /** null when the wallet does not exist. The cursor is opaque to callers. */
  listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage | null>;
  findTransaction(id: string): Promise<TransactionView | null>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | null>;
  /** Compares the stored balance with the one rebuilt from the ledger. Never changes data. */
  reconcile(walletId: string): Promise<ReconciliationView | null>;
}
