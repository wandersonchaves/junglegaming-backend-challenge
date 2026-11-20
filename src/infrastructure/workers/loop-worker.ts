import { StructuredLogger } from '../observability/structured-logger';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `tick` again and again. A tick returns how much work it found:
 * with work it runs again straight away, without it waits `idleMs`.
 * stop() lets the tick in progress finish, so nothing is cut in the middle of a transaction.
 */
export class LoopWorker {
  private readonly logger: StructuredLogger;
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly idleMs: number,
  ) {
    this.logger = new StructuredLogger(name);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let worked = 0;
      try {
        worked = await this.tick();
      } catch (error) {
        this.logger.error('tick failed', { error: String(error) });
      }
      if (worked === 0 && this.running) await sleep(this.idleMs);
    }
  }
}
