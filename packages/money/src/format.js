/**
 * es-AR money formatting — the one place the family formats amounts.
 *
 * `$ 1.234.567,89` (dot thousands, comma decimals) via
 * `Intl.NumberFormat('es-AR')`. The numbers on screen have to match the
 * statement being reconciled — never switch these helpers to en-US digits
 * (my-expenses CLAUDE.md).
 */

'use strict';

/**
 * @param {number} amount
 * @param {{currency?: string, decimals?: number, showSymbol?: boolean}} [options]
 * @returns {string} e.g. `$ 1.234,56` (ARS), `US$ 1.234,56` (USD)
 */
function formatCurrency(amount, options = {}) {
  const { currency = 'ARS', decimals = 2, showSymbol = true } = options;
  const formatted = new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
  return showSymbol ? formatted : formatted.replace(/[^\d.,-]/g, '').trim();
}

/** @param {number} amount */
function formatARS(amount) {
  return formatCurrency(amount, { currency: 'ARS' });
}

/** @param {number} amount */
function formatUSD(amount) {
  return formatCurrency(amount, { currency: 'USD' });
}

/**
 * Plain es-AR number with thousands separators.
 * @param {number} num
 * @param {number} [decimals=0]
 */
function formatNumber(num, decimals = 0) {
  return new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num);
}

/**
 * @param {number} value - already in percent units (63.2, not 0.632)
 * @param {number} [decimals=2]
 */
function formatPercentage(value, decimals = 2) {
  return `${value.toFixed(decimals)}%`;
}

/** Currency code → display symbol (AFIP's PES/DOL aliases included). */
function getCurrencySymbol(currencyCode) {
  const symbols = {
    ARS: '$',
    PES: '$',
    USD: 'US$',
    DOL: 'US$',
    EUR: '€',
    BRL: 'R$',
  };
  return symbols[currencyCode] || currencyCode;
}

module.exports = {
  formatCurrency,
  formatARS,
  formatUSD,
  formatNumber,
  formatPercentage,
  getCurrencySymbol,
};
