import { SqlEntityManager } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { LedgerRepository } from '../../../application/ports/repositories';

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly em: SqlEntityManager) { }

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.execute(
      `insert into wallet_ledger_entries
         (id, wallet_id, transaction_id, direction, amount, currency,
          balance_before, balance_after, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.walletId,
        entry.transactionId,
        entry.direction,
        entry.money.toString(),
        entry.money.currency,
        entry.balanceBefore.toString(),
        entry.balanceAfter.toString(),
        entry.createdAt,
      ],
      'run',
    );
  }
}
