"""
monte_carlo.py — Run many randomized trials to get outcome DISTRIBUTIONS,
not single-run point estimates.

WHY: a single run only tells you what happened under ONE random demand
sequence. Risk analysis needs: across plausible futures, how often does
fill rate drop below an acceptable level, and how bad is the tail?

PAIRED DESIGN: each trial runs baseline and disrupted on the SAME demand
seed. The paired difference (disrupted - baseline) isolates the
disruption's effect from ordinary demand randomness, which pure
between-arm comparison can't do.

WINDOW TRACKING: a disruption's damage can appear mid-run and fully
recover by the end (the recalibration process absorbs it), so a metric
measured only at the final week can show "no effect" even when there was
one transiently. track_window lets a trial also record the average of a
chosen weekly_snapshot metric over a specific week range (e.g. the
disruption's active window + recovery weeks).
"""
from __future__ import annotations
import argparse
import datetime
import json
import statistics
from dataclasses import dataclass, field
from pathlib import Path

from lithium_twin.simulation.disruption import Disruption
from lithium_twin.scenarios import run_scenario

CLIENT_MC_JSON = Path(__file__).parent.parent.parent / "client" / "data" / "monte_carlo_results.json"


@dataclass
class TrialResult:
    seed: int
    fill_rate: float
    final_backlog: float
    final_inventory: float
    window_avg: float | None = None
    bullwhip: dict[str, float] = field(default_factory=dict)


@dataclass
class MonteCarloResult:
    baseline_trials: list[TrialResult] = field(default_factory=list)
    disrupted_trials: list[TrialResult] = field(default_factory=list)
    has_disruption: bool = False

    @staticmethod
    def _percentiles(values: list[float]) -> dict[str, float]:
        if len(values) < 2:
            v = values[0] if values else float("nan")
            return {"mean": v, "stdev": 0.0, "p5": v, "p50": v, "p95": v}
        quantiles = statistics.quantiles(values, n=100, method="inclusive")
        return {
            "mean": statistics.mean(values),
            "stdev": statistics.stdev(values),
            "p5": quantiles[4],
            "p50": quantiles[49],
            "p95": quantiles[94],
        }

    def summary(self) -> dict:
        out = {
            "n_trials": len(self.baseline_trials),
            "baseline": {
                "fill_rate": self._percentiles([t.fill_rate for t in self.baseline_trials]),
                "final_backlog": self._percentiles([t.final_backlog for t in self.baseline_trials]),
            },
        }
        if self.has_disruption:
            out["disrupted"] = {
                "fill_rate": self._percentiles([t.fill_rate for t in self.disrupted_trials]),
                "final_backlog": self._percentiles([t.final_backlog for t in self.disrupted_trials]),
            }
            # Paired difference: same-seed disrupted minus baseline.
            # This is the number that actually answers "what does this
            # disruption cost", net of ordinary demand noise.
            paired_fill_diff = [
                d.fill_rate - b.fill_rate
                for b, d in zip(self.baseline_trials, self.disrupted_trials)
            ]
            paired_backlog_diff = [
                d.final_backlog - b.final_backlog
                for b, d in zip(self.baseline_trials, self.disrupted_trials)
            ]
            out["paired_impact"] = {
                "fill_rate_delta": self._percentiles(paired_fill_diff),
                "final_backlog_delta": self._percentiles(paired_backlog_diff),
            }
            if self.baseline_trials[0].window_avg is not None:
                paired_window_diff = [
                    d.window_avg - b.window_avg
                    for b, d in zip(self.baseline_trials, self.disrupted_trials)
                ]
                out["paired_impact"]["window_avg_delta"] = self._percentiles(paired_window_diff)
        return out

    def narrative_summary(self) -> str:
        """Plain-English narrative built directly from summary()'s own
        numbers -- deterministic, not an LLM call. Every sentence here is
        one number from summary(), formatted into prose; nothing is
        invented or estimated, matching the rest of this project's
        traceable, source-grounded approach to its math."""
        s = self.summary()
        n = s["n_trials"]
        b = s["baseline"]["fill_rate"]
        lines = [
            f"Across {n} simulated trials, each with its own independent "
            f"demand sequence, the baseline (undisrupted) OEM fill rate "
            f"averaged {b['mean']:.1%}, ranging from {b['p5']:.1%} in the "
            f"worst 5% of trials to {b['p95']:.1%} in the best 5%."
        ]

        if not self.has_disruption:
            lines.append("No disruption was modeled in this run.")
            return " ".join(lines)

        d = s["disrupted"]["fill_rate"]
        lines.append(
            f"Under the modeled disruption, fill rate averaged {d['mean']:.1%} "
            f"(p5={d['p5']:.1%}, p95={d['p95']:.1%})."
        )

        p = s["paired_impact"]["fill_rate_delta"]
        impact_mean = p["mean"]
        magnitude = abs(impact_mean)
        direction = "a drop" if impact_mean < 0 else "an increase"
        if magnitude < 0.01:
            severity = "negligible"
        elif magnitude < 0.03:
            severity = "modest"
        elif magnitude < 0.08:
            severity = "significant"
        else:
            severity = "severe"
        lines.append(
            f"Paired against the same demand seed in each trial (so the "
            f"comparison isolates the disruption's own effect from ordinary "
            f"demand noise), the disruption caused {direction} in fill rate "
            f"averaging {magnitude:.1%} -- a {severity} impact -- with the "
            f"5th-to-95th percentile range spanning {p['p5']:+.1%} to "
            f"{p['p95']:+.1%} across trials."
        )

        same_sign = (p["p5"] < 0 and p["p95"] < 0) or (p["p5"] > 0 and p["p95"] > 0)
        if same_sign:
            lines.append(
                "This effect was directionally consistent across nearly all "
                "trials -- even the most favorable 5% of trials still showed "
                "an impact in the same direction."
            )
        else:
            lines.append(
                "The effect's direction varied across trials -- some trials "
                "showed the opposite sign, so this average should be read "
                "together with that spread, not on its own."
            )

        bl = s["paired_impact"]["final_backlog_delta"]
        bl_direction = "rose" if bl["mean"] >= 0 else "fell"
        lines.append(
            f"Final-week backlog {bl_direction} by {abs(bl['mean']):,.0f} kg LCE "
            f"on average (p5={bl['p5']:+,.0f}, p95={bl['p95']:+,.0f} kg LCE)."
        )

        if "window_avg_delta" in s["paired_impact"]:
            w = s["paired_impact"]["window_avg_delta"]
            lines.append(
                f"During the disruption's active window and its immediate "
                f"aftermath, the tracked metric changed by {w['mean']:+,.0f} "
                f"on average -- this transient, window-level view can surface "
                f"an effect that fully washes out by the run's final week and "
                f"wouldn't otherwise show up in the final-week numbers above."
            )

        return " ".join(lines)

    def print_summary(self) -> None:
        s = self.summary()
        print(f"\n  Monte Carlo — {s['n_trials']} trials")
        print("  " + "=" * 60)

        def fmt_pct(block, label):
            p = block[label]
            print(f"    {label:16s} mean={p['mean']:7.1%}  p5={p['p5']:7.1%}  p50={p['p50']:7.1%}  p95={p['p95']:7.1%}")

        def fmt_qty(block, label):
            p = block[label]
            print(f"    {label:16s} mean={p['mean']:>12,.0f}  p5={p['p5']:>12,.0f}  p50={p['p50']:>12,.0f}  p95={p['p95']:>12,.0f}")

        print("\n  Baseline:")
        fmt_pct(s["baseline"], "fill_rate")
        fmt_qty(s["baseline"], "final_backlog")

        if self.has_disruption:
            print("\n  Disrupted:")
            fmt_pct(s["disrupted"], "fill_rate")
            fmt_qty(s["disrupted"], "final_backlog")

            print("\n  Paired impact (disrupted - baseline, same demand seed):")
            p = s["paired_impact"]["fill_rate_delta"]
            print(f"    fill_rate_delta  mean={p['mean']:+7.1%}  p5={p['p5']:+7.1%}  p50={p['p50']:+7.1%}  p95={p['p95']:+7.1%}")
            p = s["paired_impact"]["final_backlog_delta"]
            print(f"    backlog_delta    mean={p['mean']:+12,.0f}  p5={p['p5']:+12,.0f}  p50={p['p50']:+12,.0f}  p95={p['p95']:+12,.0f}")
            if "window_avg_delta" in s["paired_impact"]:
                p = s["paired_impact"]["window_avg_delta"]
                print(f"    window_avg_delta mean={p['mean']:+12,.0f}  p5={p['p5']:+12,.0f}  p50={p['p50']:+12,.0f}  p95={p['p95']:+12,.0f}")

        print("\n  Plain-English summary:")
        import textwrap
        print(textwrap.fill(self.narrative_summary(), width=78, initial_indent="  ", subsequent_indent="  "))


def export_dashboard_json(
        mc: MonteCarloResult, disruption: Disruption | None, weeks: int, n_trials: int,
        path: str | Path = CLIENT_MC_JSON,
) -> None:
    """Writes a static JSON snapshot of this Monte Carlo run -- the same
    summary() stats and narrative_summary() text print_summary() prints --
    for the client's Results Dashboard to read via fetch(). Point-in-time,
    like regional_demo.py's export_dashboard_json(); re-run this script (or
    let the Phase 4 Node bridge trigger it from the browser's scenario
    form) to refresh it."""
    payload = {
        "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "weeks_simulated": weeks,
        "n_trials": n_trials,
        "disruption": None if disruption is None else {
            "label": disruption.label(),
            "target_type": disruption.target_type,
            "parameter": disruption.parameter,
            "reduction_pct": disruption.reduction_pct,
            "start_week": disruption.start_week,
            "duration_weeks": disruption.duration_weeks,
        },
        "summary": mc.summary(),
        "narrative": mc.narrative_summary(),
        # Raw per-trial values (not just the percentiles in "summary") --
        # added so the client can draw an actual histogram of outcomes
        # across trials, instead of only the 3-5 summary numbers. A
        # histogram shows the SHAPE of the risk (e.g. a long bad tail vs.
        # a tight cluster) that mean/p5/p95 alone can look identical for.
        "trials": {
            "baseline_fill_rate": [t.fill_rate for t in mc.baseline_trials],
            "disrupted_fill_rate": (
                [t.fill_rate for t in mc.disrupted_trials] if mc.has_disruption else []
            ),
            "paired_fill_rate_delta": (
                [d.fill_rate - b.fill_rate for b, d in zip(mc.baseline_trials, mc.disrupted_trials)]
                if mc.has_disruption else []
            ),
        },
    }
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _window_average(engine, metric: str, week_start: int, week_end: int) -> float | None:
    values = [
        snap[metric] for snap in engine.weekly_snapshots
        if week_start <= snap["week"] <= week_end
    ]
    return statistics.mean(values) if values else None


def _to_trial_result(engine, seed: int, bullwhip_nodes: tuple[str, ...], track_window, track_metric: str) -> TrialResult:
    window_avg = None
    if track_window is not None:
        window_avg = _window_average(engine, track_metric, track_window[0], track_window[1])
    return TrialResult(
        seed=seed,
        fill_rate=engine.fill_rate("india-oem"),
        final_backlog=engine.graph.total_backlog(),
        final_inventory=engine.graph.total_inventory(),
        window_avg=window_avg,
        bullwhip={nid: engine.bullwhip_coefficient(nid) for nid in bullwhip_nodes},
    )


def run_monte_carlo(
    weeks: int,
    n_trials: int,
    disruptions: list[Disruption] | None = None,
    base_seed: int = 1000,
    bullwhip_nodes: tuple[str, ...] = ("india-oem",),
    track_window: tuple[int, int] | None = None,
    track_metric: str = "total_backlog",
) -> MonteCarloResult:
    """Runs n_trials paired baseline/disrupted simulations.

    Each trial i uses seed = base_seed + i, same seed for both arms of
    the pair, so the paired difference isolates the disruption's effect.
    """
    result = MonteCarloResult(has_disruption=disruptions is not None)
    for i in range(n_trials):
        seed = base_seed + i
        baseline_engine = run_scenario(weeks, disruptions=None, seed=seed)
        result.baseline_trials.append(
            _to_trial_result(baseline_engine, seed, bullwhip_nodes, track_window, track_metric)
        )
        if disruptions is not None:
            disrupted_engine = run_scenario(weeks, disruptions=disruptions, seed=seed)
            result.disrupted_trials.append(
                _to_trial_result(disrupted_engine, seed, bullwhip_nodes, track_window, track_metric)
            )
    return result

# Defaults reproduce the original hardcoded Chile mining-drought scenario
# exactly, so `python -m lithium_twin.simulation.monte_carlo` with no
# flags behaves exactly as it always has.
_DEFAULT_TARGET_TYPE = "arc"
_DEFAULT_TARGET_ID = "atacama-deposits,chile-mining"
_DEFAULT_PARAMETER = "capacity_lce"
_DEFAULT_REDUCTION_PCT = 0.40
_DEFAULT_START_WEEK = 70
_DEFAULT_DURATION_WEEKS = 15


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Monte Carlo risk analysis for a disruption scenario (defaults to the "
                     "Chile mining-drought scenario if no --target-* flags are given)."
    )
    parser.add_argument("--weeks", type=int, default=104)
    parser.add_argument("--n-trials", type=int, default=100)
    parser.add_argument("--no-disruption", action="store_true",
                         help="Run baseline-only Monte Carlo (no disruption modeled).")
    parser.add_argument("--target-type", choices=["node", "arc"], default=_DEFAULT_TARGET_TYPE)
    parser.add_argument("--target-id", default=_DEFAULT_TARGET_ID,
                         help="A node_id for --target-type node, or 'source,dest' for arc.")
    parser.add_argument("--parameter", default=_DEFAULT_PARAMETER,
                         help="e.g. weekly_capacity (node) or capacity_lce (arc).")
    parser.add_argument("--reduction-pct", type=float, default=_DEFAULT_REDUCTION_PCT,
                         help="0.0-1.0, e.g. 0.4 for a 40%% cut.")
    parser.add_argument("--start-week", type=int, default=_DEFAULT_START_WEEK)
    parser.add_argument("--duration-weeks", type=int, default=_DEFAULT_DURATION_WEEKS)
    parser.add_argument("--track-window-start", type=int, default=None, help="Defaults to --start-week.")
    parser.add_argument("--track-window-end", type=int, default=None,
                         help="Defaults to --start-week + --duration-weeks + 5 (active period + 5 recovery weeks).")
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

    track_window = None
    if disruption is not None:
        window_start = args.track_window_start if args.track_window_start is not None else disruption.start_week
        window_end = (
            args.track_window_end if args.track_window_end is not None
            else disruption.start_week + disruption.duration_weeks + 5
        )
        track_window = (window_start, window_end)

    mc = run_monte_carlo(
        weeks=args.weeks,
        n_trials=args.n_trials,
        disruptions=[disruption] if disruption else None,
        track_window=track_window,
    )
    mc.print_summary()

    export_dashboard_json(mc, disruption, weeks=args.weeks, n_trials=args.n_trials)
    print(f"\n  Dashboard snapshot written to {CLIENT_MC_JSON}")