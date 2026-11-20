import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WagerTransactionStatus } from '../../src/domain/wager/wager-transaction-status';
import { WagerTransactionKind } from '../../src/domain/wager/wager-transaction-kind';
import { PublishOutbox } from '../../src/application/publish-outbox/publish-outbox.use-case';
import { MessagePublisher } from '../../src/application/ports/outbox-publishing';
import { WagerQueries } from '../../src/application/queries/wager-queries';
import { ReprocessPendingReferences } from '../../src/application/reprocess-pending-references/reprocess-pending-references.use-case';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { Readiness } from '../../src/infrastructure/readiness';
import { connect } from '../support/db';
import { createQueues } from '../support/sqs';

let db: Awaited<ReturnType<typeof connect>>;
let sqs: Awaited<ReturnType<typeof createQueues>>;

beforeAll(async () => {
  db = await connect();
  sqs = await createQueues();
  // The test database keeps the events of every earlier run and suite. These tests look at who
  // publishes what, so they start from an empty backlog. Test database only.
  await db.em().execute(`update outbox_messages set published_at = now() where published_at is null`, [], 'run');
});

afterAll(async () => {
  await db.orm.close();
});

const eventIdsOf = async (walletId: string): Promise<string[]> =>
  (
    await db.em().execute<{ id: string }[]>(
      `select id from outbox_messages where payload->'data'->>'walletId' = ? order by occurred_at, id`,
      [walletId],
    )
  ).map((r) => r.id);

const publishedAt = async (id: string): Promise<Date | null> =>
  (await db.em().execute<{ published_at: Date | null }[]>(`select published_at from outbox_messages where id = ?`, [id]))[0]
    ?.published_at ?? null;

class CountingPublisher implements MessagePublisher {
  readonly published: string[] = [];
  async publish(message: OutboxMessage): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2)); // widens the window for overlap
    this.published.push(message.id);
  }
}

async function runUntilEmpty(publish: PublishOutbox): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const { published, failed } = await publish.execute();
    if (published + failed === 0) return;
  }
}

describe('transactional outbox', () => {
  test('events written with the transaction are published to SQS and marked as published', async () => {
    const wallet = await db.openWallet('100.00');
    const result = await db.submit.execute(db.bet(wallet, 'outbox-bet', '25.00'));
    const ids = await eventIdsOf(wallet.walletId);
    expect(ids.length).toBeGreaterThanOrEqual(4); // opening: 2, bet: 2
    expect(await publishedAt(ids[0] as string)).toBeNull();

    const eventsQueue = await sqs.newEventsQueue();
    const publish = new PublishOutbox(db.outboxStore, new SqsEventPublisher(sqs.client, eventsQueue), db.clock, 200);
    await runUntilEmpty(publish);

    for (const id of ids) expect(await publishedAt(id)).not.toBeNull();
    const inQueue = (await sqs.peek(eventsQueue, 6)).map((m) => JSON.parse(m.Body ?? '{}') as { eventId: string; eventType: string });
    expect(inQueue.some((e) => e.eventId === ids[0])).toBe(true);
    expect(inQueue.some((e) => e.eventType === 'WalletBalanceChanged')).toBe(true);
    expect(result.status).toBe(WagerTransactionStatus.Processed);
  });

  test('the broker is down after the commit: nothing is lost, a later publisher takes over', async () => {
    const wallet = await db.openWallet('100.00');
    const ids = await eventIdsOf(wallet.walletId);

    const brokenUrl = `${sqs.eventsUrl}-does-not-exist`;
    const broken = new PublishOutbox(db.outboxStore, new SqsEventPublisher(sqs.client, brokenUrl), db.clock, 200);
    await runUntilEmpty(broken);

    const [row] = await db.em().execute<{ attempts: number; next_attempt_at: Date; published_at: Date | null }[]>(
      `select attempts, next_attempt_at, published_at from outbox_messages where id = ?`,
      [ids[0]],
    );
    expect(row?.published_at).toBeNull();
    expect(row?.attempts).toBeGreaterThanOrEqual(1);
    expect(new Date(row?.next_attempt_at as Date).getTime()).toBeGreaterThan(Date.now());

    // Backoff elapsed and another instance, with a working broker, runs.
    await db.em().execute(`update outbox_messages set next_attempt_at = now() - interval '1 second' where id = any(?::uuid[])`, [`{${ids.join(',')}}`], 'run');
    const healthy = new PublishOutbox(db.outboxStore, new SqsEventPublisher(sqs.client, sqs.eventsUrl), db.clock, 200);
    await runUntilEmpty(healthy);

    for (const id of ids) expect(await publishedAt(id)).not.toBeNull();
  });

  test('two publishers working on the same outbox publish each event exactly once', async () => {
    const wallets = await Promise.all(Array.from({ length: 25 }, () => db.openWallet('10.00')));
    const ids = (await Promise.all(wallets.map((w) => eventIdsOf(w.walletId)))).flat();
    expect(ids.length).toBe(50);
    const publisher = new CountingPublisher();
    const a = new PublishOutbox(db.outboxStore, publisher, db.clock, 7);
    const b = new PublishOutbox(db.outboxStore, publisher, db.clock, 11);

    await Promise.all([runUntilEmpty(a), runUntilEmpty(b)]);

    const ours = publisher.published.filter((id) => ids.includes(id));
    expect(ours.length).toBe(ids.length);
    expect(new Set(ours).size).toBe(ids.length);
    expect(new Set(publisher.published).size).toBe(publisher.published.length);
  });

  test('publishing the same event twice is harmless: the queue keeps one copy', async () => {
    const message = OutboxMessage.enqueue({
      eventId: randomUUID(),
      aggregateId: `agg-${randomUUID()}`,
      eventType: 'WalletBalanceChanged',
      occurredAt: new Date(),
      toJSON: () => ({ marker: 'dedup' }),
    });
    const eventsQueue = await sqs.newEventsQueue();
    const publisher = new SqsEventPublisher(sqs.client, eventsQueue);

    await publisher.publish(message);
    await publisher.publish(message);

    const copies = (await sqs.peek(eventsQueue, 6)).filter((m) => m.Attributes?.MessageGroupId === message.aggregateId);
    expect(copies).toHaveLength(1);
  });

  test('outbox lag is zero when everything was published', async () => {
    const publish = new PublishOutbox(db.outboxStore, new CountingPublisher(), db.clock, 500);
    await runUntilEmpty(publish);

    expect(await db.outboxStore.lagSeconds(new Date())).toBe(0);
  });
});

describe('references that arrive out of order', () => {
  const refund = (wallet: { playerId: string; walletId: string }, reference: string) =>
    db.bet(wallet, `refund-of-${reference}`, '25.00', {
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: db.externalId(reference),
    });

  const makeDue = (transactionId: string) =>
    db.em().execute(`update wager_transactions set reference_next_attempt_at = now() - interval '1 second' where id = ?`, [transactionId], 'run');

  test('the refund waits, the bet arrives, the worker applies the refund', async () => {
    const wallet = await db.openWallet('100.00');
    const early = await db.submit.execute(refund(wallet, 'late-bet'));
    expect(early.status).toBe(WagerTransactionStatus.PendingReference);
    await db.submit.execute(db.bet(wallet, 'late-bet', '25.00'));
    await makeDue(early.transactionId);

    const result = await new ReprocessPendingReferences(db.uow, db.clock, db.ids).execute();

    expect(result.processed).toBeGreaterThanOrEqual(1);
    const { stored, rebuilt } = await db.balances(wallet.walletId);
    expect(stored).toBe(100);
    expect(rebuilt).toBe(100);
    expect(
      await db.count(`select count(*) as n from wager_transactions where id = ? and status = 'PROCESSED'`, [early.transactionId]),
    ).toBe(1);
  });

  test('two workers at once apply a waiting refund only once', async () => {
    const wallet = await db.openWallet('100.00');
    const early = await db.submit.execute(refund(wallet, 'race-bet'));
    await db.submit.execute(db.bet(wallet, 'race-bet', '25.00'));
    await makeDue(early.transactionId);

    await Promise.all([
      new ReprocessPendingReferences(db.uow, db.clock, db.ids).execute(),
      new ReprocessPendingReferences(db.uow, db.clock, db.ids).execute(),
      new ReprocessPendingReferences(db.uow, db.clock, db.ids).execute(),
    ]);

    const { stored, rebuilt, entries } = await db.balances(wallet.walletId);
    expect(stored).toBe(100);
    expect(rebuilt).toBe(100);
    expect(entries).toBe(3); // opening, bet, refund
  });

  test('a reference that never arrives ends as REJECTED with REFERENCE_NOT_FOUND and an event', async () => {
    const wallet = await db.openWallet('100.00');
    const early = await db.submit.execute(refund(wallet, 'never-comes'));
    await db.em().execute(
      `update wager_transactions set reference_attempts = 9, reference_next_attempt_at = now() - interval '1 second' where id = ?`,
      [early.transactionId],
      'run',
    );

    await new ReprocessPendingReferences(db.uow, db.clock, db.ids).execute();

    const [row] = await db.em().execute<{ status: string; failure_code: string }[]>(
      `select status, failure_code from wager_transactions where id = ?`,
      [early.transactionId],
    );
    expect(row).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(
      await db.count(
        `select count(*) as n from outbox_messages where event_type = 'WagerTransactionRejected' and payload->'data'->>'transactionId' = ?`,
        [early.transactionId],
      ),
    ).toBe(1);
    expect((await db.balances(wallet.walletId)).stored).toBe(100);
  });
});

describe('queries and reconciliation', () => {
  test('the ledger is paged with a stable cursor: no entry repeated, none missing', async () => {
    const wallet = await db.openWallet('100.00');
    for (let i = 0; i < 6; i += 1) await db.submit.execute(db.bet(wallet, `page-${i}`, '1.00'));
    const queries = new WagerQueries(db.readModel);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await queries.listLedger(wallet.walletId, cursor, 3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      // a new entry arrives while the client is paging
      if (pages === 1) await db.submit.execute(db.bet(wallet, 'page-late', '1.00'));
    } while (cursor);

    expect(seen.length).toBe(8); // opening + 6 bets + the late one
    expect(new Set(seen).size).toBe(8);
  });

  test('reconciliation confirms a consistent wallet', async () => {
    const wallet = await db.openWallet('100.00');
    await db.submit.execute(db.bet(wallet, 'recon-ok', '30.00'));

    const result = await new WagerQueries(db.readModel).reconcile(wallet.walletId);

    expect(result).toMatchObject({
      consistent: true,
      checkedEntries: 2,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
    });
  });

  test('reconciliation reports a divergence and does not fix it', async () => {
    const wallet = await db.openWallet('100.00');
    // Simulates corruption done outside the application.
    await db.em().execute(`update wallets set balance = 90.00 where id = ?`, [wallet.walletId], 'run');

    const result = await new WagerQueries(db.readModel).reconcile(wallet.walletId);

    expect(result.consistent).toBe(false);
    expect(result.difference.amount).toBe('-10.00');
    expect((await db.balances(wallet.walletId)).stored).toBe(90);
  });

  test('transactions are found by id and by provider and external id', async () => {
    const wallet = await db.openWallet('100.00');
    const result = await db.submit.execute(db.bet(wallet, 'lookup', '5.00'));
    const queries = new WagerQueries(db.readModel);

    const byId = await queries.getTransaction(result.transactionId);
    const byExternal = await queries.getTransactionByExternalId('provider-a', db.externalId('lookup'));

    expect(byId.id).toBe(result.transactionId);
    expect(byExternal.id).toBe(result.transactionId);
    expect(byId.status).toBe('PROCESSED');
  });
});

describe('readiness', () => {
  test('is ready when PostgreSQL and the queues answer', async () => {
    const readiness = new Readiness(db.orm, sqs.client, { ...sqs.config, wagerQueueUrl: sqs.queueUrl, eventsQueueUrl: sqs.eventsUrl });

    expect(await readiness.check()).toEqual({ status: 'ready', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('is not ready when the queue cannot be reached', async () => {
    const readiness = new Readiness(db.orm, sqs.client, { ...sqs.config, wagerQueueUrl: `${sqs.queueUrl}-missing` });

    const report = await readiness.check();

    expect(report.status).toBe('not_ready');
    expect(report.checks.sqs).toBe('down');
  });
});
