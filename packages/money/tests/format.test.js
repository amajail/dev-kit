'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatCurrency,
  formatARS,
  formatUSD,
  formatNumber,
  formatPercentage,
  getCurrencySymbol,
} = require('../src/format');

test('formatARS: dot thousands, comma decimals, $ symbol', () => {
  const s = formatARS(1234567.89);
  assert.match(s, /1\.234\.567,89/);
  assert.match(s, /\$/);
});

test('formatUSD carries the US$ symbol', () => {
  assert.match(formatUSD(1234.5), /US\$/);
});

test('formatCurrency options: decimals and showSymbol', () => {
  assert.match(formatCurrency(1000, { decimals: 0 }), /1\.000/);
  const bare = formatCurrency(1234.56, { showSymbol: false });
  assert.doesNotMatch(bare, /\$/);
  assert.match(bare, /1\.234,56/);
  const negative = formatCurrency(-1234.56, { showSymbol: false });
  assert.match(negative, /-/);
});

test('formatNumber and formatPercentage', () => {
  assert.equal(formatNumber(1234567), '1.234.567');
  assert.match(formatNumber(12.345, 2), /12,3[45]/);
  assert.equal(formatPercentage(63.2), '63.20%');
  assert.equal(formatPercentage(63.256, 1), '63.3%');
});

test('getCurrencySymbol knows AFIP aliases and falls back to the code', () => {
  assert.equal(getCurrencySymbol('ARS'), '$');
  assert.equal(getCurrencySymbol('PES'), '$');
  assert.equal(getCurrencySymbol('USD'), 'US$');
  assert.equal(getCurrencySymbol('DOL'), 'US$');
  assert.equal(getCurrencySymbol('XYZ'), 'XYZ');
});
