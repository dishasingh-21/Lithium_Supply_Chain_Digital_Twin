console.log("HOW IT WORKS PAGE LOADED");

function fmtKg(x) {
    return Math.round(x).toLocaleString() + " kg LCE";
}

function fmtPct(x) {
    return (x * 100).toFixed(0) + "%";
}

async function loadModelOverview() {
    const res = await fetch("data/model_overview.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load model_overview.json (status ${res.status})`);
    return res.json();
}

const NODE_TYPE_LABELS = {
    extractor: "Extraction",
    processor: "Processing",
    manufacturer: "Precursor Mfg",
    assembler: "Assembly",
    oem: "OEM",
    recycler: "Recycling",
};

// Renders the chain as a horizontal strip of cards, one per node, in the
// topological order the backend already computed. Between two
// consecutive nodes that are directly connected by an arc, the arrow is
// labeled with that arc's lead time -- the real transit delay the engine
// enforces, not a illustrative number.
function renderTopology(data) {
    const el = document.getElementById("topology-diagram");
    el.innerHTML = "";

    const arcByPair = {};
    data.arcs.forEach((a) => {
        arcByPair[`${a.source}->${a.dest}`] = a;
    });

    data.nodes.forEach((n, i) => {
        const card = document.createElement("div");
        card.className = "topo-card";
        card.innerHTML = `
            <div class="topo-type">${NODE_TYPE_LABELS[n.node_type] || n.node_type}</div>
            <div class="topo-name">${n.location}</div>
            <div class="topo-stats">
                <div>Yield: <strong>${fmtPct(n.yield_rate)}</strong></div>
                <div>Capacity: <strong>${Math.round(n.weekly_capacity_lce).toLocaleString()}</strong>/wk</div>
            </div>
        `;
        el.appendChild(card);

        if (i < data.nodes.length - 1) {
            const next = data.nodes[i + 1];
            const arc = arcByPair[`${n.node_id}->${next.node_id}`];
            const arrow = document.createElement("div");
            arrow.className = "topo-arrow";
            arrow.innerHTML = arc
                ? `&rarr;<span class="topo-arrow-label">${arc.lead_time_weeks}wk transit</span>`
                : `&rarr;<span class="topo-arrow-label">event injection</span>`;
            el.appendChild(arrow);
        }
    });
}

function renderPolicyTable(data) {
    const tbody = document.querySelector("#policy-table tbody");
    tbody.innerHTML = "";
    data.nodes.forEach((n) => {
        const p = data.policies[n.node_id];
        if (!p) return; // source nodes (e.g. atacama-deposits) have no order policy
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${n.location}</td>
            <td>${fmtKg(p.demand_mean)}</td>
            <td>${p.lead_time} wk</td>
            <td>${fmtKg(p.safety_stock)}</td>
            <td>${fmtKg(p.base_stock_level)}</td>
        `;
        tbody.appendChild(row);
    });
}

function renderCalibration(data) {
    document.getElementById("demand-mean-stat").innerText = fmtKg(data.demand_mean_kg_lce_per_week) + "/wk";
    document.getElementById("demand-cv-stat").innerText = fmtPct(data.demand_cv);
    document.getElementById("service-level-stat").innerText = fmtPct(data.service_level);
}

async function init() {
    try {
        const data = await loadModelOverview();
        renderTopology(data);
        renderPolicyTable(data);
        renderCalibration(data);
    } catch (err) {
        console.error(err);
        const el = document.getElementById("topology-diagram");
        el.innerHTML = `<p style="color: var(--danger);">Could not load the live model data -- run
            <code>python -m lithium_twin.main</code> first to generate
            client/data/model_overview.json.</p>`;
    }
}

init();
