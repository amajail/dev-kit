'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Money, ValidationError, DomainError } = require('../src/money');

test('constructs, rounds to 2 decimals, normalizes currency', () => {
  const m = new Money(10.005, 'ars');
  assert.equal(m.amount, 10.01);
  assert.equal(m.currency, 'ARS');
  assert.ok(Object.isFrozen(m));
});

test('rejects non-finite amounts and bad currencies with field errors', () => {
  assert.throws(() => new Money(NaN), (e) => e instanceof ValidationError && e.field === 'amount');
  assert.throws(() => new Money(Infinity), ValidationError);
  assert.throws(() => new Money('nope'), ValidationError);
  assert.throws(() => new Money(1, 'PESOS'), (e) => e instanceof ValidationError && e.field === 'currency');
});

test('arithmetic stays in-currency and rounds', () => {
  const a = new Money(10.1);
  const b = new Money(0.2);
  assert.equal(a.add(b).amount, 10.3);
  assert.equal(a.subtract(b).amount, 9.9);
  assert.equal(a.multiply(3).amount, 30.3);
  assert.equal(a.divide(2).amount, 5.05);
  assert.equal(new Money(1000).percentage(21).amount, 210);
});

test('cross-currency arithmetic throws DomainError; equals returns false', () => {
  const ars = new Money(1, 'ARS');
  const usd = new Money(1, 'USD');
  assert.throws(() => ars.add(usd), DomainError);
  assert.throws(() => ars.compareTo(usd), DomainError);
  assert.equal(ars.equals(usd), false);
  assert.throws(() => ars.add('1'), DomainError);
});

test('divide by zero is a DomainError', () => {
  assert.throws(() => new Money(1).divide(0), DomainError);
});

test('convertTo requires an explicit positive rate — no default, ever', () => {
  const usd = new Money(100, 'USD');
  assert.equal(usd.convertTo('ARS', 1431.4).amount, 143140);
  assert.throws(() => usd.convertTo('ARS'), ValidationError);
  assert.throws(() => usd.convertTo('ARS', 0), ValidationError);
  assert.throws(() => usd.convertTo('ARS', -1), ValidationError);
});

test('comparisons, sign helpers, abs/negate', () => {
  const five = new Money(5);
  const three = new Money(3);
  assert.equal(five.compareTo(three), 1);
  assert.ok(five.isGreaterThan(three));
  assert.ok(three.isLessThanOrEqual(three));
  assert.ok(Money.zero().isZero());
  assert.ok(new Money(-2).isNegative());
  assert.equal(new Money(-2).abs().amount, 2);
  assert.equal(five.negate().amount, -5);
});

test('statics: of, zero, fromJSON, sum/min/max', () => {
  assert.ok(Money.of(1).equals(new Money(1)));
  assert.deepEqual(Money.fromJSON({ amount: 2.5, currency: 'USD' }).toJSON(), {
    amount: 2.5,
    currency: 'USD',
  });
  assert.throws(() => Money.fromJSON(null), ValidationError);
  const sum = Money.sum(new Money(1), new Money(2), new Money(3.5));
  assert.equal(sum.amount, 6.5);
  assert.equal(Money.min(new Money(2), new Money(1)).amount, 1);
  assert.equal(Money.max(new Money(2), new Money(1)).amount, 2);
  assert.throws(() => Money.sum(), ValidationError);
});

test('format is es-AR', () => {
  const s = new Money(1234567.89).format();
  assert.match(s, /1\.234\.567,89/);
});
