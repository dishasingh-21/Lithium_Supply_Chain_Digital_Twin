const fetch = require("node-fetch");

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const REQUIRED_KEYS = ["mcNarrative", "headline", "story", "risk", "regional"];

/**
 * Trims the three raw dashboard JSON payloads down to just the numbers an
 * explanation actually needs. Keeping this small matters for two reasons:
 * it's cheaper/faster to send, and it stops the model from being tempted
 * to narrate the big per-week arrays instead of the headline numbers that
 * actually matter to a reader.
 */
function buildScenarioDigest({ regional, monteCarlo, chainFlow }) {
  const disruption =
    (chainFlow && chainFlow.disruption) ||
    (monteCarlo && monteCarlo.disruption) ||
    (regional && regional.disruption) ||
    null;

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

Respond with ONLY a JSON object with exactly these five string keys:
- "mcNarrative": 3-5 sentences explaining what the Monte Carlo risk
  analysis found (how the scenario performs across many simulated
  futures, not just one run) -- this replaces a short risk-analysis
  summary shown next to the actual stat tiles, so don't repeat exact
  numbers that are already shown in tiles beside it; focus on what the
  numbers MEAN.
- "headline": exactly one sentence, the single most important takeaway
  of this scenario, stated plainly up front.
- "story": 2-4 short paragraphs walking the material through the supply
  chain stage by stage, in the given order, noting where and when the
  disruption actually bites hardest and which stages are barely
  affected.
- "risk": 2-3 sentences explaining, in different phrasing than
  mcNarrative, why running many simulated trials (not just one) matters
  here, and what the worst-case trials look like.
- "regional": 2-3 sentences naming which specific region(s) are hit
  hardest and how many regions fall under their service target.`;

async function callOpenAI(digest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error("OPENAI_API_KEY is not configured");
    err.code = "NO_API_KEY";
    throw err;
  }

  const res = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.4,
      max_tokens: 900,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(digest) },
      ],
    }),
    timeout: 30000,
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`OpenAI API returned ${res.status}: ${bodyText.slice(0, 500)}`);
    err.code = "OPENAI_ERROR";
    throw err;
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    const err = new Error("OpenAI response had no message content");
    err.code = "EMPTY_RESPONSE";
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (parseErr) {
    const err = new Error("OpenAI response was not valid JSON");
    err.code = "BAD_JSON";
    throw err;
  }

  const missing = REQUIRED_KEYS.filter((k) => typeof parsed[k] !== "string" || !parsed[k].trim());
  if (missing.length) {
    const err = new Error(`OpenAI response missing/empty keys: ${missing.join(", ")}`);
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
