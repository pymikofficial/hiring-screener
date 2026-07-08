#!/usr/bin/env node
// Postinstall: trims transformers.js's node_modules footprint so the Netlify
// Function bundle stays under the 250MB zip cap.
//
// onnxruntime-node ships win32/linux/darwin native binaries inside a SINGLE
// npm package (not split via optionalDependencies like most native
// packages), so all three platforms' ~70MB binaries land in node_modules
// regardless of host OS. onnxruntime-web (91MB) is a plain (non-optional)
// dependency of @huggingface/transformers but is never required by
// dist/transformers.node.cjs, the only file our code actually loads
// (verified by grepping require() calls in that file).
//
// Platform-aware so this is safe to run in local dev too (keeps the current
// platform's onnxruntime-node binary, only prunes the others).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function rm(relPath) {
  const full = path.join(ROOT, relPath);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log('[prune-deps] removed', relPath);
  }
}

const ALL_PLATFORMS = ['win32', 'linux', 'darwin'];
for (const p of ALL_PLATFORMS) {
  if (p !== process.platform) {
    rm(`node_modules/onnxruntime-node/bin/napi-v3/${p}`);
  }
}

// Each platform dir also ships both x64 and arm64 binaries (again, not split
// via optionalDependencies). Netlify Functions run on x86_64 Lambda, so drop
// arm64 for whichever platform dir we kept above.
rm(`node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/arm64`);

// GPU execution provider libraries, fetched by onnxruntime-node's own
// postinstall script (node ./script/install) on Linux specifically, invisible
// when developing on Windows/Mac. libonnxruntime_providers_cuda.so alone is
// ~327MB. We only ever run the default CPU provider (a small model doing text
// embeddings has no use for a GPU here), and onnxruntime-node loads these
// lazily only if a caller explicitly requests that execution provider, so
// removing them is safe.
rm(`node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/x64/libonnxruntime_providers_cuda.so`);
rm(`node_modules/onnxruntime-node/bin/napi-v3/${process.platform}/x64/libonnxruntime_providers_tensorrt.so`);

rm('node_modules/onnxruntime-web');

const distDir = path.join(ROOT, 'node_modules/@huggingface/transformers/dist');
const KEEP_FILES = new Set(['transformers.node.cjs', 'transformers.node.mjs']);
if (fs.existsSync(distDir)) {
  for (const file of fs.readdirSync(distDir)) {
    if (!KEEP_FILES.has(file)) {
      fs.rmSync(path.join(distDir, file), { force: true });
    }
  }
  console.log('[prune-deps] trimmed @huggingface/transformers/dist to', [...KEEP_FILES].join(', '));
}
