import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { MikroORM, SqlEntityManager } from '@mikro-orm/postgresql';
import { CreateWallet } from '../../src/application/create-wallet/create-wallet.use-case';
import {
  SubmitWagerTransaction,
  SubmitWagerTransactionCommand,
} from '../../src/application/submit-wager-transaction/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import config from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { RandomUuidGenerator, SystemClock } from '../../src/infrastructure/system/system-clock';

/** Real PostgreSQL, started by `docker compose up -d` and migrated by `bun run migrate:up`. */
export async function connect() {
  const orm = await MikroORM.init(config);
  const uow = new MikroOrmUnitOfWork(orm);
  const clock = new SystemClock();
  const ids = new RandomUuidGenerator();
  const em = () => orm.em.fork() as SqlEntityManager;

  const createWallet = new CreateWallet(uow, clock, ids);
  const submit = new SubmitWagerTransaction(uow, clock, ids);

  async function openWallet(balance = '100.00') {
    const playerId = randomUUID();
    const wallet = await createWallet.execute({
      playerId,
      initialBalance: { amount: balance, currency: 'BRL' },
    });
    return { playerId, walletId: wallet.id };
  }

  // The database keeps its data between runs, so every run uses its own external ids.
  const run = randomUUID().slice(0, 8);

  function bet(
    wallet: { playerId: string; walletId: string },
    name: string,
    amount: string,
    overrides: Partial<SubmitWagerTransactionCommand> = {},
  ): SubmitWagerTransactionCommand {
    const externalTransactionId = `${run}-${name}`;
    return {
      idempotencyKey: `provider-a:${externalTransactionId}`,
      providerId: 'provider-a',
      externalTransactionId,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount, currency: 'BRL' },
      ...overrides,
    };
  }

  /** Stored balance and the balance rebuilt from the ledger. */
  async function balances(walletId: string) {
    const [row] = await em().execute<{ stored: string; rebuilt: string; entries: string }[]>(
      `select w.balance::text as stored,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as rebuilt,
              count(l.id)::text as entries
         from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ? group by w.id`,
      [walletId],
    );
    return {
      stored: Number(row?.stored),
      rebuilt: Number(row?.rebuilt),
      entries: Number(row?.entries),
    };
  }

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = await em().execute<{ n: string }[]>(sql, params);
    return Number(row?.n);
  }

  const externalId = (name: string) => `${run}-${name}`;

  return { orm, em, uow, createWallet, submit, openWallet, bet, externalId, balances, count };
}
