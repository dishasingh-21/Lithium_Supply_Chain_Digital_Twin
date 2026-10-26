"""
main.py — Core SimPy engine demo: base-stock policy, 156-week run.

HOW TO RUN:
  python -m lithium_twin.main

WHAT TO LOOK FOR IN THE OUTPUT:
  1. OEM fill rate: expect it to oscillate rather than settle near the
     95% target -- a decentralized chain with multi-week lead times
     produces boom-bust bullwhip cycles, not a flat steady state.
  2. Bullwhip coefficients: should be > 1 and generally increasing
     upstream -- this confirms the model is producing realistic dynamics.
  3. Total inventory drawdown: system starts with buffer stock that
     the policies gradually consume; backlog grows during each
     downswing of the oscillation.
"""

from __future__ import annotations
import datetime
import json
import sys
from pathlib import Path
from lithium_twin.simulation.capacity import set_generous_capacities
from lithium_twin.models.events import EventType

sys.path.insert(0, str(Path(__file__).parent.parent))

from lithium_twin.models.graph import SupplyChainGraph
from lithium_twin.models.events import EventLog
from lithium_twin.models.material import lce_from_kwh
from lithium_twin.simulation.demand import DemandGenerator
from lithium_twin.simulation.order_policy import build_policies
from lithium_twin.simulation.engine import SupplyChainEngine

CHAIN_JSON = Path(__file__).parent / "data" / "chain.json"
CLIENT_MODEL_JSON = Path(__file__).parent.parent / "client" / "data" / "model_overview.json"
WEEKS = 156
DEMAND_MEAN = lce_from_kwh(200_000 * 30, "LFP") / 52.0   # ~36,862 kg/wk
DEMAND_CV = 0.15
SERVICE_LEVEL = 0.95


def export_model_overview_json(graph: SupplyChainGraph, policies: dict, path: str | Path = CLIENT_MODEL_JSON) -> None:
    """Writes a static JSON snapshot of the chain topology and calibrated
    order policies for the client's "How It Works" explainer page -- real
    numbers read straight off the live model (post set_generous_capacities,
    the capacities the engine actually runs with), not hand-typed copies
    that could silently drift out of sync with chain.json or a future
    recalibration. Must be called BEFORE engine.run() mutates node state --
    inventory_on_hand needs to still be each node's INITIAL inventory."""
    nodes = []
    for node_id in graph.topological_sort():
        n = graph.get_node(node_id)
        nodes.append({
            "node_id": n.node_id,
            "node_type": n.node_type.value,
            "location": n.location,
            "weekly_capacity_lce": n.weekly_capacity,
            "lead_time_weeks": n.lead_time_weeks,
            "yield_rate": n.yield_rate,
            "initial_inventory_lce": n.inventory_on_hand,
            "downstream": graph.downstream_nodes(node_id),
        })
    arcs = []
    for node_id in graph.topological_sort():
        for dest_id in graph.downstream_nodes(node_id):
            arc = graph.arc_data(node_id, dest_id)
            arcs.append({
                "source": node_id,
                "dest": dest_id,
                "capacity_lce": arc["capacity_lce"],
                "lead_time_weeks": arc["lead_time_weeks"],
                "transport_loss": arc.get("transport_loss", 0.0),
            })
    policy_rows = {
        node_id: {
            "base_stock_level": p.base_stock_level,
            "safety_stock": p.safety_stock,
            "demand_mean": p.demand_mean,
            "lead_time": p.lead_time,
            "smoothing_alpha": p.smoothing_alpha,
        }
        for node_id, p in policies.items()
    }
    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "demand_mean_kg_lce_per_week": DEMAND_MEAN,
        "demand_cv": DEMAND_CV,
        "service_level": SERVICE_LEVEL,
        "nodes": nodes,
        "arcs": arcs,
        "policies": policy_rows,
    }
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def run() -> None:
    print("=" * 65)
    print("  Lithium Supply Chain Digital Twin — Phase 1")
    print("  SimPy engine | Base-stock policy | 52-week run")
    print("=" * 65)

    # ── Load chain ────────────────────────────────────────────────────
    graph = SupplyChainGraph.from_json(CHAIN_JSON)
    set_generous_capacities(graph, DEMAND_MEAN)
    log = EventLog()

    # ── Demand generator ──────────────────────────────────────────────
    demand_gen = DemandGenerator(mean=DEMAND_MEAN, cv=DEMAND_CV, seed=42)
    print(f"\nDemand: Normal(μ={DEMAND_MEAN:,.0f}, σ={demand_gen.std:,.0f}) kg LCE/wk")

    # ── Build policies ────────────────────────────────────────────────
    policies = build_policies(graph, DEMAND_MEAN, DEMAND_CV, SERVICE_LEVEL)
    print(f"\nOrder policies (service level {SERVICE_LEVEL:.0%}):")
    for node_id, policy in policies.items():
        print(f"  {node_id:30s}  {policy.summary()}")

    # ── Export topology + policies snapshot for the client's "How It
    # Works" page (before engine.run() mutates node inventory) ─────────
    export_model_overview_json(graph, policies)
    print(f"\nModel overview snapshot written to {CLIENT_MODEL_JSON}")

    # ── Run simulation ────────────────────────────────────────────────
    engine = SupplyChainEngine(graph, log, policies, demand_gen, service_level=SERVICE_LEVEL)
    print(f"\nRunning {WEEKS}-week simulation...")
    engine.run(WEEKS)
    print("\n  Diagnostic — OEM cumulative fill rate & backlog trend:")
    for wk in [13, 26, 39, 52, 65, 78, 91, 104, 117, 130, 143, 156]:
        demand_so_far = log.total_flow(EventType.DEMAND_RECEIVED, node_id="india-oem", week_end=wk)
        dispatched_so_far = log.total_flow(EventType.SHIPMENT_DISPATCHED, node_id="india-oem", week_end=wk)
        fr = dispatched_so_far / demand_so_far if demand_so_far else 0.0
        snap = next((s for s in engine.weekly_snapshots if s["week"] == wk), None)
        backlog_at_wk = snap["oem_backlog"] if snap else None
        print(f"  week {wk:3d}:  cumulative fill rate={fr:6.1%}   oem_backlog={backlog_at_wk:,.0f}")
    print(f"Done. {len(log)} events logged.")

    # ── Results ───────────────────────────────────────────────────────
    print(f"\n{'='*65}")
    print(f"  RESULTS — {WEEKS} weeks")
    print(f"{'='*65}")

    print(f"\n  OEM fill rate:        {engine.fill_rate('india-oem'):>8.1%}")
    print(f"  Pack fill rate:       {engine.fill_rate('india-pack-assembly'):>8.1%}")

    print(f"\n  Bullwhip coefficients (order variance / OEM demand variance):")
    for node_id in graph.topological_sort():
        bw = engine.bullwhip_coefficient(node_id)
        if bw != bw:  # nan = no orders placed (source node)
            continue
        bar = "█" * min(40, int(bw * 5))
        print(f"  {node_id:30s}  {bw:6.2f}  {bar}")

    if engine.weekly_snapshots:
        last = engine.weekly_snapshots[-1]
        print(f"\n  Final state (week {WEEKS}):")
        print(f"  Total system inventory:  {last['total_inventory']:>12,.0f} kg LCE")
        print(f"  Total in transit:        {last['total_in_transit']:>12,.0f} kg LCE")
        print(f"  Total system backlog:    {last['total_backlog']:>12,.0f} kg LCE")
        print(f"  OEM inventory:           {last['oem_inventory']:>12,.0f} kg LCE")
        print(f"  OEM backlog:             {last['oem_backlog']:>12,.0f} kg LCE")

    print(f"\n  ✓ Core engine run complete (Phases 1-3a: policies, disruptions,")
    print(f"  Monte Carlo, optimization benchmark, multi-customer backlog)\n")


if __name__ == "__main__":
    run()