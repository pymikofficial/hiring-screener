// Hiring Screener ~ background function.
// Netlify auto-responds 202 for "-background" suffixed functions, so the slow
// work (model load + embeddings + one Claude call) happens after the client
// has already been released. The client polls check-screening.js with the
// same jobId.
//
// Two-stage pipeline:
//   STAGE A (measurement, no AI): transformers.js loads a real sentence-
//   embedding model, embeds the JD and resume, computes cosine similarity.
//   This number is the fit score and is computed BEFORE Claude ever sees
//   anything, it cannot be talked up or down by a language model.
//   STAGE B (judgment, one Claude call): Claude receives the already-decided
//   score plus both documents and writes an interpretation, strengths, gaps,
//   and targeted interview questions. It is instructed not to recompute or
//   restate a different score.

const { getStore } = require('@netlify/blobs');
const { pipeline, env } = require('@huggingface/transformers');
const { extractText, getDocumentProxy } = require('unpdf');
const mammoth = require('mammoth');

// getStore MUST receive explicit siteID and token in this account's setup,
// or it throws "The environment has not been configured to use Netlify Blobs".
const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

// Lambda's filesystem is read-only except /tmp. The model weights (~90MB)
// download from the Hugging Face CDN on first use per container and are
// cached here so a warm container reuses them across invocations.
env.cacheDir = '/tmp/.cache/huggingface';
env.allowLocalModels = false;

const DAILY_CAP = 40;
const MAX_DOC_CHARS = 30000;
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const MIN_EXTRACTED_CHARS = 50; // below this, treat as "no extractable text"

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractorPromise;
}

exports.handler = async (event) => {
  const store = getStore({ name: 'hiring-screener', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    if (!jobId) return;

    await store.setJSON(jobId, { status: 'pending' });

    const jdInput = body.jd || {};
    const resumeInput = body.resume || {};

    // --- Daily rate limit ---
    const today = new Date().toISOString().slice(0, 10);
    const limitStore = getStore({ name: 'rate-limits', ...BLOBS_CONFIG });
    const counterKey = `screening-${today}`;
    let countSoFar = 0;
    try {
      const existing = await limitStore.get(counterKey);
      countSoFar = existing ? parseInt(existing, 10) : 0;
    } catch (e) {
      countSoFar = 0;
    }
    if (countSoFar >= DAILY_CAP) {
      await store.setJSON(jobId, { status: 'error', message: "Today's free screening limit has been reached. Come back tomorrow." });
      return;
    }

    // --- Resolve document text (paste or server-side file extraction) ---
    let jdText, resumeText;
    try {
      jdText = await resolveDocumentText(jdInput, 'Job description');
      resumeText = await resolveDocumentText(resumeInput, 'Resume');
    } catch (e) {
      await store.setJSON(jobId, { status: 'error', message: e.message });
      return;
    }

    jdText = jdText.slice(0, MAX_DOC_CHARS);
    resumeText = resumeText.slice(0, MAX_DOC_CHARS);

    // --- STAGE A: real embedding-based measurement, no AI involved ---
    const extractor = await getExtractor();
    const [jdVec, resumeVec] = await Promise.all([
      embed(extractor, jdText),
      embed(extractor, resumeText)
    ]);
    const similarity = cosineSimilarity(jdVec, resumeVec);
    const scorePercent = Math.round(Math.max(0, Math.min(1, similarity)) * 100);

    // --- STAGE B: one Claude call, judgment only, score is a fixed input ---
    const stageB = await runStageB(scorePercent, jdText, resumeText);

    await limitStore.set(counterKey, String(countSoFar + 1));

    await store.setJSON(jobId, {
      status: 'done',
      score: scorePercent,
      band: bandFor(scorePercent),
      interpretation: stageB.interpretation,
      strengths: stageB.strengths,
      gaps: stageB.gaps,
      questions: stageB.questions
    });
  } catch (err) {
    console.error('generate-screening error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, { status: 'error', message: 'Screening failed. Try again in a minute.' });
      } catch (e) {}
    }
  }
};

// ---------------------------------------------------------------------------

function bandFor(score) {
  if (score >= 60) return 'Strong fit';
  if (score >= 40) return 'Moderate fit';
  return 'Weak fit';
}

async function resolveDocumentText(input, label) {
  if (input.fileBase64) {
    const buffer = Buffer.from(input.fileBase64, 'base64');
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(`${label} file is too large (max 5MB).`);
    }
    const name = (input.fileName || '').toLowerCase();
    let text;
    if (name.endsWith('.pdf')) {
      text = await extractPdfText(buffer);
    } else if (name.endsWith('.docx')) {
      text = await extractDocxText(buffer);
    } else {
      throw new Error(`${label} file must be a .pdf or .docx.`);
    }
    if (!text || text.trim().length < MIN_EXTRACTED_CHARS) {
      throw new Error(`${label} appears to have no extractable text (it may be a scanned image with no text layer). Try pasting the text directly instead.`);
    }
    return text.trim();
  }

  const pasted = (input.text || '').trim();
  if (pasted.length < MIN_EXTRACTED_CHARS) {
    throw new Error(`${label} is missing or too short. Paste the full text or upload a file.`);
  }
  return pasted;
}

async function extractPdfText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

async function extractDocxText(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });
  return value;
}

async function embed(extractor, text) {
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function cosineSimilarity(a, b) {
  // Both vectors are already unit-length (normalize: true), so cosine
  // similarity is just the dot product.
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

async function runStageB(scorePercent, jdText, resumeText) {
  const prompt = STAGE_B_PROMPT
    .replace('{{SCORE}}', String(scorePercent))
    .replace('{{JD}}', jdText)
    .replace('{{RESUME}}', resumeText);

  const raw = await callClaude([{ role: 'user', content: prompt }]);
  const parsed = parseModelJSON(raw);

  return {
    interpretation: typeof parsed.interpretation === 'string' ? parsed.interpretation : '',
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
    gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions : []
  };
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseModelJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model did not return JSON.');
  }
  return JSON.parse(clean.slice(start, end + 1));
}

const STAGE_B_PROMPT = `You are a hiring analyst. A fit score between a job description and a resume has ALREADY been computed by a separate mathematical process (sentence-embedding cosine similarity). That score is fixed and final: {{SCORE}} out of 100.

Your job is judgment, not measurement. Do NOT recompute, restate as a different number, contradict, or second-guess the score, treat it as ground truth input. Do NOT invent any resume detail, skill, employer, or credential that is not literally present in the resume text below.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:
{
  "interpretation": "2-3 sentences in plain English explaining what a {{SCORE}}/100 fit score means for this specific pairing, grounded in what you actually see in both documents",
  "strengths": ["specific requirement from the JD that the resume clearly meets, citing the actual resume content", "..."],
  "gaps": ["specific requirement from the JD that is clearly missing or unclear in the resume", "..."],
  "questions": ["a targeted interview question that probes one of the identified gaps directly", "... (4-6 total, each tied to a specific gap, not generic)"]
}

<job_description>
{{JD}}
</job_description>

<resume>
{{RESUME}}
</resume>`;

module.exports.bandFor = bandFor;
module.exports.cosineSimilarity = cosineSimilarity;
module.exports.parseModelJSON = parseModelJSON;
