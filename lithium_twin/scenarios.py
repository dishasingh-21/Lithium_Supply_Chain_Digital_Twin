"""
scenarios.py — Run and compare disruption scenarios against a baseline.

HOW TO RUN:
  python -m lithium_twin.scenarios
"""

from __future__ import annotations
import argparse
import datetime
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from lithium_twin.models.graph import SupplyChainGraph
from lithium_twin.models.events import EventLog
from lithium_twin.simulation.demand import DemandGenerator
from lithium_twin.simulation.order_policy import build_policies
from lithium_twin.simulation.capacity import set_generous_capacities
from lithium_twin.simulation.engine import SupplyChainEngine
from lithium_twin.simulation.disruption import Disruption

# Reuse main.py's calibrated constants instead of redefining them
from lithium_twin.main import CHAIN_JSON, DEMAND_MEAN, DEMAND_CV, SERVICE_LEVEL

CLIENT_FLOW_JSON = Path(__file__).parent.parent / "client" / "data" / "chain_flow.json"


def run_scenario(weeks: int, disruptions: list[Disruption] | None = None, seed: int = 42) -> SupplyChainEngine:
    """Runs one full scenario from a fresh graph, with a given demand seed.
    Same seed across two calls = same demand sequence, so any difference
    in outcome is attributable only to the disruptions passed in."""
    graph = SupplyChainGraph.from_json(CHAIN_JSON)
    set_generous_capacities(graph, DEMAND_MEAN)
    log = EventLog()
    demand_gen = DemandGenerator(mean=DEMAND_MEAN, cv=DEMAND_CV, seed=seed)
    policies = build_policies(graph, DEMAND_MEAN, DEMAND_CV, SERVICE_LEVEL)
    engine = SupplyChainEngine(graph, log, policies, demand_gen, service_level=SERVICE_LEVEL)
    engine.run(weeks, disruptions=disruptions)
    return engine


def export_chain_flow_json(
        baseline: SupplyChainEngine, disrupted: SupplyChainEngine | None,
        disruption: Disruption | None, path: str | Path = CLIENT_FLOW_JSON,
) -> None:
    """Writes a static JSON snapshot of EVERY node's fill rate/backlog/
    inventory -- baseline vs disrupted side by side -- so the client's
    live chain-flow view can show a disruption's effect actually
    propagating stage by stage through the chain, not just the final
    OEM-level number the Monte Carlo card already shows. Point-in-time,
    like the other export_dashboard_json functions; re-run this script
    (or trigger it via the Node endpoint) to refresh it."""
    node_rows = []
    for node_id in baseline.graph.topological_sort():
        node = baseline.graph.get_node(node_id)
        row = {
            "node_id": node_id,
            "node_type": node.node_type.value,
            "location": node.location,
            "baseline_fill_rate": baseline.fill_rate(node_id),
            "baseline_backlog": node.total_backlog(),
            "baseline_inventory": node.inventory_on_hand,
            # Week-by-week trajectory (added alongside the single
            # before/after numbers above) -- lets the client draw a
            # sparkline showing WHEN a disruption's shock actually hits
            # this stage and how long recovery takes, instead of just the
            # two static endpoints, which can hide a shock that fully
            # resolves by the final week.
            "weekly_inventory": [
                snap["nodes"][node_id]["inventory"] for snap in baseline.weekly_snapshots
            ],
            "weekly_backlog": [
                snap["nodes"][node_id]["backlog"] for snap in baseline.weekly_snapshots
            ],
        }
        if disrupted is not None:
            d_node = disrupted.graph.get_node(node_id)
            row["disrupted_fill_rate"] = disrupted.fill_rate(node_id)
            row["disrupted_backlog"] = d_node.total_backlog()
            row["disrupted_inventory"] = d_node.inventory_on_hand
            row["disrupted_weekly_inventory"] = [
                snap["nodes"][node_id]["inventory"] for snap in disrupted.weekly_snapshots
            ]
            row["disrupted_weekly_backlog"] = [
                snap["nodes"][node_id]["backlog"] for snap in disrupted.weekly_snapshots
            ]
        node_rows.append(row)

    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "disruption": None if disruption is None else {
            "label": disruption.label(),
            "target_type": disruption.target_type,
            "parameter": disruption.parameter,
            "reduction_pct": disruption.reduction_pct,
            "start_week": disruption.start_week,
            "duration_weeks": disruption.duration_weeks,
        },
        "nodes": node_rows,
    }
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


# Defaults reproduce the original hardcoded Chile mining-drought scenario
# exactly, consistent with monte_carlo.py's and regional_demo.py's CLIs.
_DEFAULT_TARGET_TYPE = "arc"
_DEFAULT_TARGET_ID = "atacama-deposits,chile-mining"
_DEFAULT_PARAMETER = "capacity_lce"
_DEFAULT_REDUCTION_PCT = 0.40
_DEFAULT_START_WEEK = 70
_DEFAULT_DURATION_WEEKS = 15


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a baseline vs disrupted scenario comparison and export per-node "
                     "chain-flow data for the client's live flow view."
    )
    parser.add_argument("--weeks", type=int, default=104)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-disruption", action="store_true", help="Run baseline only, skip the disrupted arm.")
    parser.add_argument("--target-type", choices=["node", "arc"], default=_DEFAULT_TARGET_TYPE)
    parser.add_argument("--target-id", default=_DEFAULT_TARGET_ID,
                         help="A node_id for --target-type node, or 'source,dest' for arc.")
    parser.add_argument("--parameter", default=_DEFAULT_PARAMETER)
    parser.add_argument("--reduction-pct", type=float, default=_DEFAULT_REDUCTION_PCT)
    parser.add_argument("--start-week", type=int, default=_DEFAULT_START_WEEK)
    parser.add_argument("--duration-weeks", type=int, default=_DEFAULT_DURATION_WEEKS)
    return parser


def _disruption_from_args(args: argparse.Namespace) -> Disruption | None:
    if args.no_disruption:
        return None
    target_id = args.target_id
    if args.target_type == "arc":
        parts = [p.strip() for p in target_id.split(",")]
        if len(parts) != 2:
            raise ValueError("--target-id for an arc must be 'source,dest', e.g. 'atacama-deposits,chile-mining'.")
        target_id = tuple(parts)
    return Disruption(
        target_type=args.target_type,
        target_id=target_id,
        parameter=args.parameter,
        reduction_pct=args.reduction_pct,
        start_week=args.start_week,
        duration_weeks=args.duration_weeks,
    )


if __name__ == "__main__":
    args = _build_arg_parser().parse_args()
    disruption = _disruption_from_args(args)

    baseline = run_scenario(args.weeks, disruptions=None, seed=args.seed)
    disrupted = None if disruption is None else run_scenario(args.weeks, disruptions=[disruption], seed=args.seed)

    print("=" * 65)
    if disruption:
        print(f"  Scenario comparison -- {disruption.label()} {disruption.parameter} cut "
              f"{disruption.reduction_pct:.0%}, weeks {disruption.start_week}-"
              f"{disruption.start_week + disruption.duration_weeks}")
    else:
        print("  Baseline-only run")
    print("=" * 65)
    print(f"\n  Baseline OEM fill rate:    {baseline.fill_rate('india-oem'):>8.1%}")
    if disrupted:
        print(f"  Disrupted OEM fill rate:   {disrupted.fill_rate('india-oem'):>8.1%}")
        print(f"\n  Baseline final backlog:    {baseline.graph.total_backlog():>12,.0f} kg LCE")
        print(f"  Disrupted final backlog:   {disrupted.graph.total_backlog():>12,.0f} kg LCE")

    export_chain_flow_json(baseline, disrupted, disruption)
    print(f"\n  Chain-flow snapshot written to {CLIENT_FLOW_JSON}")