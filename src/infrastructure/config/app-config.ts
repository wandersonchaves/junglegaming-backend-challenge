export interface AppConfig {
  port: number;
  region: string;
  endpoint?: string;
  wagerQueueUrl?: string;
  wagerDlqUrl?: string;
  eventsQueueUrl?: string;
  consumerEnabled: boolean;
  workersEnabled: boolean;
  /** Long-poll wait of the consumer; 0 in tests. */
  consumerWaitSeconds: number;
}

const flag = (value: string | undefined): boolean => value === undefined || !['false', '0', 'off'].includes(value.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    region: env.AWS_REGION ?? 'us-east-1',
    endpoint: env.AWS_ENDPOINT_URL || undefined,
    wagerQueueUrl: env.WAGER_QUEUE_URL || undefined,
    wagerDlqUrl: env.WAGER_DLQ_URL || undefined,
    eventsQueueUrl: env.WAGER_EVENTS_QUEUE_URL || undefined,
    consumerEnabled: flag(env.CONSUMER_ENABLED),
    workersEnabled: flag(env.WORKERS_ENABLED),
    consumerWaitSeconds: Number(env.CONSUMER_WAIT_SECONDS ?? 5),
  };
}
