import { TransactionNotFoundError, WalletNotFoundError } from '../errors';
import {
  LedgerPage,
  ReadModel,
  ReconciliationView,
  TransactionView,
  WalletView,
} from '../ports/read-models';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export class WagerQueries {
  constructor(private readonly reads: ReadModel) { }

  async getWallet(id: string): Promise<WalletView> {
    const wallet = await this.reads.findWallet(id);
    if (!wallet) throw new WalletNotFoundError(`wallet ${id} does not exist`);
    return wallet;
  }

  async listLedger(walletId: string, cursor: string | undefined, limit = DEFAULT_LEDGER_LIMIT): Promise<LedgerPage> {
    const page = await this.reads.listLedger(
      walletId,
      cursor,
      Math.min(Math.max(limit, 1), MAX_LEDGER_LIMIT),
    );
    if (!page) throw new WalletNotFoundError(`wallet ${walletId} does not exist`);
    return page;
  }

  async getTransaction(id: string): Promise<TransactionView> {
    const transaction = await this.reads.findTransaction(id);
    if (!transaction) throw new TransactionNotFoundError(`transaction ${id} does not exist`);
    return transaction;
  }

  async getTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView> {
    const transaction = await this.reads.findTransactionByExternalId(providerId, externalTransactionId);
    if (!transaction) {
      throw new TransactionNotFoundError(`transaction ${providerId}/${externalTransactionId} does not exist`);
    }
    return transaction;
  }

  async reconcile(walletId: string): Promise<ReconciliationView> {
    const result = await this.reads.reconcile(walletId);
    if (!result) throw new WalletNotFoundError(`wallet ${walletId} does not exist`);
    return result;
  }
}
