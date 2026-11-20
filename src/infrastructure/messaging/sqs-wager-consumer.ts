import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  classifyError,
  failureReason,
} from '../../application/process-wager-message/message-errors';
import { ProcessWagerMessage } from '../../application/process-wager-message/process-wager-message.use-case';
import { metrics } from '../observability/metrics';
import { StructuredLogger } from '../observability/structured-logger';

export interface SqsConsumerOptions {
  queueUrl: string;
  dlqUrl: string;
  /** Receives allowed before a failing message is parked in the DLQ. */
  maxAttempts?: number;
  waitTimeSeconds?: number;
  batchSize?: number;
  /** Seconds a transient failure waits before the message is visible again. */
  backoffSeconds?: (receiveCount: number) => number;
}

/** 2s, 4s, 8s ... capped at one minute. */
const defaultBackoffSeconds = (receiveCount: number): number => Math.min(2 ** receiveCount, 60);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Consumes the wager FIFO queue.
 *  - the message is deleted (acked) only after the use case committed its transaction;
 *  - business outcomes (processed, rejected, pending reference) are acked;
 *  - permanent errors go to the DLQ right away, transient ones come back with a growing delay
 *    and go to the DLQ after maxAttempts receives;
 *  - on shutdown the poll is aborted and the messages already in hand are finished first.
 */
export class SqsWagerConsumer {
  private readonly logger = new StructuredLogger('sqs-consumer');
  private readonly maxAttempts: number;
  private readonly waitTimeSeconds: number;
  private readonly batchSize: number;
  private running = false;
  private loop?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsConsumerOptions,
    private readonly process: ProcessWagerMessage,
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.waitTimeSeconds = options.waitTimeSeconds ?? 5;
    this.batchSize = options.batchSize ?? 10;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stops polling and resolves once the messages already received are done. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
  }

  /** Receives one batch and handles it. Returns how many messages arrived. */
  async pollOnce(): Promise<number> {
    this.abort = new AbortController();
    const received = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: this.waitTimeSeconds,
        MessageSystemAttributeNames: ['All'],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = received.Messages ?? [];

    // Different wallets in parallel; messages of the same group one after the other.
    const groups = new Map<string, Message[]>();
    for (const message of messages) {
      const group = message.Attributes?.MessageGroupId ?? message.MessageId ?? 'none';
      groups.set(group, [...(groups.get(group) ?? []), message]);
    }
    await Promise.all(
      [...groups.values()].map(async (batch) => {
        for (const message of batch) await this.handle(message);
      }),
    );
    return messages.length;
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        const received = await this.pollOnce();
        if (received === 0 && this.waitTimeSeconds === 0) await sleep(250);
      } catch (error) {
        if (!this.running) return; // aborted by stop()
        this.logger.error('poll failed', { error: String(error) });
        await sleep(2_000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    const startedAt = performance.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    try {
      const result = await this.process.execute(message.Body ?? '');
      // Everything is committed at this point. If the delete below is lost, the message comes
      // back and the inbox answers it as a duplicate without repeating the effects.
      await this.delete(message);
      metrics.transactions.inc({ status: result.status, source: 'sqs' });
      if (result.idempotentReplay) metrics.replays.inc({ source: 'sqs' });
      metrics.processingSeconds.observe((performance.now() - startedAt) / 1000, { source: 'sqs' });
      this.logger.info('message processed', {
        messageId: message.MessageId,
        transactionId: result.transactionId,
        status: result.status,
        replay: result.idempotentReplay,
      });
    } catch (error) {
      await this.fail(message, error, receiveCount);
    }
  }

  private async fail(message: Message, error: unknown, receiveCount: number): Promise<void> {
    const reason = failureReason(error);
    const permanent = classifyError(error) === 'permanent';

    if (permanent || receiveCount >= this.maxAttempts) {
      this.logger.error('message sent to the dead-letter queue', {
        messageId: message.MessageId,
        reason,
        permanent,
        receiveCount,
      });
      try {
        await this.sendToDlq(message, permanent ? reason : `RETRIES_EXHAUSTED:${reason}`);
        await this.delete(message);
        metrics.dlq.inc({ reason: permanent ? reason : 'RETRIES_EXHAUSTED' });
      } catch (dlqError) {
        // Left in the queue: it will be received again and parked then.
        this.logger.error('could not park the message', { messageId: message.MessageId, error: String(dlqError) });
      }
      return;
    }

    const delaySeconds = (this.options.backoffSeconds ?? defaultBackoffSeconds)(receiveCount);
    metrics.retries.inc({ component: 'sqs_consumer' });
    this.logger.warn('transient failure, message will be retried', {
      messageId: message.MessageId,
      reason,
      receiveCount,
      retryInSeconds: delaySeconds,
    });
    try {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.options.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
    } catch {
      // The normal visibility timeout will make it visible again.
    }
  }

  private async sendToDlq(message: Message, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: `${message.MessageId ?? 'unknown'}-dlq`,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          originalMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
  }

  private async delete(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.options.queueUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }
}
