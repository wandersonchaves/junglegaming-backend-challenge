import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { loadConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';

/**
 * Real SQS API (LocalStack from docker compose). Every run creates its own uniquely named queues,
 * so runs never see each other's messages.
 */
export async function createQueues() {
  const config = loadConfig({
    ...process.env,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566',
  });
  const client = createSqsClient(config);
  const run = randomUUID().slice(0, 8);

  const create = async (name: string, attributes: Record<string, string> = {}): Promise<string> => {
    const out = await client.send(
      new CreateQueueCommand({
        QueueName: `${name}-${run}.fifo`,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false', ...attributes },
      }),
    );
    return out.QueueUrl as string;
  };

  const dlqUrl = await create('wager-transactions-dlq');
  const dlqArn = (
    await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))
  ).Attributes?.QueueArn as string;
  const queueUrl = await create('wager-transactions', {
    VisibilityTimeout: '2',
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: '5' }),
  });
  const eventsUrl = await create('wager-events', { VisibilityTimeout: '2' });
  /** A queue of its own, for a test that needs to read everything that was sent to it. */
  const newEventsQueue = () => create('wager-events', { VisibilityTimeout: '2' });

  async function send(queue: string, body: string, group: string, dedup = randomUUID()): Promise<void> {
    await client.send(
      new SendMessageCommand({
        QueueUrl: queue,
        MessageBody: body,
        MessageGroupId: group,
        MessageDeduplicationId: dedup,
      }),
    );
  }

  /** Reads every message currently visible, without deleting. */
  async function peek(queue: string, rounds = 3): Promise<Message[]> {
    const seen: Message[] = [];
    for (let i = 0; i < rounds; i += 1) {
      const out = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queue,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 0,
          VisibilityTimeout: 0,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['All'],
        }),
      );
      for (const message of out.Messages ?? []) {
        if (!seen.some((m) => m.MessageId === message.MessageId)) seen.push(message);
      }
    }
    return seen;
  }

  async function purge(queue: string): Promise<void> {
    await client.send(new PurgeQueueCommand({ QueueUrl: queue }));
  }

  return { config, client: client as SQSClient, queueUrl, dlqUrl, eventsUrl, newEventsQueue, send, peek, purge };
}

export function wagerMessage(
  messageId: string,
  data: {
    walletId: string;
    playerId: string;
    externalTransactionId: string;
    kind?: string;
    amount?: string;
    referenceExternalTransactionId?: string;
  },
): string {
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId: data.externalTransactionId,
      idempotencyKey: `provider-a:${data.externalTransactionId}`,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: data.kind ?? 'BET',
      money: { amount: data.amount ?? '25.00', currency: 'BRL' },
      referenceExternalTransactionId: data.referenceExternalTransactionId,
    },
  });
}
