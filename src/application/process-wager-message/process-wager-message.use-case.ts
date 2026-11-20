import { createHash } from 'node:crypto';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { canonicalJson } from '../payload-hash';
import {
  SubmitWagerTransaction,
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from '../submit-wager-transaction/submit-wager-transaction.use-case';
import { InvalidMessageError } from './message-errors';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
const MESSAGE_TYPE = 'WagerTransactionRequested';
const KINDS = Object.values(WagerTransactionKind) as string[];

type Json = Record<string, unknown>;

function text(source: Json, field: string): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidMessageError(`${field} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Turns a queue message into the same command the HTTP endpoint builds and runs the same use case.
 * The message is recorded in the inbox in the same SQL transaction as the effects.
 */
export class ProcessWagerMessage {
  constructor(
    private readonly submit: SubmitWagerTransaction,
    private readonly consumerName = WAGER_CONSUMER_NAME,
  ) { }

  async execute(rawBody: string): Promise<SubmitWagerTransactionResult> {
    const { messageId, command } = this.parse(rawBody);
    return await this.submit.execute(command, {
      consumerName: this.consumerName,
      messageId,
      payloadHash: createHash('sha256').update(canonicalJson(JSON.parse(rawBody))).digest('hex'),
    });
  }

  private parse(rawBody: string): { messageId: string; command: SubmitWagerTransactionCommand } {
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new InvalidMessageError('message body is not valid JSON');
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new InvalidMessageError('message body must be a JSON object');
    }
    const message = body as Json;
    const messageId = text(message, 'messageId');
    if (message['type'] !== MESSAGE_TYPE) {
      throw new InvalidMessageError(`type must be ${MESSAGE_TYPE}`);
    }
    const data = message['data'];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidMessageError('data must be a JSON object');
    }
    const source = data as Json;
    const money = source['money'];
    if (money === null || typeof money !== 'object' || Array.isArray(money)) {
      throw new InvalidMessageError('data.money must be a JSON object');
    }
    const kind = text(source, 'kind');
    if (!KINDS.includes(kind)) {
      throw new InvalidMessageError(`kind must be one of ${KINDS.join(', ')}`);
    }
    const reference = source['referenceExternalTransactionId'];

    return {
      messageId,
      command: {
        idempotencyKey: text(source, 'idempotencyKey'),
        providerId: text(source, 'providerId'),
        externalTransactionId: text(source, 'externalTransactionId'),
        playerId: text(source, 'playerId'),
        walletId: text(source, 'walletId'),
        roundId: text(source, 'roundId'),
        gameId: text(source, 'gameId'),
        kind: kind as WagerTransactionKind,
        money: { amount: text(money as Json, 'amount'), currency: text(money as Json, 'currency') },
        referenceExternalTransactionId: typeof reference === 'string' ? reference : undefined,
        correlationId: messageId,
      },
    };
  }
}
