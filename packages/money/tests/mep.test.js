'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchMepRate, MepRateError } = require('../src/mep');

function fakeFetch(response) {
  return async () => response;
}

test('returns {rate, asOf} from a healthy bolsa quote', async () => {
  const result = await fetchMepRate({
    fetcher: fakeFetch({
      ok: true,
      json: async () => ({ casa: 'bolsa', venta: 1431.4, fechaActualizacion: '2026-07-30T18:00:00.000Z' }),
    }),
  });
  assert.deepEqual(result, { rate: 1431.4, asOf: '2026-07-30' });
});

test('asOf is null when the API omits the timestamp', async () => {
  const result = await fetchMepRate({
    fetcher: fakeFetch({ ok: true, json: async () => ({ venta: 1000 }) }),
  });
  assert.deepEqual(result, { rate: 1000, asOf: null });
});

test('non-2xx is a MepRateError — never a default rate', async () => {
  await assert.rejects(
    fetchMepRate({ fetcher: fakeFetch({ ok: false, status: 503 }) }),
    (e) => e instanceof MepRateError && /503/.test(e.message)
  );
});

test('network failure is a MepRateError carrying the cause', async () => {
  const boom = new Error('ECONNRESET');
  await assert.rejects(
    fetchMepRate({ fetcher: async () => { throw boom; } }),
    (e) => e instanceof MepRateError && e.cause === boom
  );
});

test('malformed JSON is a MepRateError', async () => {
  await assert.rejects(
    fetchMepRate({ fetcher: fakeFetch({ ok: true, json: async () => { throw new Error('bad json'); } }) }),
    MepRateError
  );
});

test('unusable venta (missing, zero, negative, non-numeric) is a MepRateError', async () => {
  for (const venta of [undefined, 0, -5, 'not-a-number']) {
    await assert.rejects(
      fetchMepRate({ fetcher: fakeFetch({ ok: true, json: async () => ({ venta }) }) }),
      (e) => e instanceof MepRateError && /venta/.test(e.message),
      `venta=${venta} must reject`
    );
  }
});

test('timeout aborts and reports as MepRateError', async () => {
  const hangingFetch = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  await assert.rejects(
    fetchMepRate({ fetcher: hangingFetch, timeoutMs: 20 }),
    (e) => e instanceof MepRateError && /timeout/.test(e.message)
  );
});
