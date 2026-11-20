/** A small Prometheus-compatible registry: counters, histograms and gauges read at scrape time. */
type Labels = Record<string, string>;

const key = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`)
    .join(',');

const render = (name: string, labels: string, value: number, suffix = ''): string =>
  `${name}${suffix}${labels ? `{${labels}}` : ''} ${value}`;

export class Counter {
  private readonly values = new Map<string, number>();
  constructor(readonly name: string, readonly help: string) { }

  inc(labels: Labels = {}, amount = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + amount);
  }

  get(labels: Labels = {}): number {
    return this.values.get(key(labels)) ?? 0;
  }

  lines(): string[] {
    const rows = [...this.values].map(([labels, value]) => render(this.name, labels, value));
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...(rows.length ? rows : [`${this.name} 0`])];
  }
}

export class Histogram {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: readonly number[],
  ) { }

  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    const entry = this.series.get(k) ?? { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
    this.bounds.forEach((bound, i) => {
      if (value <= bound) entry.buckets[i] = (entry.buckets[i] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count += 1;
    this.series.set(k, entry);
  }

  count(labels: Labels = {}): number {
    return this.series.get(key(labels))?.count ?? 0;
  }

  lines(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [labels, entry] of this.series) {
      const prefix = labels ? `${labels},` : '';
      this.bounds.forEach((bound, i) =>
        out.push(render(this.name, `${prefix}le="${bound}"`, entry.buckets[i] ?? 0, '_bucket')),
      );
      out.push(render(this.name, `${prefix}le="+Inf"`, entry.count, '_bucket'));
      out.push(render(this.name, labels, entry.sum, '_sum'));
      out.push(render(this.name, labels, entry.count, '_count'));
    }
    return out;
  }
}

class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => Promise<number>,
  ) { }

  async lines(): Promise<string[]> {
    let value = 0;
    try {
      value = await this.collect();
    } catch {
      value = Number.NaN;
    }
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`, `${this.name} ${value}`];
  }
}

export class MetricsRegistry {
  private readonly counters: Counter[] = [];
  private readonly histograms: Histogram[] = [];
  private readonly gauges: Gauge[] = [];

  counter(name: string, help: string): Counter {
    const counter = new Counter(name, help);
    this.counters.push(counter);
    return counter;
  }

  histogram(name: string, help: string, bounds: readonly number[]): Histogram {
    const histogram = new Histogram(name, help, bounds);
    this.histograms.push(histogram);
    return histogram;
  }

  gauge(name: string, help: string, collect: () => Promise<number>): void {
    this.gauges.push(new Gauge(name, help, collect));
  }

  async render(): Promise<string> {
    const lines = [
      ...this.counters.flatMap((c) => c.lines()),
      ...this.histograms.flatMap((h) => h.lines()),
      ...(await Promise.all(this.gauges.map((g) => g.lines()))).flat(),
    ];
    return `${lines.join('\n')}\n`;
  }
}

/** The instruments the service reports (README section 12). */
export const registry = new MetricsRegistry();

export const metrics = {
  transactions: registry.counter(
    'wager_transactions_total',
    'Transactions answered, by resulting status and kind',
  ),
  replays: registry.counter(
    'wager_idempotent_replays_total',
    'Duplicates detected and answered with the original result, by entry point',
  ),
  retries: registry.counter(
    'wager_retries_total',
    'Retries, by component (sqs_consumer, outbox_publisher, pending_reference)',
  ),
  dlq: registry.counter('wager_dlq_messages_total', 'Messages sent to the dead-letter queue, by reason'),
  lockConflicts: registry.counter(
    'wallet_lock_conflicts_total',
    'Wallet lock acquisitions that had to wait for another transaction',
  ),
  uniqueViolations: registry.counter(
    'db_unique_violations_total',
    'Unique constraint violations raised by the database, by constraint',
  ),
  reconciliationDivergences: registry.counter(
    'reconciliation_divergences_total',
    'Reconciliations that found the stored balance different from the ledger',
  ),
  processingSeconds: registry.histogram(
    'wager_processing_seconds',
    'Time to process one transaction, by entry point',
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  ),
  lockWaitSeconds: registry.histogram(
    'wallet_lock_wait_seconds',
    'Time spent waiting for the wallet row lock',
    [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
  ),
};

/** A wait longer than this means another transaction held the wallet. */
export const LOCK_CONFLICT_THRESHOLD_SECONDS = 0.005;
