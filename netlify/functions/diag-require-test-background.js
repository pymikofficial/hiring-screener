// TEMPORARY diagnostic. Isolates whether require('@huggingface/transformers')
// (which pulls in onnxruntime-node's native binary) hangs or crashes at
// module-load time inside this specific deployed Lambda, separate from
// everything else generate-screening-background.js does. Delete once the
// hang investigation is closed out.

const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  const store = getStore({
    name: 'hiring-screener',
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_BLOBS_TOKEN
  });

  await store.setJSON('diag-transformers-require', { stage: 'before-require', ts: Date.now() });

  try {
    const t0 = Date.now();
    const { pipeline, env } = require('@huggingface/transformers');
    await store.setJSON('diag-transformers-require', { stage: 'after-require', ms: Date.now() - t0, ts: Date.now() });

    env.localModelPath = require('node:path').join(__dirname, 'models');
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.useFSCache = false;
    env.useBrowserCache = false;

    const t1 = Date.now();
    const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
    await store.setJSON('diag-transformers-require', { stage: 'after-pipeline-load', ms: Date.now() - t1, ts: Date.now() });

    const t2 = Date.now();
    const out = await extractor('hello world', { pooling: 'mean', normalize: true });
    await store.setJSON('diag-transformers-require', { stage: 'after-embed', ms: Date.now() - t2, dims: out.data.length, ts: Date.now() });
  } catch (e) {
    await store.setJSON('diag-transformers-require', { stage: 'threw', error: e.message, stack: (e.stack || '').slice(0, 500), ts: Date.now() });
  }
};
