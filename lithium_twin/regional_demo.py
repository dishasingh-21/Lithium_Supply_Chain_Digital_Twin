"""
regional_demo.py -- Phase 3b demo: split india-oem's demand across
Rajasthan's warehouse regions (server/data/warehouses.xlsx) instead of one
undifferentiated national market, and report per-region fill rates.

Phase 3c adds export_dashboard_json(): a static JSON snapshot of this
same per-region data, written to client/data/regional_health.json for
the browser's Leaflet choropleth (client/supply-chain.html) to read via
a plain fetch(). Phase 4 added a live Python<->Node bridge (see
server/src/controllers/digitalTwinController.js) that triggers this
script automatically from the browser's scenario form; running it by
hand, as below, still works too and refreshes the same snapshot.

HOW TO RUN:
  python -m lithium_twin.regional_demo
"""
from __future__ import annotations
import argparse
import datetime
import json
from pathlib import Path
from lithium_twin.models.graph import SupplyChainGraph
from lithium_twin.models.events import EventLog, EventType
from lithium_twin.simulation.demand import DemandGenerator
from lithium_twin.simulation.order_policy import build_policies
from lithium_twin.simulation.capacity import set_generous_capacities
from lithium_twin.simulation.disruption import Disruption
from lithium_twin.simulation.engine import SupplyChainEngine
from lithium_twin.regions import Region, load_regions, region_demand_weights
from lithium_twin.main import CHAIN_JSON, DEMAND_MEAN, DEMAND_CV, SERVICE_LEVEL

CLIENT_DASHBOARD_JSON = Path(__file__).parent.parent / "client" / "data" / "regional_health.json"
# Yellow band width below SERVICE_LEVEL before a region counts as a
# "severe" (red) shortfall rather than a merely "below target" one.
_YELLOW_BAND = 0.15


def run_regional_demo(
        weeks: int = 104, seed: int = 42, disruptions: list[Disruption] | None = None,
) -> SupplyChainEngine:
    """disruptions is optional -- when given, the regional split reflects
    that scenario's impact instead of the undisrupted baseline, so the
    map can show which regions a given disruption actually hits hardest."""
    regions = load_regions()
    weights = region_demand_weights(regions)

    graph = SupplyChainGraph.from_json(CHAIN_JSON)
    set_generous_capacities(graph, DEMAND_MEAN)
    log = EventLog()
    demand_gen = DemandGenerator(mean=DEMAND_MEAN, cv=DEMAND_CV, seed=seed)
    policies = build_policies(graph, DEMAND_MEAN, DEMAND_CV, SERVICE_LEVEL)
    engine = SupplyChainEngine(
        graph, log, policies, demand_gen,
        service_level=SERVICE_LEVEL, region_weights=weights,
    )
    engine.run(weeks, disruptions=disruptions)
    return engine


def _status_for_fill_rate(fill_rate: float, service_level: float) -> str:
    """Traffic-light status, thresholds tied to SERVICE_LEVEL rather than
    arbitrary round numbers: "green" means the region is meeting the same
    target service level build_policies() was designed against, "yellow"
    is a shortfall within _YELLOW_BAND of that target, "red" is worse."""
    if fill_rate >= service_level:
        return "green"
    if fill_rate >= service_level - _YELLOW_BAND:
        return "yellow"
    return "red"


def _windowed_fill_rate(engine: SupplyChainEngine, node_id: str, week_start: int, week_end: int) -> float | None:
    """Fill rate computed ONLY across [week_start, week_end], instead of
    engine.fill_rate()'s full-run average. A full-run average over e.g.
    104 weeks dilutes a short, severe disruption into near-invisibility --
    exactly what monte_carlo.py's track_window already guards against for
    its own stats. This brings the same fix to the regional dashboard's
    headline number. Returns None when there's no demand in the window
    (nothing to compute a rate against)."""
    demand = engine.log.total_flow(
        EventType.DEMAND_RECEIVED, node_id=node_id, week_start=week_start, week_end=week_end,
    )
    if demand == 0:
        return None
    dispatched = engine.log.total_flow(
        EventType.SHIPMENT_DISPATCHED, node_id=node_id, week_start=week_start, week_end=week_end,
    )
    return dispatched / demand


def export_dashboard_json(
        engine: SupplyChainEngine, regions: list[Region], weights: dict[str, float],
        weeks: int, seed: int, disruption: Disruption | None = None,
        path: str | Path = CLIENT_DASHBOARD_JSON,
) -> None:
    """Writes a static JSON snapshot of per-region supply-chain health for
    the client's choropleth map (Phase 3c) to read. This is a
    point-in-time export, not a live feed -- refresh it by re-running
    this script whenever the model or scenario changes."""
    window = None
    if disruption is not None:
        window = (disruption.start_week, disruption.start_week + disruption.duration_weeks + 5)

    region_rows = []
    for region in regions:
        fr = engine.fill_rate_by_region(region.region_id)
        row = {
            "region_id": region.region_id,
            "name": region.name,
            "town": region.town,
            "lat": region.lat,
            "lon": region.lon,
            "demand_share": weights[region.region_id],
            "fill_rate": fr,
            "status": _status_for_fill_rate(fr, SERVICE_LEVEL),
        }
        region_rows.append(row)

    windowed_overall = (
        _windowed_fill_rate(engine, "india-oem", window[0], window[1]) if window else None
    )
    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "weeks_simulated": weeks,
        "seed": seed,
        "service_level_target": SERVICE_LEVEL,
        # Full-run average -- kept for backward compatibility with the
        # existing dashboard tile, but easy to misread: see
        # "overall_fill_rate_during_disruption" below for the number that
        # actually isolates a disruption's effect.
        "overall_fill_rate": engine.fill_rate("india-oem"),
        # Only set when a disruption is active -- fill rate within the
        # disruption's own window (+5 recovery weeks), which won't be
        # diluted by the dozens of normal weeks elsewhere in the run.
        "overall_fill_rate_during_disruption": windowed_overall,
        "disruption": None if disruption is None else {
            "label": disruption.label(),
            "target_type": disruption.target_type,
            "parameter": disruption.parameter,
            "reduction_pct": disruption.reduction_pct,
            "start_week": disruption.start_week,
            "duration_weeks": disruption.duration_weeks,
        },
        "regions": region_rows,
    }
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Regional OEM demand disaggregation, optionally under a disruption scenario."
    )
    parser.add_argument("--weeks", type=int, default=104)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--target-type", choices=["node", "arc"], default=None,
                         help="Omit all --target-*/--parameter/--reduction-pct/--start-week/"
                              "--duration-weeks flags for a baseline (no disruption) run.")
    parser.add_argument("--target-id", default=None,
                         help="A node_id for --target-type node, or 'source,dest' for arc.")
    parser.add_argument("--parameter", default=None, help="e.g. weekly_capacity (node) or capacity_lce (arc).")
    parser.add_argument("--reduction-pct", type=float, default=None, help="0.0-1.0, e.g. 0.4 for a 40%% cut.")
    parser.add_argument("--start-week", type=int, default=None)
    parser.add_argument("--duration-weeks", type=int, default=None)
    return parser


def _disruption_from_args(args: argparse.Namespace) -> Disruption | None:
    """All five disruption flags are required together, or all omitted for
    a baseline run -- a partial set is almost certainly a mistake, so it's
    rejected rather than silently filled in with a guessed default."""
    fields = (args.target_type, args.target_id, args.parameter, args.reduction_pct, args.start_week, args.duration_weeks)
    given = [f for f in fields if f is not None]
    if not given:
        return None
    if len(given) != len(fields):
        raise ValueError(
            "To run a disruption, pass --target-type, --target-id, --parameter, "
            "--reduction-pct, --start-week AND --duration-weeks together. "
            "Omit all six for a baseline run."
        )
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
    SEED = args.seed
    WEEKS = args.weeks

    regions = load_regions()
    weights = region_demand_weights(regions)
    engine = run_regional_demo(weeks=WEEKS, seed=SEED, disruptions=[disruption] if disruption else None)

    print("=" * 65)
    print("  Regional demand disaggregation -- india-oem by warehouse region")
    if disruption:
        print(f"  Scenario: {disruption.label()} {disruption.parameter} cut "
              f"{disruption.reduction_pct:.0%}, weeks {disruption.start_week}-"
              f"{disruption.start_week + disruption.duration_weeks}")
    print("=" * 65)
    print(f"\n  Overall OEM fill rate (full {WEEKS}-week run): {engine.fill_rate('india-oem'):>8.1%}")
    if disruption:
        window_end = disruption.start_week + disruption.duration_weeks + 5
        windowed = _windowed_fill_rate(engine, "india-oem", disruption.start_week, window_end)
        if windowed is not None:
            print(f"  Overall OEM fill rate (weeks {disruption.start_week}-{window_end}, "
                  f"the disruption's own window): {windowed:>8.1%}")
    print()
    print(f"  {'Region':15s}{'Demand share':>14s}{'Fill rate':>12s}")
    for region_id, weight in sorted(weights.items(), key=lambda kv: -kv[1]):
        fr = engine.fill_rate_by_region(region_id)
        print(f"  {region_id:15s}{weight:>13.1%}{fr:>12.1%}")

    export_dashboard_json(engine, regions, weights, weeks=WEEKS, seed=SEED, disruption=disruption)
    print(f"\n  Dashboard snapshot written to {CLIENT_DASHBOARD_JSON}")
