import { SqlEntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import { ConcurrentModificationError } from '../../../application/errors';
import { WalletRepository } from '../../../application/ports/repositories';
import { asDate } from '../row-mapping';
import { LOCK_CONFLICT_THRESHOLD_SECONDS, metrics } from '../../observability/metrics';

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.player_id,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  });
}

export class PgWalletRepository implements WalletRepository {
  constructor(private readonly em: SqlEntityManager) { }

  async findById(id: string): Promise<Wallet | null> {
    const rows = await this.em.execute<WalletRow[]>('select * from wallets where id = ?', [id]);
    return rows[0] ? toWallet(rows[0]) : null;
  }

  /** Row lock per wallet: other transactions on the same wallet wait here, other wallets do not. */
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    const startedAt = performance.now();
    const rows = await this.em.execute<WalletRow[]>(
      'select * from wallets where id = ? for update',
      [id],
    );
    const waited = (performance.now() - startedAt) / 1000;
    metrics.lockWaitSeconds.observe(waited);
    if (waited > LOCK_CONFLICT_THRESHOLD_SECONDS) metrics.lockConflicts.inc();
    return rows[0] ? toWallet(rows[0]) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.execute(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?)`,
      [
        wallet.id,
        wallet.playerId,
        wallet.currency,
        wallet.balance.toString(),
        wallet.version,
        wallet.createdAt,
        wallet.updatedAt,
      ],
      'run',
    );
  }

  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const result = await this.em.execute<{ affectedRows: number }>(
      `update wallets set balance = ?, version = ?, updated_at = ?
       where id = ? and version = ?`,
      [wallet.balance.toString(), wallet.version, wallet.updatedAt, wallet.id, expectedVersion],
      'run',
    );
    if (result.affectedRows !== 1) throw new ConcurrentModificationError(wallet.id);
  }
}
