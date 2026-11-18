import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const NOT_IMPLEMENTED = 'not implemented';

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(_props: MoneyProps): Money {
    throw new Error(NOT_IMPLEMENTED);
  }

  static zero(_currency: string): Money {
    throw new Error(NOT_IMPLEMENTED);
  }

  add(_other: Money): Money {
    throw new Error(NOT_IMPLEMENTED);
  }

  subtract(_other: Money): Money {
    throw new Error(NOT_IMPLEMENTED);
  }

  negate(): Money {
    throw new Error(NOT_IMPLEMENTED);
  }

  isZero(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }

  isPositive(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }

  isNegative(): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }

  isLessThan(_other: Money): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }

  equals(_other: Money): boolean {
    throw new Error(NOT_IMPLEMENTED);
  }

  toJSON(): MoneyProps {
    throw new Error(NOT_IMPLEMENTED);
  }

  toString(): string {
    throw new Error(NOT_IMPLEMENTED);
  }
}
