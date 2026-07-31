/**
 * `YYYY-MM` month keys — the family's wire format for months (frozen in
 * dev-kit docs/mcp-contracts.md). All computations are UTC so a key never
 * shifts with the machine's timezone.
 */

'use strict';

const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** @param {*} value @returns {boolean} */
function isMonthKey(value) {
  return typeof value === 'string' && MONTH_KEY_RE.test(value);
}

/**
 * @param {Date} [date=new Date()]
 * @returns {string} `YYYY-MM` (UTC)
 */
function monthKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('monthKey expects a valid Date');
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * First and last day of a month, for date-range queries.
 * @param {string} key - `YYYY-MM`
 * @returns {{startDate: string, endDate: string}} `YYYY-MM-DD` bounds, inclusive
 */
function monthRange(key) {
  assertKey(key);
  const [year, month] = key.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startDate: `${key}-01`,
    endDate: `${key}-${String(lastDay).padStart(2, '0')}`,
  };
}

/**
 * @param {string} key - `YYYY-MM`
 * @param {number} n - months to add (negative to go back)
 * @returns {string} `YYYY-MM`
 */
function addMonths(key, n) {
  assertKey(key);
  if (!Number.isInteger(n)) {
    throw new TypeError('addMonths expects an integer month count');
  }
  const [year, month] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1 + n, 1));
  return monthKey(d);
}

function assertKey(key) {
  if (!isMonthKey(key)) {
    throw new TypeError(`Expected a YYYY-MM month key, got: ${key}`);
  }
}

module.exports = { isMonthKey, monthKey, monthRange, addMonths };
