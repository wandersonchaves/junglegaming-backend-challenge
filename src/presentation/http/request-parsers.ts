import { MoneyProps } from '../../domain/money/money';
import { WagerTransactionKind } from '../../domain/wager/wager-transaction-kind';
import { CreateWalletCommand } from '../../application/create-wallet/create-wallet.use-case';
import { SubmitWagerTransactionCommand } from '../../application/submit-wager-transaction/submit-wager-transaction.use-case';
import { InvalidRequestError } from './invalid-request.error';

type Json = Record<string, unknown>;

function asObject(value: unknown, name: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError(`${name} must be a JSON object`);
  }
  return value as Json;
}

function text(source: Json, field: string, prefix = ''): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`${prefix}${field} is required and must be a non-empty string`);
  }
  return value;
}

function optionalText(source: Json, field: string): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidRequestError(`${field} must be a non-empty string when present`);
  }
  return value;
}

function money(value: unknown, name: string): MoneyProps {
  const source = asObject(value, name);
  // The amount must travel as a string: a JSON number would already have lost precision.
  return { amount: text(source, 'amount', `${name}.`), currency: text(source, 'currency', `${name}.`) };
}

export function parseCreateWallet(body: unknown): CreateWalletCommand {
  const source = asObject(body, 'body');
  return {
    playerId: text(source, 'playerId'),
    initialBalance: money(source['initialBalance'], 'initialBalance'),
  };
}

const KINDS = Object.values(WagerTransactionKind) as string[];

export function parseSubmitWagerTransaction(
  body: unknown,
  idempotencyKey: string | undefined,
  correlationId: string | undefined,
): SubmitWagerTransactionCommand {
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    throw new InvalidRequestError('Idempotency-Key header is required');
  }
  const source = asObject(body, 'body');
  const kind = text(source, 'kind');
  if (!KINDS.includes(kind)) {
    throw new InvalidRequestError(`kind must be one of ${KINDS.join(', ')}`);
  }
  return {
    idempotencyKey,
    providerId: text(source, 'providerId'),
    externalTransactionId: text(source, 'externalTransactionId'),
    playerId: text(source, 'playerId'),
    walletId: text(source, 'walletId'),
    roundId: text(source, 'roundId'),
    gameId: text(source, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: money(source['money'], 'money'),
    referenceExternalTransactionId: optionalText(source, 'referenceExternalTransactionId'),
    correlationId,
  };
}
