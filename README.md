# Hiring Screener

Paste (or upload as .pdf/.docx) a job description and a resume. Get back a fit score computed by comparing real transformer sentence-embeddings, not keyword overlap, plus one AI call that turns that score into a plain-English interpretation, specific strengths, specific gaps, and 4-6 interview questions targeted at the gaps.

**Live:** [hiring-screener.netlify.app](https://hiring-screener.netlify.app)

This is stage 3 of a larger, deliberately unbuilt "Hiring OS": Sourcing → JD Optimizer → **Screening (this tool)** → Interview Kit → Comparison → Onboarding. The page shows the full roadmap; only Screening is live. That's the point, see below.

## The headache

Anyone can wire a text box to an LLM and call it "AI-powered screening." Most tools that claim this are a single prompt wearing a UI, and it works well enough that nobody checks the claim. Some go further and claim *semantic* or *ML-based* matching while quietly doing string/keyword overlap under the hood, because it's easier and nobody can tell the difference by looking at the output.

That second failure mode isn't hypothetical here: an earlier tool of mine loaded a real embedding model, then never actually called it, scoring resumes on word overlap while the UI implied semantic matching. It shipped, it looked fine, and it was lying about how it worked. This build exists partly to not repeat that. The fit score in this tool is a real cosine similarity between two sentence-transformer vectors, computed in plain JavaScript before Claude is ever invoked, and the smoke test below specifically checks for the signature of a *real* embedding model (meaningful separation between a matched and an unrelated pair) rather than trusting the label on the tin.

The other headache, the more mundane one, is scope. It would be easy to promise a "full hiring platform" and ship six shallow half-features. Judgment says: build the one piece that's a genuine, self-contained keystone (a trustworthy fit score), build it completely and honestly, and be explicit on the page about what's deliberately not built yet and why it's sequenced that way.

## The machinery

Same proven base as prior cosmik.work tools: single-page frontend, two Netlify Functions, Netlify Blobs for job state, background-function pattern to dodge the ~10s synchronous timeout. One structural difference: a genuine two-stage pipeline where measurement and judgment are different code paths, not one prompt doing both.

### Stage A: measurement, zero AI

`generate-screening-background.js` loads `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`, running the actual ONNX model inside the Netlify Function (not calling an external embeddings API). Both documents are embedded with `pooling: 'mean', normalize: true`, so each vector is unit-length and cosine similarity reduces to a plain dot product. That similarity, converted to a 0-100 percentage, **is** the fit score. Claude never sees the raw documents before this number exists, and is never asked to produce or adjust it. This mirrors the guardrail in `investor-update-drafter` (the model never writes a number it wasn't handed), applied to a much heavier computation.

This was the one genuinely unverified piece of the whole build: nobody had run a real transformer inside a Netlify Function before. It was proven locally first, in isolation, before any function code was written: load the model, embed a matched JD/resume pair and an unrelated pair, confirm the matched pair scores meaningfully higher. It did (0.74 vs 0.18 similarity on the first local test), so the same pipeline was wired into the function with matching guardrail thresholds (see Smoke test below).

### Stage B: judgment, one Claude call

The background function sends Claude the already-computed score, the JD text, and the resume text, and asks for a plain-English interpretation, grounded strengths, grounded gaps, and gap-targeted interview questions as JSON. The prompt explicitly forbids recomputing or contradicting the score, and forbids inventing resume details not present in the text. The response is not cross-checked by a second call (no auditor pass, unlike some earlier tools); the guardrail here is architectural, not a second opinion, because the number that matters most is never in Claude's hands to begin with.

### Document handling

- Paste-or-upload for both documents. Uploads (.pdf, .docx) are read client-side as base64 and extracted server-side in the function (`unpdf` for PDF, `mammoth` for DOCX), verified more reliable than bundling extraction into the browser.
- If extraction yields near-empty text (e.g. a scanned image PDF with no text layer), the function returns a clear error rather than scoring on garbage.
- Input caps: 30,000 characters per document after extraction, 5MB per uploaded file.

### Guardrails

- **No PII scrub on JD/resume text.** This is a deliberate, documented difference from other cosmik.work tools: the resume's name and contact info aren't noise, they're part of what's being analyzed, and scrubbing them would break the analysis. The privacy story instead: documents are processed transiently, the raw text is discarded after the score and analysis are computed, only the computed result (score, interpretation, strengths, gaps, questions) is persisted in Blobs, and nothing is used for any purpose beyond generating that one result.
- **Daily rate limit**: 40 screenings/day, Blobs-backed counter.
- **Cold start**: model weights (~90MB) download from the Hugging Face CDN into `/tmp` on first invocation per container. This is fine inside a background function (no 10s ceiling), so the frontend polls for up to 3 minutes instead of the ~90s used by lighter tools.

## Environment variables

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Shared Anthropic API key (reused across cosmik.work tools) |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token (shared) |

`getStore()` must be called with explicit `siteID` and `token` in this account's setup, or it throws `"The environment has not been configured to use Netlify Blobs"`.

## Run it locally

1. Clone this repo.
2. `npm install`
3. `netlify dev` (with the three env vars set)

## Smoke test

`node scripts/smoke-test.mjs` runs against the live site and verifies:
- A well-matched Operations Manager JD/resume pair scores above 55%.
- The same JD against an unrelated junior-graphic-designer resume scores meaningfully lower, by at least 15 points. This is the real proof the scoring is embedding-based and not noise or keyword luck, a fake keyword-overlap scorer would not reliably separate these two cases the way a real semantic model does.
- Both cases return non-empty strengths/gaps/interview-question arrays.
- Claude's interpretation text doesn't restate a different score than the one actually computed.

Built by [Soumik Chatterjee](https://cosmik.work).
