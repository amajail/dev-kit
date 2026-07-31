/**
 * Money value object — the family's single implementation.
 *
 * Replaces the two copy-pasted `Money` classes that lived in my-afip and
 * my-finances (`src/domain/value-objects/Money.js` in each). API is the union
 * of those copies; dependency-free so both Node backends and the Astro
 * dashboards can consume it.
 *
 * Amounts are rounded to 2 decimals on construction. Instances are frozen.
 * Cross-currency arithmetic throws — convert explicitly with `convertTo`.
 */

'use strict';

class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    if (field) this.field = field;
  }

  static forField(field, message) {
    return new ValidationError(`${field}: ${message}`, field);
  }
}

class DomainError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DomainError';
  }
}

const CURRENCY_RE = /^[A-Z]{3}$/;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

class Money {
  /**
   * @param {number|string} amount - finite number (negative allowed)
   * @param {string} [currency='ARS'] - 3-letter ISO code (case-insensitive)
   * @throws {ValidationError}
   */
  constructor(amount, currency = 'ARS') {
    const numAmount = typeof amount === 'number' ? amount : parseFloat(amount);
    if (Number.isNaN(numAmount) || !Number.isFinite(numAmount)) {
      throw ValidationError.forField('amount', 'Amount must be a valid finite number');
    }
    const normalized = String(currency).trim().toUpperCase();
    if (!CURRENCY_RE.test(normalized)) {
      throw ValidationError.forField('currency', `Invalid currency code: ${currency}`);
    }

    Object.defineProperty(this, '_amount', { value: round2(numAmount), enumerable: false });
    Object.defineProperty(this, '_currency', { value: normalized, enumerable: false });
    Object.freeze(this);
  }

  get amount() {
    return this._amount;
  }

  get currency() {
    return this._currency;
  }

  isZero() {
    return this._amount === 0;
  }

  isPositive() {
    return this._amount > 0;
  }

  isNegative() {
    return this._amount < 0;
  }

  /** @param {Money} other @returns {Money} @throws {DomainError} on currency mismatch */
  add(other) {
    this._ensureSameCurrency(other);
    return new Money(this._amount + other._amount, this._currency);
  }

  /** @param {Money} other @returns {Money} @throws {DomainError} on currency mismatch */
  subtract(other) {
    this._ensureSameCurrency(other);
    return new Money(this._amount - other._amount, this._currency);
  }

  /** @param {number} multiplier @returns {Money} */
  multiply(multiplier) {
    if (!Number.isFinite(multiplier)) {
      throw ValidationError.forField('multiplier', 'Multiplier must be a finite number');
    }
    return new Money(this._amount * multiplier, this._currency);
  }

  /** @param {number} divisor @returns {Money} @throws {DomainError} on division by zero */
  divide(divisor) {
    if (!Number.isFinite(divisor)) {
      throw ValidationError.forField('divisor', 'Divisor must be a finite number');
    }
    if (divisor === 0) {
      throw new DomainError('Cannot divide by zero');
    }
    return new Money(this._amount / divisor, this._currency);
  }

  /** @param {number} percentage e.g. 21 for 21% @returns {Money} */
  percentage(percentage) {
    if (!Number.isFinite(percentage)) {
      throw ValidationError.forField('percentage', 'Percentage must be a finite number');
    }
    return new Money((this._amount * percentage) / 100, this._currency);
  }

  /**
   * Convert to another currency at an explicit rate. There is deliberately no
   * implicit or default rate — a missing rate is the caller's error, never 1:1
   * (the silent-1:1 fallback is exactly the bug this package exists to end).
   * @param {string} toCurrency
   * @param {number} exchangeRate - units of `toCurrency` per unit of this currency
   * @returns {Money}
   */
  convertTo(toCurrency, exchangeRate) {
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      throw ValidationError.forField('exchangeRate', 'Exchange rate must be a positive finite number');
    }
    return new Money(this._amount * exchangeRate, toCurrency);
  }

  /** @param {Money} other @returns {number} -1|0|1 @throws {DomainError} on currency mismatch */
  compareTo(other) {
    this._ensureSameCurrency(other);
    if (this._amount < other._amount) return -1;
    if (this._amount > other._amount) return 1;
    return 0;
  }

  /** @param {Money} other @returns {boolean} false on currency mismatch (equality never throws) */
  equals(other) {
    return other instanceof Money && this._currency === other._currency && this._amount === other._amount;
  }

  isGreaterThan(other) {
    return this.compareTo(other) > 0;
  }

  isLessThan(other) {
    return this.compareTo(other) < 0;
  }

  isGreaterThanOrEqual(other) {
    return this.compareTo(other) >= 0;
  }

  isLessThanOrEqual(other) {
    return this.compareTo(other) <= 0;
  }

  abs() {
    return new Money(Math.abs(this._amount), this._currency);
  }

  negate() {
    return new Money(-this._amount, this._currency);
  }

  /**
   * es-AR display string (e.g. `$ 1.234,56`, `US$ 1.234,56`).
   * @param {{decimals?: number, showSymbol?: boolean}} [options]
   */
  format(options = {}) {
    // Lazy to keep money.js importable standalone via the "./money" export.
    const { formatCurrency } = require('./format');
    return formatCurrency(this._amount, { currency: this._currency, ...options });
  }

  toJSON() {
    return { amount: this._amount, currency: this._currency };
  }

  toString() {
    return this.format();
  }

  _ensureSameCurrency(other) {
    if (!(other instanceof Money)) {
      throw new DomainError('Operand must be a Money instance');
    }
    if (this._currency !== other._currency) {
      throw new DomainError(
        `Cannot operate on different currencies: ${this._currency} and ${other._currency}`
      );
    }
  }

  static of(amount, currency = 'ARS') {
    return new Money(amount, currency);
  }

  static zero(currency = 'ARS') {
    return new Money(0, currency);
  }

  /** @param {{amount: number, currency: string}} json */
  static fromJSON(json) {
    if (!json || typeof json !== 'object') {
      throw ValidationError.forField('json', 'Expected an object with amount and currency');
    }
    return new Money(json.amount, json.currency);
  }

  /** Sum one or more Money values of the same currency. */
  static sum(...moneys) {
    if (moneys.length === 0) {
      throw ValidationError.forField('moneys', 'sum() needs at least one Money');
    }
    return moneys.reduce((acc, m) => acc.add(m));
  }

  static min(...moneys) {
    if (moneys.length === 0) {
      throw ValidationError.forField('moneys', 'min() needs at least one Money');
    }
    return moneys.reduce((acc, m) => (m.isLessThan(acc) ? m : acc));
  }

  static max(...moneys) {
    if (moneys.length === 0) {
      throw ValidationError.forField('moneys', 'max() needs at least one Money');
    }
    return moneys.reduce((acc, m) => (m.isGreaterThan(acc) ? m : acc));
  }
}

module.exports = { Money, ValidationError, DomainError };
