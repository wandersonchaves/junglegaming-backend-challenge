/**
 * Load test against running instances of the API.
 *
 *   bun run start                          # one or more instances (PORT=3001 bun run start ...)
 *   bun run test:load
 *   TARGETS=http://localhost:3000,http://localhost:3001,http://localhost:3002 DURATION_S=30 bun run test:load
 *
 * It is a closed-loop test: CONCURRENCY workers send one request, wait for the answer, send the next.
 * Traffic is spread over WALLETS wallets and a share of it (HOT_SHARE) goes to a single hot wallet,
 * which is where the per-wallet lock is stressed. The mix is 80% new BET, 10% WIN and 10% exact
 * repeats of an earlier BET (idempotent replays). At the end it waits for the outbox to drain,
 * reconciles every wallet and prints a report ready to paste into ARCHITECTURE.md.
 */
import { randomUUID } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';

const targets = (process.env.TARGETS ?? 'http://localhost:3000').split(',').map((t) => t.trim());
const walletCount = Number(process.env.WALLETS ?? 20);
const hotShare = Number(process.env.HOT_SHARE ?? 0.4);
const concurrency = Number(process.env.CONCURRENCY ?? 64);
const durationMs = Number(process.env.DURATION_S ?? 20) * 1000;
const betAmount = process.env.BET_AMOUNT ?? '1.00';
const initialBalance = process.env.INITIAL_BALANCE ?? '10000000.00';
const run = `load-${Date.now()}`;

interface Wallet {
  id: string;
  playerId: string;
  sent: string[];
}

interface Sample {
  ms: number;
  status: number;
}

const samples: Sample[] = [];
let networkErrors = 0;
let pick = 0;

const nextTarget = (): string => targets[pick++ % targets.length] as string;

async function post(base: string, path: string, body: unknown, key?: string): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers['idempotency-key'] = key;
  return fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function createWallet(): Promise<Wallet> {
  const playerId = randomUUID();
  const response = await post(nextTarget(), '/wallets', {
    playerId,
    initialBalance: { amount: initialBalance, currency: 'BRL' },
  });
  if (response.status !== 201) throw new Error(`could not create a wallet: HTTP ${response.status}`);
  const created = (await response.json()) as { id: string };
  return { id: created.id, playerId, sent: [] };
}

function wagerBody(wallet: Wallet, externalId: string, kind: 'BET' | 'WIN') {
  return {
    providerId: 'load-test',
    externalTransactionId: externalId,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${externalId}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount: betAmount, currency: 'BRL' },
  };
}

async function timed(base: string, body: ReturnType<typeof wagerBody>, key: string): Promise<void> {
  const started = performance.now();
  try {
    const response = await post(base, '/wagering/transactions', body, key);
    await response.arrayBuffer();
    samples.push({ ms: performance.now() - started, status: response.status });
  } catch {
    networkErrors += 1;
  }
}

async function worker(wallets: Wallet[], deadline: number): Promise<void> {
  let counter = 0;
  while (Date.now() < deadline) {
    const wallet =
      Math.random() < hotShare ? (wallets[0] as Wallet) : (wallets[Math.floor(Math.random() * wallets.length)] as Wallet);
    const dice = Math.random();
    counter += 1;
    if (dice < 0.1 && wallet.sent.length > 0) {
      const externalId = wallet.sent[Math.floor(Math.random() * wallet.sent.length)] as string;
      await timed(nextTarget(), wagerBody(wallet, externalId, 'BET'), `load-test:${externalId}`);
      continue;
    }
    const kind = dice < 0.2 ? 'WIN' : 'BET';
    const externalId = `${run}-${randomUUID()}-${counter}`;
    if (kind === 'BET') {
      wallet.sent.push(externalId);
      if (wallet.sent.length > 50) wallet.sent.shift();
    }
    await timed(nextTarget(), wagerBody(wallet, externalId, kind), `load-test:${externalId}`);
  }
}

async function scrape(base: string): Promise<string> {
  return (await fetch(`${base}/metrics`)).text();
}

/** Sum of every sample of a metric (all label sets) in the Prometheus text. */
function metricSum(text: string, name: string): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const rest = line.slice(name.length);
    if (rest[0] !== ' ' && rest[0] !== '{') continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) sum += value;
  }
  return sum;
}

function metricMax(text: string, name: string): number {
  let max = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(`${name} `)) continue;
    const value = Number(line.slice(line.lastIndexOf(' ') + 1));
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return max;
}

async function totals(name: string): Promise<number> {
  let sum = 0;
  for (const base of targets) sum += metricSum(await scrape(base), name);
  return sum;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

const fmt = (n: number, digits = 1): string => n.toFixed(digits);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  for (const base of targets) {
    const ready = await fetch(`${base}/health/ready`).catch(() => undefined);
    if (ready?.status !== 200) throw new Error(`${base} is not ready (start the API first)`);
  }

  console.log(`Creating ${walletCount} wallets...`);
  const wallets: Wallet[] = [];
  for (let i = 0; i < walletCount; i += 1) wallets.push(await createWallet());

  const before = {
    lockConflicts: await totals('wallet_lock_conflicts_total'),
    uniqueViolations: await totals('db_unique_violations_total'),
    retries: await totals('wager_retries_total'),
  };

  console.log(`Sending load for ${durationMs / 1000}s with ${concurrency} workers against ${targets.length} instance(s)...`);
  const started = Date.now();
  const deadline = started + durationMs;
  await Promise.all(Array.from({ length: concurrency }, () => worker(wallets, deadline)));
  const elapsedS = (Date.now() - started) / 1000;

  // The outbox: how long until every event written by the load has been published.
  const drainStarted = Date.now();
  let lagAtEnd = 0;
  for (const base of targets) lagAtEnd = Math.max(lagAtEnd, metricMax(await scrape(base), 'outbox_lag_seconds'));
  let drained = false;
  while (Date.now() - drainStarted < 45_000) {
    let lag = 0;
    for (const base of targets) lag = Math.max(lag, metricMax(await scrape(base), 'outbox_lag_seconds'));
    if (lag < 1) {
      drained = true;
      break;
    }
    await sleep(500);
  }
  const drainS = (Date.now() - drainStarted) / 1000;

  let consistent = 0;
  for (const wallet of wallets) {
    const response = await post(nextTarget(), `/wallets/${wallet.id}/reconciliation`, {});
    const body = (await response.json()) as { consistent?: boolean };
    if (response.status === 200 && body.consistent === true) consistent += 1;
  }

  const after = {
    lockConflicts: await totals('wallet_lock_conflicts_total'),
    uniqueViolations: await totals('db_unique_violations_total'),
    retries: await totals('wager_retries_total'),
  };

  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = new Map<number, number>();
  for (const s of samples) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1);
  const total = samples.length + networkErrors;
  const serverErrors = [...byStatus.entries()].filter(([status]) => status >= 500).reduce((n, [, c]) => n + c, 0);
  const errorRate = total === 0 ? 0 : ((serverErrors + networkErrors) / total) * 100;
  const statusLine = [...byStatus.entries()].sort((a, b) => a[0] - b[0]).map(([s, c]) => `${s}: ${c}`).join(', ');

  const report = `
### Load test

**Environment:** ${platform()} ${release()}, ${cpus().length} cores (${cpus()[0]?.model ?? 'unknown'}), ${fmt(totalmem() / 2 ** 30, 0)} GiB RAM, Bun ${Bun.version}. PostgreSQL 16 and LocalStack in Docker on the same machine as the load generator. ${targets.length} API instance(s), each with the SQS consumer and the workers on.

**Method:** closed loop, ${concurrency} concurrent workers for ${fmt(elapsedS, 0)} s, ${walletCount} wallets, ${fmt(hotShare * 100, 0)}% of the traffic on one hot wallet. Mix: about 80% new BET, 10% WIN, 10% idempotent replay of an earlier BET (a replay with nothing to repeat yet becomes a new BET). Every request has its own Idempotency-Key. The generator and the system under test share the machine, so numbers are a lower bound on what the service can do.

| Result | Value |
| --- | --- |
| Requests answered | ${samples.length} |
| Throughput | ${fmt(samples.length / elapsedS, 0)} req/s |
| Latency p50 / p95 / p99 | ${fmt(percentile(sorted, 50))} / ${fmt(percentile(sorted, 95))} / ${fmt(percentile(sorted, 99))} ms |
| Latency max | ${fmt(sorted[sorted.length - 1] ?? 0)} ms |
| Status codes | ${statusLine} |
| Error rate (5xx + network) | ${fmt(errorRate, 2)}% (${serverErrors} server errors, ${networkErrors} network errors) |
| Wallet lock conflicts (waits over 5 ms) | ${after.lockConflicts - before.lockConflicts} |
| Unique violations caught and retried | ${after.uniqueViolations - before.uniqueViolations} |
| Component retries (consumer, publisher, pending refs) | ${after.retries - before.retries} |
| Outbox lag when the load stopped | ${fmt(lagAtEnd)} s |
| Outbox drained | ${drained ? `yes, in ${fmt(drainS)} s after the load` : 'no, still pending after 45 s'} |
| Wallets reconciled clean | ${consistent} of ${wallets.length} |
`;
  console.log(report);
  if (consistent !== wallets.length) process.exitCode = 1;
}

await main();
