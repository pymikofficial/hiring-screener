#!/usr/bin/env node
// Smoke test for Hiring Screener, run against the LIVE deployed site (not
// local dev), since it hits real Netlify Functions + Blobs + the real
// Anthropic API + a real transformer model running inside the function.
//
// Usage: node scripts/smoke-test.mjs [base_url]
// Default base_url: https://hiring-screener.netlify.app

const BASE_URL = process.argv[2] || 'https://hiring-screener.netlify.app';
const POLL_MS = 2000;
const MAX_POLLS = 90; // 3-minute ceiling, matches the frontend's own timeout

const OPS_JD = `Operations Manager

We're hiring an Operations Manager to lead our warehouse and logistics team. Responsibilities include managing a team of 10-15 warehouse staff, optimizing supply chain workflows, coordinating with vendors and freight carriers, tracking KPIs for on-time delivery and fulfillment accuracy, and driving continuous process improvement using lean/Six Sigma methods. Requires 5+ years managing warehouse or logistics operations, experience with inventory management systems (WMS), strong vendor negotiation skills, and a track record of reducing operational costs. Bachelor's degree preferred.`;

const OPS_RESUME_HIGH_FIT = `Jordan Ellis
Operations Manager with 8 years of experience leading warehouse and logistics teams of up to 18 people. Implemented a new WMS that cut fulfillment errors by 30% and reduced average order processing time by 22%. Managed vendor relationships and freight carrier contracts across 6 regional distribution centers, negotiating a 12% reduction in shipping costs. Led a Lean Six Sigma initiative that reduced warehouse operating costs by 18% year over year. Tracked and reported KPIs including on-time delivery, inventory accuracy, and labor cost per unit shipped. B.S. in Supply Chain Management.`;

const DESIGN_RESUME_LOW_FIT = `Casey Morgan
Junior Graphic Designer with 1.5 years of experience creating social media visuals, brand illustrations, and marketing collateral. Proficient in Adobe Photoshop, Illustrator, and Figma. Designed a rebrand package for a boutique coffee shop including logo, packaging, and Instagram templates. Collaborated with a small marketing team on seasonal campaign graphics. Comfortable with typography, color theory, and basic motion graphics in After Effects. A.A. in Graphic Design.`;

function log(msg) { console.log(msg); }
function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS: ' + msg); }

async function submit(jd, resume) {
  const jobId = 'smoketest-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const kickoff = await fetch(`${BASE_URL}/.netlify/functions/generate-screening-background`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId, jd: { text: jd }, resume: { text: resume } })
  });
  return { jobId, kickoffStatus: kickoff.status };
}

async function poll(jobId, maxPolls = MAX_POLLS) {
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await fetch(`${BASE_URL}/.netlify/functions/check-screening?jobId=${encodeURIComponent(jobId)}`);
    } catch (e) {
      continue; // transient, keep polling
    }
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') {
      return data;
    }
  }
  return null;
}

async function main() {
  log(`Testing ${BASE_URL}\n`);

  // ============================================================
  // Case 1: high-fit (matching ops JD + ops resume)
  // ============================================================
  log('--- Case 1: high-fit (Operations Manager JD vs matching ops resume) ---');
  const t1 = Date.now();
  let kickoff1;
  try {
    kickoff1 = await submit(OPS_JD, OPS_RESUME_HIGH_FIT);
  } catch (e) {
    fail(`Could not reach generate-screening-background: ${e.message}`);
  }

  let record1 = null;
  if (kickoff1) {
    if (kickoff1.kickoffStatus !== 202 && kickoff1.kickoffStatus !== 200) {
      fail(`Unexpected status from background function: ${kickoff1.kickoffStatus}`);
    } else {
      record1 = await poll(kickoff1.jobId);
      const elapsed1 = ((Date.now() - t1) / 1000).toFixed(1);
      if (!record1) {
        fail(`Case 1 timed out after ~${(MAX_POLLS * POLL_MS / 1000)}s with no done/error status.`);
      } else if (record1.status === 'error') {
        fail(`Case 1 server returned an error: ${record1.message}`);
      } else {
        pass(`Case 1 completed in ${elapsed1}s. Score: ${record1.score}% (${record1.band})`);
        if (record1.score > 55) {
          pass(`High-fit score (${record1.score}%) is above the 55% threshold.`);
        } else {
          fail(`High-fit score (${record1.score}%) is NOT above the 55% threshold.`);
        }
        if ((record1.strengths || []).length > 0 && (record1.gaps || []).length >= 0 && (record1.questions || []).length > 0) {
          pass(`Case 1 has non-empty strengths (${record1.strengths.length}) and questions (${record1.questions.length}) arrays.`);
        } else {
          fail(`Case 1 is missing expected strengths/questions content.`);
        }
      }
    }
  }

  // ============================================================
  // Case 2: low-fit (same ops JD + unrelated design resume)
  // ============================================================
  log('\n--- Case 2: low-fit (same Operations Manager JD vs unrelated junior graphic designer resume) ---');
  const t2 = Date.now();
  let kickoff2;
  try {
    kickoff2 = await submit(OPS_JD, DESIGN_RESUME_LOW_FIT);
  } catch (e) {
    fail(`Could not reach generate-screening-background: ${e.message}`);
  }

  let record2 = null;
  if (kickoff2) {
    if (kickoff2.kickoffStatus !== 202 && kickoff2.kickoffStatus !== 200) {
      fail(`Unexpected status from background function: ${kickoff2.kickoffStatus}`);
    } else {
      record2 = await poll(kickoff2.jobId);
      const elapsed2 = ((Date.now() - t2) / 1000).toFixed(1);
      if (!record2) {
        fail(`Case 2 timed out after ~${(MAX_POLLS * POLL_MS / 1000)}s with no done/error status.`);
      } else if (record2.status === 'error') {
        fail(`Case 2 server returned an error: ${record2.message}`);
      } else {
        pass(`Case 2 completed in ${elapsed2}s. Score: ${record2.score}% (${record2.band})`);
        if ((record2.gaps || []).length > 0) {
          pass(`Case 2 has a non-empty gaps array (${record2.gaps.length} gaps).`);
        } else {
          fail(`Case 2 gaps array is empty, expected gaps for a clearly unrelated resume.`);
        }
      }
    }
  }

  // ============================================================
  // Case 3: score separation (the real proof embeddings are working)
  // ============================================================
  log('\n--- Case 3: score separation (the single most important check) ---');
  if (record1 && record1.status === 'done' && record2 && record2.status === 'done') {
    const gap = record1.score - record2.score;
    log(`High-fit score: ${record1.score}% | Low-fit score: ${record2.score}% | Gap: ${gap} points`);
    if (gap >= 15) {
      pass(`High-fit score is at least 15 points above low-fit score (actual gap: ${gap} points). This is the real evidence the embedding model is separating matched from unrelated pairs, not producing noise.`);
    } else {
      fail(`Expected at least a 15-point gap between high-fit and low-fit scores, got ${gap} points. This would suggest the scoring is not meaningfully semantic.`);
    }
  } else {
    fail(`Cannot check score separation, one or both cases did not complete successfully.`);
  }

  // ============================================================
  // Case 4: Claude did not fabricate a different score
  // ============================================================
  log('\n--- Case 4: interpretation text does not restate a different score ---');
  if (record1 && record1.status === 'done') {
    const interp = record1.interpretation || '';
    const numbersInText = (interp.match(/\b(\d{1,3})%/g) || []).map((s) => parseInt(s, 10));
    const contradicting = numbersInText.filter((n) => Math.abs(n - record1.score) > 2);
    if (contradicting.length === 0) {
      pass(`Case 1 interpretation text does not contain a contradicting percentage (computed score: ${record1.score}%).`);
    } else {
      fail(`Case 1 interpretation text mentions conflicting percentage(s): ${contradicting.join(', ')} vs computed score ${record1.score}%.`);
    }
  } else {
    fail(`Cannot check interpretation text, Case 1 did not complete successfully.`);
  }

  log('\n=== SCORE SUMMARY ===');
  log(`High-fit (matched) score:   ${record1 ? record1.score + '%' : 'N/A'}`);
  log(`Low-fit (unrelated) score:  ${record2 ? record2.score + '%' : 'N/A'}`);
  log('\nSmoke test complete.');
}

main();
