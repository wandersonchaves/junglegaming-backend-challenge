import Decimal from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const NOT_IMPLEMENTED = 'not implemented';

const AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) { }

  static from(props: MoneyProps): Money {
    if (!props.currency) {
      throw new InvalidMoneyError('currency is required')
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`invalid amount: ${props.amount}`)
    }
    return new Money(new Decimal(props.amount), props.currency)
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`cannot combine ${this.currency} with ${other.currency}`);
    }
  }

  toString(): string {
    return this.value.toFixed(2)
  }
}
