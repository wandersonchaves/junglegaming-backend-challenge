import { SqlEntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../../domain/money/money';
import { FailureCode } from '../../../domain/wager/failure-code';
import { WagerTransaction } from '../../../domain/wager/wager-transaction';
import { WagerTransactionKind } from '../../../domain/wager/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status';
import { WagerTransactionRepository } from '../../../application/ports/repositories';

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  failure_code: FailureCode | null;
  balance_after: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export function toTransaction(row: TransactionRow): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.reference_external_transaction_id ?? undefined,
    createdAt: row.created_at,
    status: row.status,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: row.failure_code ?? undefined,
    processedAt: row.processed_at ?? undefined,
    balanceAfter: row.balance_after
      ? Money.from({ amount: row.balance_after, currency: row.currency })
      : undefined,
  });
}

export class PgWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: SqlEntityManager) { }

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.findOne('id = ?', [id]);
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    return this.findOne('idempotency_key = ?', [key]);
  }

  async findByProviderExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | null> {
    return this.findOne('provider_id = ? and external_transaction_id = ?', [
      providerId,
      externalTransactionId,
    ]);
  }

  async insert(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
          player_id, round_id, game_id, kind, amount, currency, status,
          reference_external_transaction_id, reference_transaction_id, failure_code,
          balance_after, created_at, processed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tx.id,
        tx.providerId,
        tx.externalTransactionId,
        tx.idempotencyKey,
        tx.payloadHash,
        tx.walletId,
        tx.playerId,
        tx.roundId,
        tx.gameId,
        tx.kind,
        tx.money.toString(),
        tx.money.currency,
        tx.status,
        tx.referenceExternalTransactionId ?? null,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.balanceAfter?.toString() ?? null,
        tx.createdAt,
        tx.processedAt ?? null,
      ],
      'run',
    );
  }

  async update(tx: WagerTransaction): Promise<void> {
    await this.em.execute(
      `update wager_transactions
          set status = ?, reference_transaction_id = ?, failure_code = ?,
              balance_after = ?, processed_at = ?
        where id = ?`,
      [
        tx.status,
        tx.referenceTransactionId ?? null,
        tx.failureCode ?? null,
        tx.balanceAfter?.toString() ?? null,
        tx.processedAt ?? null,
        tx.id,
      ],
      'run',
    );
  }

  async hasProcessedReversal(
    referenceTransactionId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    const rows = await this.em.execute<{ found: number }[]>(
      `select 1 as found from wager_transactions
        where reference_transaction_id = ? and kind = ? and status = 'PROCESSED' limit 1`,
      [referenceTransactionId, kind],
    );
    return rows.length > 0;
  }

  private async findOne(where: string, params: unknown[]): Promise<WagerTransaction | null> {
    const rows = await this.em.execute<TransactionRow[]>(
      `select * from wager_transactions where ${where}`,
      params,
    );
    return rows[0] ? toTransaction(rows[0]) : null;
  }
}
