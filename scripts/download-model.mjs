#!/usr/bin/env node
// Build-time model download: fetches the quantized Xenova/all-MiniLM-L6-v2
// weights once per Netlify build and writes them into
// netlify/functions/models/, so the deployed function never has to reach the
// Hugging Face CDN at runtime. That runtime fetch had no timeout and was
// hanging indefinitely on the live site (see generate-screening-background.js).

import { pipeline, env } from '@huggingface/transformers';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modelDir = path.join(__dirname, '..', 'netlify', 'functions', 'models');

env.localModelPath = modelDir;
env.cacheDir = modelDir;
env.allowLocalModels = true;
env.allowRemoteModels = true; // allowed only during this build-time download

console.log('Downloading Xenova/all-MiniLM-L6-v2 (dtype: q8) to', modelDir);

// Instantiating the pipeline triggers the download into modelDir.
await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });

console.log('Model download complete.');
