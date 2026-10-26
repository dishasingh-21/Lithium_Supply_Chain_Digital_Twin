// Explain page: turns the same JSON the Analyze page already rendered into
// a plain-English story, following a simple "bottom line first, then the
// story, then why it's reliable, then where it lands" structure --
// standard data-storytelling order (headline -> narrative -> evidence ->
// so-what), aimed at someone with zero supply-chain background.
//
// No API calls here -- it reads what supply-chain.js already cached in
// sessionStorage right after the last scenario run, so this page is just
// a different *presentation* of the same result, not a new computation.

function fmtPct(x) {
    return (x * 100).toFixed(1) + "%";
}

const PARAMETER_LABELS = {
    weekly_capacity: "how much it can produce per week",
    yield_rate: "how much comes out usable (yield)",
    capacity_lce: "how much it can ship per week",
    lead_time_weeks: "how long shipments take to arrive",
    transport_loss: "how much is lost in transit",
};
function friendlyParam(key) {
    return PARAMETER_LABELS[key] || key;
}

function readCache(key) {
    try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        return null;
    }
}

// Escapes text that came back from the LLM before dropping it into
// innerHTML -- it's grounded in real numbers by the server-side prompt,
// but it's still model-generated free text, not markup we wrote ourselves.
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// Turns a block of LLM-written prose into one <p> per line/blank-line-
// separated paragraph, instead of dumping it into a single run-on block.
function buildLlmParagraphsHtml(text) {
    return text
        .split(/\n+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p>${escapeHtml(p)}</p>`)
        .join("");
}

function renderEmptyState(container) {
    container.innerHTML = `
        <div class="empty-state">
            <p style="margin-bottom: 1rem;">There's no scenario to explain yet -- this page only shows up after you've run one.</p>
            <a class="btn-primary" style="display: inline-flex; width: auto; padding: 0.75rem 2rem; text-decoration: none;" href="supply-chain.html">Go run a scenario &rarr;</a>
        </div>
    `;
}

// ---- Headline (bottom line, stated first) ----

function buildHeadline(regional, mc, llmHeadline) {
    const dis = (regional && regional.disruption) || (mc && mc.disruption);
    if (llmHeadline) {
        return {
            eyebrow: dis ? "Scenario result" : "Baseline run",
            text: llmHeadline,
        };
    }
    if (!dis) {
        return {
            eyebrow: "Baseline run",
            text: "No disruption was modeled in this run -- this is simply how the supply chain performs under normal conditions.",
        };
    }
    const pct = (dis.reduction_pct * 100).toFixed(0);
    let impactText = "";
    if (mc && mc.summary && mc.summary.paired_impact) {
        const delta = mc.summary.paired_impact.fill_rate_delta.mean;
        const direction = delta < 0 ? "dropped" : "rose";
        impactText = ` On average, across many simulated futures, overall fill rate ${direction} by ${fmtPct(Math.abs(delta))}.`;
    }
    return {
        eyebrow: "Scenario result",
        text: `A ${pct}% cut to ${friendlyParam(dis.parameter)} on ${dis.label}, lasting ${dis.duration_weeks} weeks starting week ${dis.start_week}, ripples through the whole chain.${impactText}`,
    };
}

// ---- The story: walk the material through the chain, stage by stage ----

function buildStoryHtml(chainFlow, llmStory) {
    if (llmStory) {
        return `<div class="story-flow">${buildLlmParagraphsHtml(llmStory)}</div>`;
    }
    if (!chainFlow || !Array.isArray(chainFlow.nodes) || chainFlow.nodes.length === 0) {
        return `<p style="color: var(--text-muted); font-size: 0.85rem;">Chain-flow data isn't available for this run.</p>`;
    }
    const hasDisruption = !!chainFlow.disruption;
    const steps = chainFlow.nodes.map((n, i) => {
        const isFirst = i === 0;
        const isLast = i === chainFlow.nodes.length - 1;
        let sentence;
        if (isFirst) {
            sentence = `The material's journey starts here. Under normal conditions, ${n.location} keeps ${fmtPct(n.baseline_fill_rate)} of demand filled.`;
        } else if (isLast) {
            sentence = `This is the last stop before it reaches the customer. Normally, ${n.location} fills ${fmtPct(n.baseline_fill_rate)} of what's needed.`;
        } else {
            sentence = `Material then moves on to ${n.location}, which normally fills ${fmtPct(n.baseline_fill_rate)} of the demand placed on it.`;
        }

        if (hasDisruption && n.disrupted_fill_rate !== undefined) {
            const delta = n.disrupted_fill_rate - n.baseline_fill_rate;
            if (Math.abs(delta) < 0.005) {
                sentence += ` Under the disruption, this stage barely changes -- it's largely insulated from the shock.`;
            } else if (delta < 0) {
                sentence += ` Under the disruption, that falls to ${fmtPct(n.disrupted_fill_rate)} -- a drop of ${fmtPct(Math.abs(delta))}.`;
            } else {
                sentence += ` Under the disruption, that actually improves to ${fmtPct(n.disrupted_fill_rate)}, likely because less material is arriving to process in the first place.`;
            }
        }

        // Use the node's own week-by-week inventory, if present, to name
        // WHEN things were tightest -- a concrete detail pulled straight
        // from the data, not an invented flourish.
        if (hasDisruption && Array.isArray(n.disrupted_weekly_inventory) && n.disrupted_weekly_inventory.length > 1) {
            let minVal = Infinity, minWeek = 0;
            n.disrupted_weekly_inventory.forEach((v, w) => {
                if (v < minVal) { minVal = v; minWeek = w; }
            });
            sentence += ` Inventory here was at its tightest around week ${minWeek}.`;
        }

        return `
            <div class="story-step">
                <div class="stage-name">${n.location}</div>
                <p>${sentence}</p>
            </div>
        `;
    }).join("");

    return `<div class="story-flow">${steps}</div>`;
}

// ---- Why we ran it many times (Monte Carlo, in plain terms) ----

function buildRiskHtml(mc, llmRisk) {
    if (!mc || !mc.summary) {
        return `<p style="color: var(--text-muted); font-size: 0.85rem;">Risk-analysis data isn't available for this run.</p>`;
    }
    const s = mc.summary;
    let html = "";
    if (llmRisk) {
        html += buildLlmParagraphsHtml(llmRisk);
    } else {
        html += `<p>
            A single simulation could just be luck -- good or bad. So instead of running this scenario once, the model
            replayed it ${mc.n_trials || "many"} times, each time with different, realistic random demand. That turns
            one guess into a range: how this scenario plays out most of the time, and how bad the unlucky cases get.
        </p>`;
        if (mc.narrative) {
            html += `<p>${mc.narrative}</p>`;
        }
    }
    html += `<div class="takeaway-grid">
        <div class="takeaway-tile">
            <p class="stat-label">Normal, most of the time</p>
            <p class="stat-value">${fmtPct(s.baseline.fill_rate.mean)}</p>
        </div>`;
    if (s.disrupted) {
        html += `<div class="takeaway-tile">
            <p class="stat-label">With this disruption, most of the time</p>
            <p class="stat-value">${fmtPct(s.disrupted.fill_rate.mean)}</p>
        </div>`;
    }
    if (s.paired_impact) {
        const p = s.paired_impact.fill_rate_delta;
        html += `<div class="takeaway-tile">
            <p class="stat-label">Worst 5% of simulated futures</p>
            <p class="stat-value" style="color: var(--danger);">${fmtPct(p.p5)} impact</p>
        </div>`;
    }
    html += `</div>`;
    return html;
}

// ---- Where it shows up (regions) ----

const STATUS_COLORS_HEX = { green: "#28C76F", yellow: "#FF9F43", red: "#EA5455" };

function buildRegionsHtml(regional, llmRegional) {
    if (!regional || !Array.isArray(regional.regions)) {
        return `<p style="color: var(--text-muted); font-size: 0.85rem;">Regional data isn't available for this run.</p>`;
    }
    const sorted = regional.regions.slice().sort((a, b) => a.fill_rate - b.fill_rate);
    const worst = sorted[0];
    const strained = regional.regions.filter((r) => r.status !== "green");

    let html = "";
    if (llmRegional) {
        html += buildLlmParagraphsHtml(llmRegional);
    } else if (strained.length === 0) {
        html += `<p>Every region is still meeting its service target in this run -- nobody is visibly short of supply.</p>`;
    } else {
        html += `<p>
            ${strained.length} of ${regional.regions.length} region${regional.regions.length === 1 ? "" : "s"} in
            Rajasthan ${strained.length === 1 ? "is" : "are"} currently under its service target. The hardest hit is
            <strong>${worst.name}</strong>, filling only ${fmtPct(worst.fill_rate)} of its demand.
        </p>`;
    }
    html += `<div class="region-pill-row">`;
    regional.regions.forEach((r) => {
        html += `<span class="region-pill" style="background: ${STATUS_COLORS_HEX[r.status] || "#888"};">
            ${r.name} &middot; ${fmtPct(r.fill_rate)}
        </span>`;
    });
    html += `</div>`;
    return html;
}

function render() {
    const container = document.getElementById("explain-content");
    const regional = readCache("ltwin_regional");
    const mc = readCache("ltwin_monte_carlo");
    const chainFlow = readCache("ltwin_chain_flow");
    // Optional LLM-generated explanation, stashed by supply-chain.js from
    // data/llm_explanation.json. `available` is only true when the server
    // actually had an OpenAI key configured and the call succeeded for this
    // scenario run -- otherwise this is null/unavailable and every section
    // below falls back to its existing deterministic text exactly as before.
    const llm = readCache("ltwin_llm_explanation");
    const llmReady = !!(llm && llm.available);

    if (!regional && !mc && !chainFlow) {
        renderEmptyState(container);
        return;
    }

    const headline = buildHeadline(regional, mc, llmReady ? llm.headline : null);
    container.innerHTML = `
        <div class="headline-card">
            <div class="eyebrow">${headline.eyebrow}</div>
            <h1>${headline.text}</h1>
        </div>

        <div class="card story-section">
            <h3>The Story: Following the Material Through the Chain</h3>
            ${buildStoryHtml(chainFlow, llmReady ? llm.story : null)}
        </div>

        <div class="card story-section">
            <h3>Why We Trust This Number</h3>
            ${buildRiskHtml(mc, llmReady ? llm.risk : null)}
        </div>

        <div class="card story-section">
            <h3>Where It Shows Up</h3>
            ${buildRegionsHtml(regional, llmReady ? llm.regional : null)}
        </div>

        <div style="display: flex; justify-content: center; gap: 1rem; margin-top: 0.5rem;">
            <a class="btn-primary" style="width: auto; padding: 0.75rem 2rem; text-decoration: none; display: inline-flex;" href="supply-chain.html">Back to Analyze</a>
        </div>
    `;
}

render();
