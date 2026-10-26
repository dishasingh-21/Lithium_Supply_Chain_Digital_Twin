const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const { generateExplanations } = require("../services/llmExplain.service");

// This file lives at server/src/controllers/, so three levels up is the
// repo root -- where `python -m lithium_twin.X` must be run from for the
// package to be importable.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const CLIENT_DATA_DIR = path.join(REPO_ROOT, "client", "data");
const MODEL_OVERVIEW_JSON = path.join(CLIENT_DATA_DIR, "model_overview.json");
const REGIONAL_HEALTH_JSON = path.join(CLIENT_DATA_DIR, "regional_health.json");
const MONTE_CARLO_JSON = path.join(CLIENT_DATA_DIR, "monte_carlo_results.json");
const CHAIN_FLOW_JSON = path.join(CLIENT_DATA_DIR, "chain_flow.json");
const LLM_EXPLANATION_JSON = path.join(CLIENT_DATA_DIR, "llm_explanation.json");

// Must point at the Python interpreter that has the lithium_twin project's
// dependencies installed (simpy, scipy, pulp, networkx, openpyxl...) --
// usually the repo's own virtualenv, NOT whatever bare "python" resolves
// to in the server's own environment. Set PYTHON_EXECUTABLE in .env to
// an absolute path (e.g. the venv's python.exe) if the default doesn't work.
const PYTHON_EXECUTABLE = process.env.PYTHON_EXECUTABLE || "python";

// The only parameters the simulation engine actually reads for a
// disruption (see lithium_twin/models/node.py and graph.py's arc_data()).
// Whitelisting here, before anything reaches the Python subprocess, closes
// off a whole class of bad input cheaply.
const ALLOWED_PARAMETERS = {
  node: ["weekly_capacity", "yield_rate"],
  arc: ["capacity_lce", "lead_time_weeks", "transport_loss"],
};

const MIN_WEEKS = 20;
const MAX_WEEKS = 208;
const MIN_TRIALS = 10;
const MAX_TRIALS = 300;

function loadModelOverview() {
  if (!fs.existsSync(MODEL_OVERVIEW_JSON)) {
    const err = new Error(
      "model_overview.json not found -- run 'python -m lithium_twin.main' at least once first."
    );
    err.status = 503;
    throw err;
  }
  return JSON.parse(fs.readFileSync(MODEL_OVERVIEW_JSON, "utf-8"));
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

// Best-effort: generates the LLM-based plain-English explanation from the
// three JSON snapshots the Python CLIs just wrote, and caches it to
// llm_explanation.json for the client to read alongside them. Never
// throws -- a failure here (no API key, network error, bad model output)
// should never fail the scenario run itself, since the scenario results
// are already valid and complete without this step. The client falls
// back to its own deterministic, template-based explanations whenever
// this file is missing or has `available: false`.
async function refreshLlmExplanation() {
  const payload = { generated_at: new Date().toISOString() };
  try {
    const regional = readJsonIfExists(REGIONAL_HEALTH_JSON);
    const monteCarlo = readJsonIfExists(MONTE_CARLO_JSON);
    const chainFlow = readJsonIfExists(CHAIN_FLOW_JSON);
    const fields = await generateExplanations({ regional, monteCarlo, chainFlow });
    Object.assign(payload, fields, { available: true });
  } catch (err) {
    console.error("[llm-explain] falling back to template explanations:", err.message);
    Object.assign(payload, { available: false, reason: err.message });
  }
  fs.writeFileSync(LLM_EXPLANATION_JSON, JSON.stringify(payload, null, 2), "utf-8");
}

// Validates a scenario request against the REAL node/arc ids in the live
// model (not a hardcoded list that could drift out of sync with chain.json),
// and returns the normalized values the Python CLIs expect.
function validateScenario(body, model) {
  const { targetType, targetId, parameter, reductionPct, startWeek, durationWeeks, weeks, nTrials } = body || {};
  const errors = [];

  const nodeIds = new Set(model.nodes.map((n) => n.node_id));
  const arcKeys = new Set(model.arcs.map((a) => `${a.source}->${a.dest}`));

  if (!["node", "arc"].includes(targetType)) {
    errors.push("targetType must be 'node' or 'arc'");
  }

  let targetIdStr = null;
  if (targetType === "node") {
    if (typeof targetId !== "string" || !nodeIds.has(targetId)) {
      errors.push(`targetId must be one of this model's real node ids: ${[...nodeIds].join(", ")}`);
    } else {
      targetIdStr = targetId;
    }
  } else if (targetType === "arc") {
    if (!Array.isArray(targetId) || targetId.length !== 2) {
      errors.push("targetId for an arc must be [source, dest]");
    } else {
      const key = `${targetId[0]}->${targetId[1]}`;
      if (!arcKeys.has(key)) {
        errors.push(`targetId must be a real arc in this model: ${[...arcKeys].join(", ")}`);
      } else {
        targetIdStr = `${targetId[0]},${targetId[1]}`;
      }
    }
  }

  if (targetType === "node" || targetType === "arc") {
    const allowed = ALLOWED_PARAMETERS[targetType] || [];
    if (!allowed.includes(parameter)) {
      errors.push(`parameter must be one of: ${allowed.join(", ")}`);
    }
  }

  const reductionPctNum = Number(reductionPct);
  if (!(reductionPctNum > 0 && reductionPctNum <= 1)) {
    errors.push("reductionPct must be a number in (0, 1]");
  }

  const startWeekNum = Number(startWeek);
  if (!Number.isInteger(startWeekNum) || startWeekNum < 1) {
    errors.push("startWeek must be an integer >= 1");
  }

  const durationWeeksNum = Number(durationWeeks);
  if (!Number.isInteger(durationWeeksNum) || durationWeeksNum < 1) {
    errors.push("durationWeeks must be an integer >= 1");
  }

  const weeksNum = weeks === undefined || weeks === null ? 104 : Number(weeks);
  if (!Number.isInteger(weeksNum) || weeksNum < MIN_WEEKS || weeksNum > MAX_WEEKS) {
    errors.push(`weeks must be an integer between ${MIN_WEEKS} and ${MAX_WEEKS}`);
  }

  if (Number.isInteger(startWeekNum) && Number.isInteger(durationWeeksNum) && Number.isInteger(weeksNum)) {
    if (startWeekNum + durationWeeksNum > weeksNum) {
      errors.push("startWeek + durationWeeks must not exceed weeks (the disruption must end within the simulated horizon)");
    }
  }

  const nTrialsNum = nTrials === undefined || nTrials === null ? 100 : Number(nTrials);
  if (!Number.isInteger(nTrialsNum) || nTrialsNum < MIN_TRIALS || nTrialsNum > MAX_TRIALS) {
    errors.push(`nTrials must be an integer between ${MIN_TRIALS} and ${MAX_TRIALS}`);
  }

  if (errors.length) {
    const err = new Error(errors.join("; "));
    err.status = 400;
    throw err;
  }

  return {
    targetType, targetIdStr, parameter,
    reductionPctNum, startWeekNum, durationWeeksNum, weeksNum, nTrialsNum,
  };
}

function runPython(moduleName, args) {
  return new Promise((resolve, reject) => {
    execFile(
      PYTHON_EXECUTABLE,
      ["-m", moduleName, ...args],
      { cwd: REPO_ROOT, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const err = new Error(`${moduleName} failed: ${(stderr || error.message || "").slice(0, 2000)}`);
          err.status = 500;
          return reject(err);
        }
        resolve(stdout);
      }
    );
  });
}

// POST /api/digital-twin/run-scenario
// Body: { targetType, targetId, parameter, reductionPct, startWeek,
//         durationWeeks, weeks?, nTrials? }
// Runs the three Python CLIs (regional_demo, scenarios, monte_carlo) in
// parallel with the given scenario, refreshing all three client/data/*.json
// snapshots. Synchronous request/response -- this can take tens of seconds
// (mostly the Monte Carlo trials), by design: there is no job queue here,
// the frontend is expected to show a loading state while it waits.
async function runScenario(req, res, next) {
  try {
    const model = loadModelOverview();
    const v = validateScenario(req.body, model);

    const disruptionFlags = [
      "--target-type", v.targetType,
      "--target-id", v.targetIdStr,
      "--parameter", v.parameter,
      "--reduction-pct", String(v.reductionPctNum),
      "--start-week", String(v.startWeekNum),
      "--duration-weeks", String(v.durationWeeksNum),
    ];

    await Promise.all([
      runPython("lithium_twin.regional_demo", ["--weeks", String(v.weeksNum), ...disruptionFlags]),
      runPython("lithium_twin.scenarios", ["--weeks", String(v.weeksNum), ...disruptionFlags]),
      runPython("lithium_twin.simulation.monte_carlo", [
        "--weeks", String(v.weeksNum), "--n-trials", String(v.nTrialsNum), ...disruptionFlags,
      ]),
    ]);

    // Runs after the three snapshots above are on disk, so it has fresh
    // data to summarize. Awaited so llm_explanation.json is ready by the
    // time the client re-fetches results, but its own failure is caught
    // internally and never reaches this request's response.
    await refreshLlmExplanation();

    res.json({
      status: "ok",
      scenario: {
        targetType: v.targetType,
        targetId: v.targetIdStr,
        parameter: v.parameter,
        reductionPct: v.reductionPctNum,
        startWeek: v.startWeekNum,
        durationWeeks: v.durationWeeksNum,
        weeks: v.weeksNum,
        nTrials: v.nTrialsNum,
      },
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/digital-twin/model
// Returns the live chain topology + calibrated policies (same content as
// client/data/model_overview.json) -- used by the frontend to populate the
// scenario form's node/arc dropdowns from the REAL model, not a hand-typed list.
async function getModelOverview(req, res, next) {
  try {
    res.json(loadModelOverview());
  } catch (err) {
    next(err);
  }
}

module.exports = { runScenario, getModelOverview };
