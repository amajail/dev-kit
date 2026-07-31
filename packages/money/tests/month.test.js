'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMonthKey, monthKey, monthRange, addMonths } = require('../src/month');

test('isMonthKey accepts YYYY-MM only', () => {
  assert.ok(isMonthKey('2026-07'));
  assert.ok(isMonthKey('2026-12'));
  assert.equal(isMonthKey('2026-13'), false);
  assert.equal(isMonthKey('2026-00'), false);
  assert.equal(isMonthKey('2026-7'), false);
  assert.equal(isMonthKey('2026-07-01'), false);
  assert.equal(isMonthKey(202607), false);
});

test('monthKey is UTC-based', () => {
  assert.equal(monthKey(new Date(Date.UTC(2026, 6, 31, 23, 59))), '2026-07');
  // 2026-07-31T23:00-03:00 is already August in UTC — the key must not depend on local tz
  assert.equal(monthKey(new Date('2026-07-31T23:00:00-03:00')), '2026-08');
  assert.throws(() => monthKey(new Date('garbage')), TypeError);
});

test('monthRange handles month lengths and leap years', () => {
  assert.deepEqual(monthRange('2026-07'), { startDate: '2026-07-01', endDate: '2026-07-31' });
  assert.deepEqual(monthRange('2026-02'), { startDate: '2026-02-01', endDate: '2026-02-28' });
  assert.deepEqual(monthRange('2028-02'), { startDate: '2028-02-01', endDate: '2028-02-29' });
  assert.throws(() => monthRange('2026-7'), TypeError);
});

test('addMonths crosses year boundaries both ways', () => {
  assert.equal(addMonths('2026-07', 1), '2026-08');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-07', -19), '2024-12');
  assert.throws(() => addMonths('2026-07', 1.5), TypeError);
});
