import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain.error';
import { Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from', () => {
  it('creates money from a decimal string with two decimal places', () => {
    const money = brl('25.00');
    expect(money.toString()).toBe('25.00');
    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it.each(['', ' ', 'abc', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3', '0x10', '1,50', ' 1.00', '1.00 '])(
    'rejects malformed amount %p',
    (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    },
  );

  it('rejects more than two decimal places instead of rounding', () => {
    expect(() => brl('1.234')).toThrow(InvalidMoneyError);
    expect(() => brl('0.001')).toThrow(InvalidMoneyError);
  });

  it('rejects negative amounts in input contracts', () => {
    expect(() => brl('-1.00')).toThrow(InvalidMoneyError);
  });

  it('rejects an empty currency', () => {
    expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
  });
});

describe('Money arithmetic', () => {
  it('adds without floating point error', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('subtracts and may become negative as an intermediate value', () => {
    const result = brl('10.00').subtract(brl('25.00'));
    expect(result.toString()).toBe('-15.00');
    expect(result.isNegative()).toBe(true);
  });

  it('negates', () => {
    expect(brl('5.00').negate().toString()).toBe('-5.00');
  });

  it('is immutable: operations return new instances', () => {
    const a = brl('10.00');
    const b = a.add(brl('1.00'));
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('11.00');
    expect(a).not.toBe(b);
  });

  it('refuses to mix currencies', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Money comparisons', () => {
  it('zero', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').toString()).toBe('0.00');
    expect(brl('0.01').isZero()).toBe(false);
  });

  it('sign checks', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
  });

  it('isLessThan and equals compare by value and currency', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
  });
});
