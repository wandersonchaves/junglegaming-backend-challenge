import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { MessagePublisher } from '../../application/ports/outbox-publishing';

/**
 * Sends an outbox message to the events FIFO queue.
 * Group = aggregate id keeps the events of one wallet in order; the deduplication id (the event id)
 * makes SQS drop a second send of the same event inside its 5 minute window. Consumers must still
 * deduplicate by eventId: that window is an optimisation, not a guarantee.
 */
export class SqsEventPublisher implements MessagePublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) { }

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: message.eventType },
        },
      }),
    );
  }
}
