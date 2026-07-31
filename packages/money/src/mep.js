/**
 * MEP (dólar bolsa) rate fetcher with an EXPLICIT failure state.
 *
 * A failure is always a thrown `MepRateError` — this function never returns a
 * default, a stale value, or 1:1. The silent `mepRate = 1` fallback once put
 * ARS:USD parity into a portfolio summary and a weekly analysis prompt with
 * no signal (my-finances, fixed as `fxDegraded`); this fetcher exists so no
 * app in the family reimplements that mistake.
 *
 * Source: dolarapi.com `/v1/dolares/bolsa` (public JSON, no auth); the rate is
 * `venta` — the conventional MEP rate for Argentine portfolio valuation.
 */

'use strict';

const DEFAULT_BASE_URL = 'https://dolarapi.com/v1/dolares';
const DEFAULT_TIMEOUT_MS = 10000;

class MepRateError extends Error {
  constructor(reason, cause) {
    super(reason);
    this.name = 'MepRateError';
    if (cause) this.cause = cause;
  }
}

/**
 * @param {Object} [opts]
 * @param {Function} [opts.fetcher] - fetch-compatible (defaults to global fetch)
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{rate: number, asOf: string|null}>} `asOf` is `YYYY-MM-DD` when the API provides it
 * @throws {MepRateError} on timeout, non-2xx, malformed payload, or an unusable rate
 */
async function fetchMepRate({ fetcher, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetcher || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    throw new MepRateError('no fetch implementation available (Node 18+ required, or pass fetcher)');
  }

  const url = `${baseUrl.replace(/\/$/, '')}/bolsa`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(url, { signal: controller.signal });
  } catch (err) {
    throw new MepRateError(
      err && err.name === 'AbortError'
        ? `timeout after ${timeoutMs}ms fetching MEP rate`
        : `fetch failed: ${err && err.message ? err.message : String(err)}`,
      err
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res || typeof res.ok !== 'boolean' || !res.ok) {
    throw new MepRateError(`non-2xx response: ${res && res.status ? res.status : 'unknown'}`);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new MepRateError(`response was not valid JSON: ${err.message}`, err);
  }

  const rate = Number(body && body.venta);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new MepRateError('bolsa quote has no usable `venta` rate');
  }

  const asOf =
    body && typeof body.fechaActualizacion === 'string' && body.fechaActualizacion.length >= 10
      ? body.fechaActualizacion.slice(0, 10)
      : null;

  return { rate, asOf };
}

module.exports = { fetchMepRate, MepRateError };
