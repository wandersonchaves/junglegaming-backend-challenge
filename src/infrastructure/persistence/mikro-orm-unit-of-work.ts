import { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import { TransactionContext, UnitOfWork } from '../../application/ports/unit-of-work';
import { mapDatabaseError } from './database-errors';
import { PgLedgerRepository } from './repositories/ledger.repository';
import { PgOutboxRepository } from './repositories/outbox.repository';
import { PgWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { PgWalletRepository } from './repositories/wallet.repository';

/**
 * One SQL transaction per run. A forked EntityManager keeps each request isolated,
 * and every repository shares the transaction's connection.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly orm: MikroORM) { }

  async run<T>(work: (ctx: TransactionContext) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        const sql = em as SqlEntityManager;
        return work({
          wallets: new PgWalletRepository(sql),
          transactions: new PgWagerTransactionRepository(sql),
          ledger: new PgLedgerRepository(sql),
          outbox: new PgOutboxRepository(sql),
        });
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }
}
