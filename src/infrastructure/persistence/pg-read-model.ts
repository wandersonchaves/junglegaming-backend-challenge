import { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import {
  LedgerEntryView,
  LedgerPage,
  ReadModel,
  ReconciliationView,
  TransactionView,
  WalletView,
} from '../../application/ports/read-models';
import { InvalidCursorError } from '../../application/errors';
import { asDate } from './row-mapping';

const money = (amount: string, currency: string) => ({ amount, currency });
const iso = (value: Date | string | null): string | null => (value ? asDate(value).toISOString() : null);

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  failure_code: string | null;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  balance_after: string | null;
  created_at: Date | string;
  processed_at: Date | string | null;
}

const toTransactionView = (r: TransactionRow): TransactionView => ({
  id: r.id,
  providerId: r.provider_id,
  externalTransactionId: r.external_transaction_id,
  walletId: r.wallet_id,
  playerId: r.player_id,
  roundId: r.round_id,
  gameId: r.game_id,
  kind: r.kind,
  money: money(r.amount, r.currency),
  status: r.status,
  failureCode: r.failure_code,
  referenceExternalTransactionId: r.reference_external_transaction_id,
  referenceTransactionId: r.reference_transaction_id,
  balanceAfter: r.balance_after ? money(r.balance_after, r.currency) : null,
  createdAt: asDate(r.created_at).toISOString(),
  processedAt: iso(r.processed_at),
});

interface Cursor {
  createdAt: string;
  id: string;
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(raw: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof value.createdAt === 'string' && typeof value.id === 'string') return value;
  } catch {
    // falls through to the error below
  }
  throw new InvalidCursorError('cursor is not valid');
}

export class PgReadModel implements ReadModel {
  constructor(private readonly orm: MikroORM) { }

  private get em(): SqlEntityManager {
    return this.orm.em.fork() as SqlEntityManager;
  }

  async findWallet(id: string): Promise<WalletView | null> {
    const [row] = await this.em.execute<
      { id: string; player_id: string; currency: string; balance: string; version: number; created_at: Date | string; updated_at: Date | string }[]
    >('select * from wallets where id = ?', [id]);
    if (!row) return null;
    return {
      id: row.id,
      playerId: row.player_id,
      balance: money(row.balance, row.currency),
      version: row.version,
      createdAt: asDate(row.created_at).toISOString(),
      updatedAt: asDate(row.updated_at).toISOString(),
    };
  }

  /** Keyset pagination on (created_at, id): stable while new entries are appended. */
  async listLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPage | null> {
    const em = this.em;
    const exists = await em.execute<{ found: number }[]>('select 1 as found from wallets where id = ?', [walletId]);
    if (exists.length === 0) return null;

    const after = cursor ? decodeCursor(cursor) : undefined;
    const rows = await em.execute<
      {
        id: string;
        transaction_id: string;
        direction: string;
        amount: string;
        currency: string;
        balance_before: string;
        balance_after: string;
        created_at: Date | string;
        created_at_text: string;
      }[]
    >(
      `select *, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_text
         from wallet_ledger_entries
        where wallet_id = ?
          ${after ? 'and (created_at, id) > (?::timestamptz, ?::uuid)' : ''}
        order by created_at, id
        limit ?`,
      after ? [walletId, after.createdAt, after.id, limit + 1] : [walletId, limit + 1],
    );

    const pageRows = rows.slice(0, limit);
    const items: LedgerEntryView[] = pageRows.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      direction: r.direction,
      money: money(r.amount, r.currency),
      balanceBefore: money(r.balance_before, r.currency),
      balanceAfter: money(r.balance_after, r.currency),
      createdAt: asDate(r.created_at).toISOString(),
    }));
    const last = pageRows[pageRows.length - 1];
    const hasMore = rows.length > limit && last !== undefined;
    return {
      items,
      nextCursor: hasMore ? encodeCursor({ createdAt: last.created_at_text, id: last.id }) : null,
    };
  }

  async findTransaction(id: string): Promise<TransactionView | null> {
    const [row] = await this.em.execute<TransactionRow[]>('select * from wager_transactions where id = ?', [id]);
    return row ? toTransactionView(row) : null;
  }

  async findTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<TransactionView | null> {
    const [row] = await this.em.execute<TransactionRow[]>(
      'select * from wager_transactions where provider_id = ? and external_transaction_id = ?',
      [providerId, externalTransactionId],
    );
    return row ? toTransactionView(row) : null;
  }

  async reconcile(walletId: string): Promise<ReconciliationView | null> {
    // One statement, one snapshot: the balance and the ledger sum are read at the same instant.
    const [row] = await this.em.execute<
      { currency: string; stored: string; calculated: string; difference: string; entries: string }[]
    >(
      `select w.currency,
              w.balance::text as stored,
              round(coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0), 2)::text as calculated,
              (w.balance - coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0))::text as difference,
              count(l.id)::text as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id`,
      [walletId],
    );
    if (!row) return null;
    return {
      walletId,
      storedBalance: money(row.stored, row.currency),
      calculatedBalance: money(row.calculated, row.currency),
      difference: money(row.difference, row.currency),
      consistent: Number(row.difference) === 0,
      checkedEntries: Number(row.entries),
    };
  }
}
