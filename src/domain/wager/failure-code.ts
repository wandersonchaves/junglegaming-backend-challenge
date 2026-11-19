/**
 * Stable, machine-readable reasons for a rejected or failed transaction.
 * The provider can use these to decide whether to resend, fix the payload or give up.
 */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw: 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed: 'REFERENCE_ALREADY_REVERSED',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  AmountMismatch: 'AMOUNT_MISMATCH',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletNotFound: 'WALLET_NOT_FOUND',
  InfrastructureError: 'INFRASTRUCTURE_ERROR',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
