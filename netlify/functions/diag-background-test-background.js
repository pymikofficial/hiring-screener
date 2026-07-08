// TEMPORARY diagnostic. Does the simplest possible -background function ever
// actually execute its body on this site? Writes a Blobs record the instant
// it starts. Delete once the hang investigation is closed out.

const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  try {
    const store = getStore({
      name: 'hiring-screener',
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN
    });
    await store.setJSON('diag-background-ran', { ok: true, ts: Date.now() });
  } catch (e) {}
};
