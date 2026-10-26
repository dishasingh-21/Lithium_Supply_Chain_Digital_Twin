const fetch = require("node-fetch");

// Works with OpenAI's API as-is, and with any other provider that exposes
// the same "/v1/chat/completions" shape -- which includes NVIDIA's hosted
// NIM models at build.nvidia.com (the Nemotron family among them). To
// point this at NVIDIA instead of OpenAI, set in .env:
//   OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
//   OPENAI_API_KEY=nvapi-...                        (from build.nvidia.com/settings/api-keys)
//   OPENAI_MODEL=nvidia/nemotron-3-super-120b-a12b   (or another Nemotron model id from build.nvidia.com/models)
// The env var names stay "OPENAI_*" for simplicity -- they mean "the LLM
// endpoint this feature calls", not literally OpenAI.
const BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const CHAT_COMPLETIONS_URL = `${BASE_URL}/chat/completions`;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
// Strict JSON response mode (`response_format: {type: "json_object"}`) is
// an OpenAI-specific guarantee -- not every OpenAI-compatible provider
// honors that field, and some reject unrecognized request fields outright.
// It's only sent when talking to OpenAI itself. Every provider still gets
// the same strict "JSON object only" instruction in SYSTEM_PROMPT, and
// parsing below (extractJsonObject) tolerates a reply that isn't *purely*
// JSON, so a provider without real JSON mode still works correctly.
const USE_STRICT_JSON_MODE = BASE_URL.includes("api.openai.com");

const REQUIRED_KEYS = ["mcNarrative", "headline", "story", "risk", "regional"];

// Same friendly labels the client already shows instead of raw technical
// keys/codes (see client/supply-chain.js's PARAMETER_LABELS and
// client/how-it-works.js's NODE_TYPE_LABELS) -- duplicated here, same as
// the client duplicates them across its own two files, so the model gets
// plain-English names like "how much it can produce per week" instead of
// having to guess what "weekly_capacity" means.
const PARAMETER_LABELS = {
  weekly_capacity: "how much it can produce per week",
  yield_rate: "how much comes out usable (yield)",
  capacity_lce: "how much it can ship per week",
  lead_time_weeks: "how long shipments take to arrive",
  transport_loss: "how much is lost in transit",
};
const NODE_TYPE_LABELS = {
  extractor: "Extraction",
  processor: "Processing",
  manufacturer: "Precursor Manufacturing",
  assembler: "Assembly",
  oem: "OEM (vehicle manufacturer)",
  recycler: "Recycling",
};
function friendlyParam(key) {
  return (key && PARAMETER_LABELS[key]) || key;
}
function friendlyNodeType(key) {
  return (key && NODE_TYPE_LABELS[key]) || key;
}

/**
 * Trims the three raw dashboard JSON payloads down to just the numbers an
 * explanation actually needs. Keeping this small matters for two reasons:
 * it's cheaper/faster to send, and it stops the model from being tempted
 * to narrate the big per-week arrays instead of the headline numbers that
 * actually matter to a reader.
 */
function buildScenarioDigest({ regional, monteCarlo, chainFlow }) {
  const rawDisruption =
    (chainFlow && chainFlow.disruption) ||
    (monteCarlo && monteCarlo.disruption) ||
    (regional && regional.disruption) ||
    null;
  // Spell out, in plain English, exactly what was changed and why it's
  // called a "disruption" -- the model shouldn't have to infer that a
  // "reduction_pct" on a "parameter" at a "label" means a real-world shock
  // to one specific capability of one specific facility.
  const disruption = rawDisruption
    ? {
        ...rawDisruption,
        friendly_parameter: friendlyParam(rawDisruption.parameter),
        plain_english: `A ${(rawDisruption.reduction_pct * 100).toFixed(0)}% cut to ` +
          `${friendlyParam(rawDisruption.parameter)} at ${rawDisruption.label}, ` +
          `starting week ${rawDisruption.start_week} and lasting ${rawDisruption.duration_weeks} weeks.`,
      }
    : null;

  const nodes = Array.isArray(chainFlow && chainFlow.nodes)
    ? chainFlow.nodes.map((n) => {
        let tightestWeek = null;
        if (Array.isArray(n.disrupted_weekly_inventory) && n.disrupted_weekly_inventory.length > 0) {
          let minVal = Infinity;
          n.disrupted_weekly_inventory.forEach((v, w) => {
            if (v < minVal) {
              minVal = v;
              tightestWeek = w;
            }
          });
        }
        return {
          location: n.location,
          node_type: n.node_type,
          friendly_node_type: friendlyNodeType(n.node_type),
          baseline_fill_rate: n.baseline_fill_rate,
          disrupted_fill_rate: n.disrupted_fill_rate ?? null,
          tightest_week: tightestWeek,
        };
      })
    : [];

  const regions = Array.isArray(regional && regional.regions)
    ? regional.regions.map((r) => ({
        name: r.name,
        fill_rate: r.fill_rate,
        status: r.status,
        demand_share: r.demand_share,
      }))
    : [];

  return {
    disruption,
    monte_carlo: {
      n_trials: monteCarlo && monteCarlo.n_trials,
      summary: monteCarlo && monteCarlo.summary,
    },
    chain_nodes_in_order: nodes,
    overall_fill_rate: regional && regional.overall_fill_rate,
    overall_fill_rate_during_disruption: regional && regional.overall_fill_rate_during_disruption,
    service_level_target: regional && regional.service_level_target,
    regions,
  };
}

const SYSTEM_PROMPT = `You explain supply-chain disruption simulation results to a reader with
no background in supply chains or statistics. You will be given exact
computed numbers from a simulation as JSON. Use ONLY those numbers --
never invent, estimate, or round them differently than given, and never
state a fact that isn't directly supported by the data. Write in plain,
concrete sentences, no jargon left unexplained, no markdown formatting,
no bullet points, no headings -- prose paragraphs only.

CONTEXT -- what this simulation models (use this to interpret the numbers
correctly, don't just restate it): this is a digital twin of the lithium
supply chain feeding EV battery manufacturing in Rajasthan, India.
Material moves through stages in a fixed order -- Extraction (raw lithium
from deposits/brine), Processing (refining into battery-grade lithium
chemicals), Precursor Manufacturing (combining lithium with other
materials into battery precursors), Assembly (building battery packs),
and OEM (the vehicle manufacturer needing finished batteries); a
Recycling stage can feed reclaimed material back in. A stage's "fill
rate" is the share of that stage's weekly demand actually supplied --
100% means every order was met that week, lower numbers mean some demand
went unmet. A "disruption" is a modeled shock: a percentage cut applied
to one specific capability (e.g. how much a stage can produce, how much
survives processing, how reliably material ships onward) at one node or
transport link, for a set number of weeks -- simulating something like a
mine outage, a quality failure, or a border/customs delay. The
"disruption" object in the data already includes a "plain_english"
summary of exactly what was cut, where, and for how long -- use it
directly rather than reconstructing it from the raw parameter/reduction_pct
fields yourself. The Monte Carlo results come from re-running the same
scenario many times with different random weekly demand each time (real
demand varies week to week) -- this reveals the RANGE of plausible
outcomes, not one lucky or unlucky run. "p5" is roughly the worst-case
1-in-20 outcome and "p95" is roughly the best-case 1-in-20 outcome. A
region's "service level target" (usually 95%) is the minimum fill rate
considered acceptable; a region below that target is under-served.

THE MOST IMPORTANT RULE: every claim you make must be paired with the
specific number(s) behind it AND what that number actually means for the
reader -- never one without the other. Don't write a number with no
interpretation ("fill rate was 82%" and nothing more), and don't write an
interpretation with no number ("fill rate dropped a lot" with no figure).
Always both, in the same sentence or the one right after it -- e.g. "Fill
rate fell from 97% to 82%, a 15-point drop, meaning roughly 1 in 6 orders
would have gone unfilled during the disruption." Round percentages to the
nearest whole number and quantities to the nearest sensible unit already
given in the data; always use the exact numbers from the JSON, just
formatted for reading.

Respond with ONLY a single JSON object and nothing else -- no markdown
code fences, no commentary before or after it. That object must have
exactly these five string keys:
- "mcNarrative": 3-5 sentences explaining what the Monte Carlo risk
  analysis found (how the scenario performs across many simulated
  futures, not just one run). State the baseline and disrupted mean fill
  rates and the p5-p95 range from the data, and for each number say what
  it implies in practice (how often service would be missed, how wide or
  narrow the range of likely outcomes is).
- "headline": exactly one sentence, the single most important takeaway
  of this scenario, stated plainly up front, naming the key number (e.g.
  the fill-rate drop or the percentage cut applied) alongside what it means.
- "story": 2-4 short paragraphs walking the material through the supply
  chain stage by stage, in the given order. For each stage, state its
  baseline fill rate and (if disrupted) its disrupted fill rate and the
  delta between them, then say what that specific change means for that
  stage -- where and when the disruption actually bites hardest (name the
  tightest week if given) and which stages are barely affected and why
  that matters.
- "risk": 2-3 sentences explaining, in different phrasing than
  mcNarrative, why running many simulated trials (not just one) matters
  here. State the actual number of trials run and the worst-case (p5)
  figure from the data, then say concretely what that worst case would
  look like if it happened.
- "regional": 2-3 sentences naming which specific region(s) are hit
  hardest, their exact fill-rate numbers, and how many of the total
  regions fall under their service target -- then say what that means
  for people in that region (e.g. how often they'd be short of supply).`;

/**
 * Parses the model's reply as JSON. Tried as-is first (the common case,
 * especially under strict JSON mode); if that fails -- e.g. a provider
 * that wrapped the object in a markdown code fence or added a leading/
 * trailing sentence despite the prompt -- falls back to pulling out the
 * first {...} block and parsing that instead. Returns null rather than
 * throwing, so the caller can turn a parse failure into the usual typed
 * BAD_JSON error.
 */
function extractJsonObject(content) {
  try {
    return JSON.parse(content);
  } catch (e) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (e2) {
      return null;
    }
  }
}

async function callOpenAI(digest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.code = "NO_API_KEY";
    throw err;
  }

  const body = {
    model: MODEL,
    temperature: 0.4,
    max_tokens: 2000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(digest) },
    ],
  };
  if (USE_STRICT_JSON_MODE) {
    body.response_format = { type: "json_object" };
  }
  if (!USE_STRICT_JSON_MODE) {
    // Nemotron (and other NVIDIA NIM "hybrid reasoning" models) can spend
    // the whole token budget on hidden chain-of-thought (reasoning_content)
    // before ever writing an answer into `content` -- which is exactly
    // what was happening here (content came back empty, even with a
    // raised max_tokens). Disabling thinking gets a direct answer
    // instead; we only need the final JSON object, not visible reasoning.
    body.chat_template_kwargs = { enable_thinking: false };
  }

  const res = await fetch(CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    timeout: 30000,
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`LLM API returned ${res.status}: ${bodyText.slice(0, 500)}`);
    err.code = "OPENAI_ERROR";
    throw err;
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    const err = new Error("LLM response had no message content");
    err.code = "EMPTY_RESPONSE";
    throw err;
  }

  const parsed = extractJsonObject(content);
  if (!parsed) {
    const err = new Error("LLM response was not valid JSON");
    err.code = "BAD_JSON";
    throw err;
  }

  const missing = REQUIRED_KEYS.filter((k) => typeof parsed[k] !== "string" || !parsed[k].trim());
  if (missing.length) {
    const err = new Error(`LLM response missing/empty keys: ${missing.join(", ")}`);
    err.code = "MISSING_KEYS";
    throw err;
  }

  return parsed;
}

/**
 * Generates all five explanation fields in one call, grounded in the three
 * freshly-written scenario JSON payloads. Throws on any failure (missing
 * key, network error, bad model output) -- callers are expected to catch
 * this and fall back to the deterministic, template-based explanations
 * that already exist, rather than letting a run-scenario request fail
 * just because the LLM step didn't work.
 */
async function generateExplanations({ regional, monteCarlo, chainFlow }) {
  const digest = buildScenarioDigest({ regional, monteCarlo, chainFlow });
  return callOpenAI(digest);
}

module.exports = { generateExplanations };
