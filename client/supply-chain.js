console.log("SUPPLY CHAIN DASHBOARD LOADED");

const API_BASE_URL = window.API_BASE_URL || "http://localhost:5000/api";

// Leaflet sets these as inline style attributes on the marker's SVG path,
// so resolve the CSS custom properties to real color values up front
// rather than handing Leaflet a raw "var(--success)" string.
function resolveColor(cssVarName) {
    return getComputedStyle(document.documentElement).getPropertyValue(cssVarName).trim();
}
const STATUS_COLORS = {
    green: resolveColor("--success"),
    yellow: resolveColor("--accent"),
    red: resolveColor("--danger"),
};

var map = L.map('map').setView([26.5, 74.0], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(map);

// Separate layer groups so a re-render (after submitting a new scenario)
// can clear and redraw each set of markers independently, instead of
// piling duplicate circles/pins on top of the old ones.
const regionsLayer = L.layerGroup().addTo(map);
const warehousesLayer = L.layerGroup().addTo(map);

function updateStatus(text, color) {
    const statusText = document.getElementById("status-text");
    const statusDot = document.getElementById("status-dot");
    if (statusText) statusText.innerText = text;
    if (statusDot && color) statusDot.style.background = color;
}

function fmtPct(x) {
    return (x * 100).toFixed(1) + "%";
}

function fmtKgDelta(x) {
    const sign = x >= 0 ? "+" : "";
    return sign + Math.round(x).toLocaleString() + " kg LCE";
}

function fillClass(fillRate, serviceLevel) {
    const target = serviceLevel || 0.95;
    if (fillRate >= target) return "fill-good";
    if (fillRate >= target - 0.15) return "fill-ok";
    return "fill-bad";
}

// Plain-English labels for the technical parameter keys the engine reads
// (must match server/src/controllers/digitalTwinController.js's
// ALLOWED_PARAMETERS and lithium_twin/models/node.py, graph.py) -- the form
// still submits the technical key, this is only what the person reads.
const PARAMETER_LABELS = {
    weekly_capacity: "How much it can produce per week",
    yield_rate: "How much comes out usable (yield)",
    capacity_lce: "How much it can ship per week",
    lead_time_weeks: "How long shipments take to arrive",
    transport_loss: "How much is lost in transit",
};

function friendlyParam(key) {
    return PARAMETER_LABELS[key] || key;
}

// Builds a minimal inline-SVG line chart comparing baseline vs disrupted
// week-by-week series for one node -- lets a viewer see WHEN a shock
// actually hits a stage and how long recovery takes, instead of only the
// two before/after numbers already shown above it.
function buildSparklineSVG(baseline, disrupted) {
    const W = 140, H = 36;
    const allValues = disrupted ? baseline.concat(disrupted) : baseline;
    const max = Math.max(1, ...allValues);
    const toPoints = (series) => series.map((v, i) => {
        const x = (i / Math.max(1, series.length - 1)) * W;
        const y = H - (v / max) * H;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    let polylines = `<polyline points="${toPoints(baseline)}" fill="none" stroke="var(--primary-light)" stroke-width="1.5" />`;
    if (disrupted) {
        polylines += `<polyline points="${toPoints(disrupted)}" fill="none" stroke="var(--danger)" stroke-width="1.5" />`;
    }
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${polylines}</svg>`;
}

async function fetchJson(url, options) {
    const res = await fetch(url, Object.assign({ cache: "no-store" }, options || {}));
    if (!res.ok) {
        let detail = "";
        try { detail = (await res.json()).error || ""; } catch (e) { /* ignore */ }
        throw new Error(`${url} -> ${res.status}${detail ? ": " + detail : ""}`);
    }
    return res.json();
}

async function loadRegionalHealth() {
    return fetchJson("data/regional_health.json");
}

async function loadMonteCarloResults() {
    return fetchJson("data/monte_carlo_results.json");
}

async function loadChainFlow() {
    return fetchJson("data/chain_flow.json");
}

// ---- Scenario summary (shown in the collapsed bar once results are up) ----

function buildScenarioSummaryText(dis) {
    if (!dis) {
        return "Showing the normal, undisrupted run -- no scenario has been applied yet.";
    }
    const pct = (dis.reduction_pct * 100).toFixed(0);
    return (
        `Scenario: a <b>${pct}% cut</b> to "${friendlyParam(dis.parameter)}" on ` +
        `<b>${dis.label}</b>, starting week ${dis.start_week} and lasting ${dis.duration_weeks} weeks.`
    );
}

function showForm() {
    document.getElementById("scenario-form-card").style.display = "block";
    document.getElementById("scenario-summary-bar").style.display = "none";
}

function showSummaryBar(dis) {
    document.getElementById("scenario-summary-text").innerHTML = buildScenarioSummaryText(dis);
    document.getElementById("scenario-form-card").style.display = "none";
    document.getElementById("scenario-summary-bar").style.display = "flex";
}

// ---- Monte Carlo card ----

function renderMonteCarlo(data) {
    const s = data.summary;
    const b = s.baseline.fill_rate;
    document.getElementById("mc-baseline-fill").innerText = fmtPct(b.mean);
    document.getElementById("mc-baseline-range").innerText = `p5 ${fmtPct(b.p5)} - p95 ${fmtPct(b.p95)}`;

    if (s.disrupted) {
        const d = s.disrupted.fill_rate;
        document.getElementById("mc-disrupted-fill").innerText = fmtPct(d.mean);
        document.getElementById("mc-disrupted-range").innerText = `p5 ${fmtPct(d.p5)} - p95 ${fmtPct(d.p95)}`;
    }

    if (s.paired_impact) {
        const p = s.paired_impact.fill_rate_delta;
        const impactEl = document.getElementById("mc-impact");
        impactEl.innerText = fmtPct(p.mean);
        impactEl.style.color = p.mean < 0 ? "var(--danger)" : "var(--success)";
        document.getElementById("mc-impact-range").innerText = `p5 ${fmtPct(p.p5)} - p95 ${fmtPct(p.p95)}`;

        const bl = s.paired_impact.final_backlog_delta;
        document.getElementById("mc-backlog-delta").innerText = fmtKgDelta(bl.mean);
    }

    document.getElementById("mc-narrative").innerText = data.narrative;
    renderTrialDistribution(data.trials);
}

// Draws each arm's trials SORTED worst-to-best as its own line -- an
// empirical quantile curve, not a histogram. This reads much more
// directly than bars: the x-axis position of a point IS its percentile
// rank, so "where does the disrupted line sit relative to baseline" and
// "how much do the two curves diverge in the worst trials vs the best
// ones" are both visible at a glance, and the existing p5/p50/p95 stat
// tiles above correspond to specific, labeled points on this same line.
function renderTrialDistribution(trials) {
    const wrap = document.getElementById("mc-distribution-wrap");
    const chartEl = document.getElementById("mc-distribution-chart");
    const legendEl = document.getElementById("mc-distribution-legend");
    if (!trials || !Array.isArray(trials.baseline_fill_rate) || trials.baseline_fill_rate.length === 0) {
        wrap.style.display = "none";
        return;
    }
    wrap.style.display = "block";

    const baseline = trials.baseline_fill_rate.slice().sort((a, b) => a - b);
    const disruptedRaw = Array.isArray(trials.disrupted_fill_rate) ? trials.disrupted_fill_rate : [];
    const disrupted = disruptedRaw.length ? disruptedRaw.slice().sort((a, b) => a - b) : null;

    const allValues = disrupted ? baseline.concat(disrupted) : baseline;
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);
    // Pad the range a bit and always include the 95% service-level target
    // line, so it's visible whether trials cluster above, below, or
    // around it.
    const yMin = Math.min(dataMin, 0.95) - 0.03;
    const yMax = Math.max(dataMax, 0.95) + 0.03;
    const ySpan = Math.max(1e-9, yMax - yMin);

    const W = 400, H = 80, PAD_L = 34, PAD_B = 4, PAD_T = 4;
    const plotW = W - PAD_L;
    const plotH = H - PAD_B - PAD_T;

    const yToPx = (v) => PAD_T + plotH - ((v - yMin) / ySpan) * plotH;
    const toPath = (sorted) => sorted.map((v, i) => {
        const x = PAD_L + (i / Math.max(1, sorted.length - 1)) * plotW;
        return `${x.toFixed(1)},${yToPx(v).toFixed(1)}`;
    }).join(" ");

    const targetY = yToPx(0.95);

    // Three horizontal gridlines with fill-rate labels, so the chart is
    // readable on its own rather than requiring the stat tiles above it.
    const gridLines = [yMin + ySpan, yMin + ySpan * 0.5, yMin].map((v) => {
        const y = yToPx(v);
        return `<line x1="${PAD_L}" y1="${y}" x2="${W}" y2="${y}" stroke="var(--border-color)" stroke-width="1" />` +
            `<text x="0" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text-muted)">${fmtPct(v)}</text>`;
    }).join("");

    let svg =
        `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block;">` +
        gridLines +
        `<line x1="${PAD_L}" y1="${targetY}" x2="${W}" y2="${targetY}" stroke="var(--text-muted)" stroke-width="1" stroke-dasharray="3,3" />` +
        `<text x="${PAD_L + 2}" y="${(targetY - 3).toFixed(1)}" font-size="9" fill="var(--text-muted)">95% target</text>` +
        `<polyline points="${toPath(baseline)}" fill="none" stroke="var(--primary-light)" stroke-width="2" />`;
    if (disrupted) {
        svg += `<polyline points="${toPath(disrupted)}" fill="none" stroke="var(--danger)" stroke-width="2" />`;
    }
    svg += `</svg>`;
    chartEl.innerHTML = svg;

    legendEl.innerHTML =
        `<span><span class="legend-line" style="background: var(--primary-light);"></span>Normal run (${baseline.length} trials)</span>` +
        (disrupted
            ? `<span><span class="legend-line" style="background: var(--danger);"></span>With disruption (${disrupted.length} trials)</span>`
            : "") +
        `<span><span class="legend-line" style="background: var(--text-muted); height: 1px; border-top: 1px dashed var(--text-muted);"></span>95% target</span>`;
}

// ---- Chain flow card ----

function renderChainFlow(data) {
    const el = document.getElementById("flow-diagram");
    const descEl = document.getElementById("flow-disruption-desc");
    el.innerHTML = "";

    if (data.disruption) {
        const d = data.disruption;
        descEl.innerText =
            `Comparing the normal run against a ${(d.reduction_pct * 100).toFixed(0)}% cut to ` +
            `"${friendlyParam(d.parameter)}" on ${d.label}, weeks ${d.start_week}-${d.start_week + d.duration_weeks}.`;
    } else {
        descEl.innerText = "This is the normal run -- no disruption has been applied.";
    }

    data.nodes.forEach((n, i) => {
        const card = document.createElement("div");
        card.className = "topo-card";
        const baselineClass = fillClass(n.baseline_fill_rate, 0.95);
        let statsHtml = `<div>Normal: <span class="${baselineClass}">${fmtPct(n.baseline_fill_rate)}</span></div>`;
        if (n.disrupted_fill_rate !== undefined) {
            const disruptedClass = fillClass(n.disrupted_fill_rate, 0.95);
            statsHtml += `<div>Disrupted: <span class="${disruptedClass}">${fmtPct(n.disrupted_fill_rate)}</span></div>`;
        }
        let sparklineHtml = "";
        if (Array.isArray(n.weekly_inventory) && n.weekly_inventory.length > 1) {
            sparklineHtml = `<div class="sparkline-wrap">` +
                `<div class="sparkline-label">Inventory, week by week</div>` +
                buildSparklineSVG(n.weekly_inventory, n.disrupted_weekly_inventory) +
                `</div>`;
        }
        card.innerHTML = `
            <div class="topo-name">${n.location}</div>
            <div class="topo-stats">${statsHtml}</div>
            ${sparklineHtml}
        `;
        el.appendChild(card);

        if (i < data.nodes.length - 1) {
            const arrow = document.createElement("div");
            arrow.className = "topo-arrow";
            arrow.innerHTML = "&rarr;";
            el.appendChild(arrow);
        }
    });
}

// ---- Regional health map ----

// Demand-share scales each region's circle between MIN_RADIUS and
// MAX_RADIUS so the biggest-demand region (Jaipur) visibly dominates the
// smallest (Alwar) on the map, instead of every region looking the same size.
const MIN_RADIUS = 14;
const MAX_RADIUS = 32;

function renderRegions(data) {
    regionsLayer.clearLayers();
    const shares = data.regions.map((r) => r.demand_share);
    const maxShare = Math.max(...shares);
    const minShare = Math.min(...shares);

    data.regions.forEach((region) => {
        const color = STATUS_COLORS[region.status] || "#888888";
        const t = maxShare > minShare
            ? (region.demand_share - minShare) / (maxShare - minShare)
            : 0.5;
        const radius = MIN_RADIUS + t * (MAX_RADIUS - MIN_RADIUS);

        const circle = L.circleMarker([region.lat, region.lon], {
            radius,
            color,
            fillColor: color,
            fillOpacity: 0.45,
            weight: 2,
        });

        let popupHtml =
            `<strong>${region.name}</strong><br>` +
            `Share of total demand: ${fmtPct(region.demand_share)}<br>` +
            `Fill rate: ${fmtPct(region.fill_rate)}`;
        // Click-to-explain: when a disruption is active, name it and show
        // the windowed (disruption-period) fill rate alongside the
        // full-run number, so a click answers "why does this region look
        // this way" instead of just restating the color it already shows.
        if (data.disruption) {
            const d = data.disruption;
            popupHtml += `<div class="region-popup-note">` +
                `This reflects a modeled disruption: a ` +
                `${(d.reduction_pct * 100).toFixed(0)}% cut to "${friendlyParam(d.parameter)}" on ` +
                `${d.label}, weeks ${d.start_week}-${d.start_week + d.duration_weeks}.`;
            if (data.overall_fill_rate_during_disruption != null) {
                popupHtml += ` During that window specifically, fill rate was ` +
                    `${fmtPct(data.overall_fill_rate_during_disruption)} -- a more direct read ` +
                    `on this disruption's impact than the ${data.weeks_simulated}-week average.`;
            }
            popupHtml += `</div>`;
        }
        circle.bindPopup(popupHtml);
        circle.bindTooltip(region.town, {
            permanent: true,
            direction: "top",
            offset: [0, -radius],
            className: "region-label",
        });
        regionsLayer.addLayer(circle);
    });
}

function renderSummary(data) {
    document.getElementById("overall-fill-rate").innerText = fmtPct(data.overall_fill_rate);
    document.getElementById("region-count").innerText = data.regions.length;
    document.getElementById("weeks-simulated").innerText = data.weeks_simulated;

    const windowedWrap = document.getElementById("windowed-fill-wrap");
    if (data.overall_fill_rate_during_disruption != null) {
        windowedWrap.style.display = "block";
        document.getElementById("windowed-fill-rate").innerText =
            fmtPct(data.overall_fill_rate_during_disruption);
    } else {
        windowedWrap.style.display = "none";
    }
}

// ---- Warehouse overlay (Route Optimizer integration) ----
// Real warehouse pins from the existing Route Optimizer API, layered on
// top of the regional health circles -- both datasets trace back to the
// same warehouses.xlsx, so a warehouse pin sitting inside a red/yellow
// region is a genuine, data-grounded signal that this warehouse's
// upstream battery-material supply may be tightening.

async function loadWarehouses() {
    return fetchJson(`${API_BASE_URL}/warehouses?active=true`);
}

function renderWarehouses(data) {
    warehousesLayer.clearLayers();
    (data.warehouses || []).forEach((w) => {
        const marker = L.marker([w.lat, w.lon]);
        marker.bindPopup(
            `<div class="warehouse-popup"><b>${w.name}</b> (${w.code})<br>` +
            `${w.town}<br>` +
            `Capacity: ${w.capacityUnits || "n/a"} units</div>`
        );
        warehousesLayer.addLayer(marker);
    });
}

// ---- Scenario form ----

// Must match server/src/controllers/digitalTwinController.js's
// ALLOWED_PARAMETERS exactly -- these are the only parameters the engine
// actually reads for a disruption (lithium_twin/models/node.py, graph.py).
const PARAMETER_OPTIONS = {
    node: ["weekly_capacity", "yield_rate"],
    arc: ["capacity_lce", "lead_time_weeks", "transport_loss"],
};

let modelOverview = null;

function populateTargetOptions() {
    const targetType = document.getElementById("sf-target-type").value;
    const targetSelect = document.getElementById("sf-target-id");
    const paramSelect = document.getElementById("sf-parameter");
    targetSelect.innerHTML = "";
    paramSelect.innerHTML = "";

    if (!modelOverview) return;

    if (targetType === "node") {
        modelOverview.nodes.forEach((n) => {
            const opt = document.createElement("option");
            opt.value = n.node_id;
            opt.textContent = `${n.location} (${n.node_id})`;
            targetSelect.appendChild(opt);
        });
    } else {
        modelOverview.arcs.forEach((a) => {
            const opt = document.createElement("option");
            opt.value = `${a.source},${a.dest}`;
            opt.textContent = `${a.source} -> ${a.dest}`;
            targetSelect.appendChild(opt);
        });
    }

    (PARAMETER_OPTIONS[targetType] || []).forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p;
        opt.textContent = friendlyParam(p);
        paramSelect.appendChild(opt);
    });
}

async function loadModelForForm() {
    modelOverview = await fetchJson(`${API_BASE_URL}/digital-twin/model`);
    populateTargetOptions();
}

function loadSavedApiKey() {
    try {
        const saved = localStorage.getItem("digitalTwinApiKey");
        if (saved) document.getElementById("sf-api-key").value = saved;
    } catch (e) { /* localStorage unavailable -- not critical, just skip */ }
}

function saveApiKey(key) {
    try {
        localStorage.setItem("digitalTwinApiKey", key);
    } catch (e) { /* ignore */ }
}

async function submitScenario() {
    const targetType = document.getElementById("sf-target-type").value;
    const targetIdRaw = document.getElementById("sf-target-id").value;
    const parameter = document.getElementById("sf-parameter").value;
    const reductionPct = Number(document.getElementById("sf-reduction-pct").value) / 100;
    const startWeek = Number(document.getElementById("sf-start-week").value);
    const durationWeeks = Number(document.getElementById("sf-duration-weeks").value);
    const weeks = Number(document.getElementById("sf-weeks").value);
    const nTrials = Number(document.getElementById("sf-n-trials").value);
    const apiKey = document.getElementById("sf-api-key").value;

    const targetId = targetType === "arc" ? targetIdRaw.split(",") : targetIdRaw;

    const statusEl = document.getElementById("sf-status");
    const submitBtn = document.getElementById("sf-submit");
    submitBtn.disabled = true;
    statusEl.style.color = "var(--text-muted)";
    statusEl.innerText = "Running scenario -- this can take a minute or two (Monte Carlo trials included)...";

    try {
        saveApiKey(apiKey);
        await fetchJson(`${API_BASE_URL}/digital-twin/run-scenario`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-api-key": apiKey },
            body: JSON.stringify({
                targetType, targetId, parameter, reductionPct, startWeek, durationWeeks, weeks, nTrials,
            }),
        });
        statusEl.style.color = "var(--success)";
        statusEl.innerText = "Scenario complete.";
        document.getElementById("sf-cancel-edit").style.display = "none";
        await loadAndRenderResults();
        revealResults();
    } catch (err) {
        console.error(err);
        statusEl.style.color = "var(--danger)";
        statusEl.innerText = `Failed: ${err.message}`;
    } finally {
        submitBtn.disabled = false;
    }
}

// ---- Orchestration ----

// Stash the last-loaded results in sessionStorage so explain.html (a
// separate page, no API calls of its own) can build its plain-English
// walkthrough from the exact same data the person is looking at here,
// without re-running anything.
function stashForExplainPage(key, data) {
    try {
        sessionStorage.setItem(key, JSON.stringify(data));
    } catch (e) { /* storage unavailable -- explain page falls back to its own message */ }
}

// Regional map, Monte Carlo card, and chain-flow card each read their own
// JSON snapshot, written by three independent Python scripts -- load/render
// each separately so one missing/failed snapshot doesn't block the others.
// This only runs right after a scenario has actually been submitted (see
// submitScenario), never automatically on page load -- the person always
// starts on the blank form, never on a stale result from a previous visit.
async function loadAndRenderResults() {
    updateStatus("Loading regional health data...", resolveColor("--accent"));
    try {
        const data = await loadRegionalHealth();
        renderRegions(data);
        renderSummary(data);
        stashForExplainPage("ltwin_regional", data);
        const generatedAt = new Date(data.generated_at).toLocaleString();
        updateStatus(`Up to date (snapshot: ${generatedAt})`, resolveColor("--success"));
    } catch (err) {
        console.error(err);
        updateStatus("Could not load the regional results -- try running the scenario again", resolveColor("--danger"));
    }

    try {
        const mcData = await loadMonteCarloResults();
        renderMonteCarlo(mcData);
        stashForExplainPage("ltwin_monte_carlo", mcData);
    } catch (err) {
        console.error(err);
        document.getElementById("mc-narrative").innerText =
            "Could not load Monte Carlo results -- try running the scenario again.";
    }

    try {
        const flowData = await loadChainFlow();
        renderChainFlow(flowData);
        stashForExplainPage("ltwin_chain_flow", flowData);
    } catch (err) {
        console.error(err);
        document.getElementById("flow-diagram").innerHTML =
            `<p style="color: var(--danger); font-size: 0.8rem;">Could not load chain-flow data -- ` +
            `try running the scenario again.</p>`;
        document.getElementById("flow-disruption-desc").innerText = "";
    }

    try {
        const whData = await loadWarehouses();
        renderWarehouses(whData);
    } catch (err) {
        console.error(err);
        // Non-critical overlay -- the route optimizer API may simply not
        // be running; the regional map itself still works without it.
    }
}

// Collapses the form into the summary bar and reveals the results below
// it -- called once, right after a scenario finishes running. Leaflet
// mis-renders (grey tiles) when it was initialized inside a hidden
// (display:none) container, so the map needs an explicit resize nudge
// the first moment it actually becomes visible.
let mapSizeFixed = false;
function revealResults() {
    document.getElementById("results-section").style.display = "block";
    let dis = null;
    try {
        const cached = sessionStorage.getItem("ltwin_regional");
        if (cached) dis = JSON.parse(cached).disruption;
    } catch (e) { /* ignore */ }
    showSummaryBar(dis);
    if (!mapSizeFixed) {
        setTimeout(() => map.invalidateSize(), 50);
        mapSizeFixed = true;
    } else {
        map.invalidateSize();
    }
}

async function init() {
    loadSavedApiKey();

    document.getElementById("sf-target-type").addEventListener("change", populateTargetOptions);
    document.getElementById("sf-submit").addEventListener("click", submitScenario);

    // "Edit scenario" re-opens the form on top of whatever results are
    // already showing -- the person edits and re-runs without losing the
    // last result while they decide what to change. "Cancel" collapses it
    // back without re-running anything -- the results underneath never
    // went anywhere, so this just re-shows the summary bar from what's
    // already cached in this page's session.
    document.getElementById("scenario-summary-edit").addEventListener("click", () => {
        showForm();
        document.getElementById("sf-cancel-edit").style.display = "inline-block";
    });
    document.getElementById("sf-cancel-edit").addEventListener("click", () => {
        document.getElementById("sf-cancel-edit").style.display = "none";
        let dis = null;
        try {
            const cached = sessionStorage.getItem("ltwin_regional");
            if (cached) dis = JSON.parse(cached).disruption;
        } catch (e) { /* ignore */ }
        showSummaryBar(dis);
    });

    document.getElementById("explain-results-btn").addEventListener("click", () => {
        window.location.href = "explain.html";
    });

    try {
        await loadModelForForm();
    } catch (err) {
        console.error(err);
        document.getElementById("sf-status").innerText =
            "Could not load the live model -- run 'python -m lithium_twin.main' first, " +
            "and make sure the Node API server is running.";
    }

    // Always open on the blank form -- never auto-show a leftover result
    // from an earlier visit. Results only appear after Run is clicked.
}

init();
