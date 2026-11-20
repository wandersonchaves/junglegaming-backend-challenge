import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { AppConfig } from './config/app-config';

export interface ReadinessReport {
  status: 'ready' | 'not_ready';
  checks: Record<string, 'up' | 'down' | 'skipped'>;
}

/** Ready means: PostgreSQL answers and the queues can be reached. */
export class Readiness {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly config: AppConfig,
  ) { }

  async check(): Promise<ReadinessReport> {
    const [postgres, queue] = await Promise.all([this.postgres(), this.queue()]);
    const checks = { postgres, sqs: queue };
    const ready = Object.values(checks).every((c) => c !== 'down');
    return { status: ready ? 'ready' : 'not_ready', checks };
  }

  private async postgres(): Promise<'up' | 'down'> {
    try {
      await this.orm.em.fork().execute('select 1');
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async queue(): Promise<'up' | 'down' | 'skipped'> {
    const urls = [this.config.wagerQueueUrl, this.config.eventsQueueUrl].filter(
      (url): url is string => url !== undefined,
    );
    if (urls.length === 0) return 'skipped';
    try {
      await Promise.all(
        urls.map((QueueUrl) =>
          this.sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), {
            abortSignal: AbortSignal.timeout(2_000),
          }),
        ),
      );
      return 'up';
    } catch {
      return 'down';
    }
  }
}
