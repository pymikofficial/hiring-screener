// TEMPORARY diagnostic function, not part of the product. Tests the exact
// Blobs write path generate-screening-background.js uses, both with the
// explicit siteID/token override and with Netlify's auto-detected runtime
// credentials, and returns the real result synchronously instead of via the
// pending/done/error polling record. Delete once the hang investigation is
// closed out.

const { getStore } = require('@netlify/blobs');

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

exports.handler = async () => {
  const results = {};

  // Attempt 1: explicit siteID + token override (what the real function does today)
  try {
    const store = getStore({
      name: 'hiring-screener',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN
    });
    await withTimeout(
      store.setJSON('diag-write-explicit', { ok: true, ts: Date.now() }),
      10000,
      'explicit-config write timed out after 10s'
    );
    results.explicitConfig = 'SUCCESS';
  } catch (e) {
    results.explicitConfig = 'FAILED: ' + e.message;
  }

  // Attempt 2: no override, rely on Netlify's auto-injected in-function context
  try {
    const store = getStore('hiring-screener');
    await withTimeout(
      store.setJSON('diag-write-auto', { ok: true, ts: Date.now() }),
      10000,
      'auto-config write timed out after 10s'
    );
    results.autoConfig = 'SUCCESS';
  } catch (e) {
    results.autoConfig = 'FAILED: ' + e.message;
  }

  results.envPresent = {
    NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
    NETLIFY_BLOBS_TOKEN: !!process.env.NETLIFY_BLOBS_TOKEN
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(results, null, 2)
  };
};
