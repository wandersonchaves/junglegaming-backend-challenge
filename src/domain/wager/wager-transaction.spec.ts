import { describe, expect, it } from 'bun:test';
import { Money } from '../money/money';
import { LedgerDirection } from '../wallet/wallet-ledger-entry';
import { FailureCode } from './failure-code';
import { WagerTransaction, type CreateWagerTransactionProps } from './wager-transaction';
import { WagerTransactionKind as Kind } from './wager-transaction-kind';
import { WagerTransactionStatus as Status } from './wager-transaction-status';
import { InvalidTransactionError, InvalidTransactionStateError } from './wager.errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-19T12:00:00.000Z');

let counter = 0;
const make = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
  counter += 1;
  return WagerTransaction.create({
    id: `tx-${counter}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${counter}`,
    idempotencyKey: `provider-a:ext-${counter}`,
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    createdAt: at,
    ...overrides,
  });
};

const reversal = (kind: Kind.Refund | Kind.Rollback, overrides: Partial<CreateWagerTransactionProps> = {}) =>
  make({ kind, referenceExternalTransactionId: 'ext-ref', ...overrides });

describe('WagerTransaction.create', () => {
  it('is born PENDING and keeps its data', () => {
    const tx = make();
    expect(tx.status).toBe(Status.Pending);
    expect(tx.kind).toBe(Kind.Bet);
    expect(tx.money.toString()).toBe('25.00');
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
  });

  it('refuses OPENING: it is internal and cannot be submitted', () => {
    expect(() => make({ kind: Kind.Opening })).toThrow(InvalidTransactionError);
  });

  it.each([Kind.Refund, Kind.Rollback])('requires a reference for %s', (kind) => {
    expect(() => make({ kind })).toThrow(InvalidTransactionError);
    expect(() => make({ kind, referenceExternalTransactionId: 'ext-ref' })).not.toThrow();
  });

  it('refuses a zero amount', () => {
    expect(() => make({ money: Money.zero('BRL') })).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction.createOpening', () => {
  it('creates an OPENING transaction that credits the wallet', () => {
    const tx = WagerTransaction.createOpening({
      id: 'tx-open',
      providerId: 'internal',
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'hash-open',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'opening',
      gameId: 'opening',
      money: brl('1000.00'),
      createdAt: at,
    });
    expect(tx.kind).toBe(Kind.Opening);
    expect(tx.status).toBe(Status.Pending);
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction queries', () => {
  it('affectsBalance is false only for LOSS', () => {
    expect(make({ kind: Kind.Loss }).affectsBalance()).toBe(false);
    expect(make({ kind: Kind.Bet }).affectsBalance()).toBe(true);
    expect(make({ kind: Kind.Win }).affectsBalance()).toBe(true);
    expect(reversal(Kind.Refund).affectsBalance()).toBe(true);
    expect(reversal(Kind.Rollback).affectsBalance()).toBe(true);
  });

  it('requiresReference is true only for REFUND and ROLLBACK', () => {
    expect(reversal(Kind.Refund).requiresReference()).toBe(true);
    expect(reversal(Kind.Rollback).requiresReference()).toBe(true);
    expect(make({ kind: Kind.Bet }).requiresReference()).toBe(false);
  });

  it('matchesPayload compares the payload hash', () => {
    const tx = make({ payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });
});

describe('WagerTransaction transitions', () => {
  it('PENDING to PROCESSED', () => {
    const tx = make();
    tx.markProcessed(undefined, at, brl('75.00'));
    expect(tx.status).toBe(Status.Processed);
    expect(tx.processedAt).toEqual(at);
    expect(tx.balanceAfter?.toString()).toBe('75.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PROCESSED stores the internal id of the reference', () => {
    const tx = reversal(Kind.Refund);
    tx.markProcessed('tx-bet', at);
    expect(tx.referenceTransactionId).toBe('tx-bet');
  });

  it('PENDING to PENDING_REFERENCE and then to PROCESSED', () => {
    const tx = reversal(Kind.Refund);
    tx.markPendingReference();
    expect(tx.status).toBe(Status.PendingReference);
    expect(tx.isTerminal()).toBe(false);
    tx.markProcessed('tx-bet', at);
    expect(tx.status).toBe(Status.Processed);
  });

  it('PENDING_REFERENCE may be marked again (a retry that still finds no reference)', () => {
    const tx = reversal(Kind.Refund);
    tx.markPendingReference();
    expect(() => tx.markPendingReference()).not.toThrow();
    expect(tx.status).toBe(Status.PendingReference);
  });

  it('reject records the failure code and is terminal', () => {
    const tx = make();
    tx.reject(FailureCode.InsufficientFunds);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING_REFERENCE can be rejected when the reference never shows up', () => {
    const tx = reversal(Kind.Rollback);
    tx.markPendingReference();
    tx.reject(FailureCode.ReferenceNotFound);
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it('fail records the failure code and is terminal', () => {
    const tx = make();
    tx.fail(FailureCode.InfrastructureError);
    expect(tx.status).toBe(Status.Failed);
    expect(tx.isTerminal()).toBe(true);
  });

  const terminal: Array<[string, () => WagerTransaction]> = [
    ['PROCESSED', () => { const t = make(); t.markProcessed(undefined, at); return t; }],
    ['REJECTED', () => { const t = make(); t.reject(FailureCode.InsufficientFunds); return t; }],
    ['FAILED', () => { const t = make(); t.fail(FailureCode.InfrastructureError); return t; }],
  ];

  it.each(terminal)('%s never changes again', (_name, build) => {
    const tx = build();
    expect(() => tx.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
    expect(() => tx.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => tx.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => tx.fail(FailureCode.InfrastructureError)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  it('BET debits and WIN and REFUND credit', () => {
    expect(make({ kind: Kind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: Kind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(reversal(Kind.Refund).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  it('LOSS has no ledger direction', () => {
    expect(() => make({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  it('ROLLBACK is the inverse of the transaction it reverts', () => {
    const rollback = reversal(Kind.Rollback);
    expect(rollback.ledgerDirectionFor(make({ kind: Kind.Bet }))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(make({ kind: Kind.Win }))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(reversal(Kind.Refund))).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK needs the reference to know its direction', () => {
    expect(() => reversal(Kind.Rollback).ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });
});

describe('WagerTransaction.checkReference', () => {
  const bet = () => make({ kind: Kind.Bet, externalTransactionId: 'ext-ref' });

  it('accepts a valid REFUND of a BET and a valid ROLLBACK of a BET, WIN or REFUND', () => {
    expect(reversal(Kind.Refund).checkReference(bet())).toBeUndefined();
    expect(reversal(Kind.Rollback).checkReference(bet())).toBeUndefined();
    expect(reversal(Kind.Rollback).checkReference(make({ kind: Kind.Win }))).toBeUndefined();
    expect(reversal(Kind.Rollback).checkReference(reversal(Kind.Refund))).toBeUndefined();
  });

  it('REFUND can only reference a BET', () => {
    expect(reversal(Kind.Refund).checkReference(make({ kind: Kind.Win }))).toBe(FailureCode.InvalidReferenceKind);
  });

  it('ROLLBACK cannot reference a LOSS or another ROLLBACK', () => {
    expect(reversal(Kind.Rollback).checkReference(make({ kind: Kind.Loss }))).toBe(FailureCode.InvalidReferenceKind);
    expect(reversal(Kind.Rollback).checkReference(reversal(Kind.Rollback))).toBe(FailureCode.InvalidReferenceKind);
  });

  it.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['round', { roundId: 'round-2' }],
  ] as const)('refuses a reference from another %s', (_name, override) => {
    expect(reversal(Kind.Refund).checkReference(make({ kind: Kind.Bet, ...override }))).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  it('refuses a reference in another currency', () => {
    const usdBet = make({ kind: Kind.Bet, money: Money.from({ amount: '25.00', currency: 'USD' }) });
    expect(reversal(Kind.Refund).checkReference(usdBet)).toBe(FailureCode.CurrencyMismatch);
  });

  it('refuses a different amount: partial reversals are out of scope', () => {
    expect(reversal(Kind.Refund).checkReference(make({ kind: Kind.Bet, money: brl('10.00') }))).toBe(
      FailureCode.AmountMismatch,
    );
  });
});
