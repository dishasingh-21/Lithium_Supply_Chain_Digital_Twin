"""
SimPy discrete event simulation engine.
"""

from  __future__ import annotations
import simpy
from lithium_twin.models.graph import SupplyChainGraph
from lithium_twin.models.events import EventLog, EventType, SupplyChainEvent
from lithium_twin.simulation.order_policy import BaseStockPolicy
from lithium_twin.simulation.demand import DemandGenerator
from lithium_twin.simulation.disruption import Disruption

_RECYCLING_LEAD_TIME: int = 12
_RECYCLING_TRANSPORT_LOSS: float = 0.01
_RECALIBRATION_INTERVAL: int =4
_RECALIBRATION_WINDOW: int=12
_MIN_SAMPLES_FOR_RECALIBRATION: int=8

class SupplyChainEngine:
    """SimPy-based weekly simulation engine for the lithium supply chain."""
    def __init__(self, graph: SupplyChainGraph, log: EventLog, policies: dict[str, BaseStockPolicy], demand_gen: DemandGenerator, service_level: float=0.95, region_weights: dict[str, float] | None = None):
        """
        region_weights (Phase 3b, optional): {region_id: share of total
        demand}, e.g. from lithium_twin.regions.region_demand_weights().
        When given, india-oem's market demand is split across these
        regions (each tracked as its own customer_id in oem.backlog)
        instead of one pooled "market" stream. Each region gets its OWN
        DemandGenerator -- same CV as the aggregate, mean scaled by its
        weight, seeded deterministically off demand_gen's own seed so a
        run stays reproducible while regions are NOT perfectly correlated
        with each other (each advances its own independent RNG state).
        When omitted, behavior is unchanged from Phase 3a (single "market"
        customer) -- this is purely additive.
        """
        self.env = simpy.Environment()
        self.graph = graph
        self.log = log
        self.policies = policies
        self.demand_gen = demand_gen
        self.service_level = service_level
        self.weekly_snapshots: list[dict] = []
        self.region_weights = region_weights
        self._region_demand_gens: dict[str, DemandGenerator] | None = None
        if region_weights:
            base_seed = demand_gen.seed
            total_mean = demand_gen.mean
            cv = demand_gen.cv
            self._region_demand_gens = {
                region_id: DemandGenerator(
                    mean=total_mean * weight,
                    cv=cv,
                    seed=base_seed + i + 1,
                )
                for i, (region_id, weight) in enumerate(sorted(region_weights.items()))
            }

    def run(self, weeks: int, disruptions: list[Disruption] | None = None) -> None:
        """Run simulation for `weeks` time steps and collect metrics."""
        self.env.process(self._market_demand_process())
        for node_id in self.graph.topological_sort():
            self.env.process(self._node_process(node_id))
        for node_id in self.policies:
            self.env.process(self._recalibration_process(node_id))
        self.env.process(self._recycling_injection_process())
        self.env.process(self._snapshot_process(weeks))
        for disruption in (disruptions or []):
            self.env.process(self._disruption_process(disruption))
        self.env.run(until=weeks+0.5)

    # MARKET DEMAND PROCESS
    def _market_demand_process(self):
        """Generates stochastic weekly demand at india-oem from the market.

        Phase 3b: when self._region_demand_gens is set, demand is drawn
        PER REGION (each region its own customer_id in oem.backlog) instead
        of one pooled "market" draw -- this is what lets fill_rate_by_region
        and the recalibration/bullwhip helpers below tell regions apart.
        """
        oem = self.graph.get_node("india-oem")
        while True:
            yield self.env.timeout(1)
            try:
                week = int(self.env.now)
                if self._region_demand_gens:
                    for region_id, gen in self._region_demand_gens.items():
                        demand = gen.sample()
                        oem.receive_demand(region_id, demand)
                        self.log.append(SupplyChainEvent(
                            event_type=EventType.DEMAND_RECEIVED,
                            source_node="india-oem",
                            week=week,
                            quantity_lce=demand,
                            payload={"source": "market", "region": region_id},
                        ))
                else:
                    demand = self.demand_gen.sample()
                    oem.receive_demand("market", demand)
                    self.log.append(SupplyChainEvent(
                        event_type=EventType.DEMAND_RECEIVED,
                        source_node="india-oem",
                        week=week,
                        quantity_lce=demand,
                        payload={"source": "market"},
                    ))
            except Exception as e:
                print(f"PROCESS CRASH: {type(e).__name__}: {e}")
                return

    # NODE REPLENISHMENT PROCESS
    def _node_process(self, node_id: str):
        """
        Weekly replenishment cycle for a single supply chain node.
        Each week:
            1. Dispatch to fill backlog (if inventory available)
            2. Check inventory position against base stock level S
            3. If below S: order from upstream supplier
        """
        node = self.graph.get_node(node_id)
        policy = self.policies.get(node_id)
        upstream_ids = self.graph.upstream_nodes(node_id)

        while True:
            yield self.env.timeout(1)
            week = int(self.env.now)

            if node.raw_input > 0:
                produced = node.produce()
                if produced > 0:
                    self.log.append(SupplyChainEvent(
                        event_type=EventType.PRODUCTION_COMPLETED,
                        source_node=node_id,
                        week=week,
                        quantity_lce=produced,
                    ))

            # Step 1: Retry fulfilling outstanding backlog from current
            # inventory, across however many customers this node has.
            # When inventory can't cover everyone, ration proportionally
            # to each customer's (arc-capacity-capped) share of demand --
            # a bias-free split, not first-come-first-served.
            if node.backlog and node.inventory_on_hand > 0:
                downstream_ids = self.graph.downstream_nodes(node_id)
                if downstream_ids and node_id!="india-oem":
                    capped_demand = {}
                    for receiver_id in downstream_ids:
                        owed = node.backlog.get(receiver_id, 0.0)
                        if owed <= 0:
                            continue
                        arc = self.graph.arc_data(node_id, receiver_id)
                        capped_demand[receiver_id] = min(owed, arc["capacity_lce"])
                    total_capped = sum(capped_demand.values())
                    if total_capped > 0:
                        available = min(node.inventory_on_hand, total_capped)
                        scale = available / total_capped if total_capped > available else 1.0
                        for receiver_id, demand_amt in capped_demand.items():
                            retry_qty = demand_amt * scale
                            if retry_qty <= 0:
                                continue
                            arc = self.graph.arc_data(node_id, receiver_id)
                            self.env.process(self._shipment_process(
                                supplier_id=node_id,
                                receiver_id=receiver_id,
                                order_qty=retry_qty,
                                arc=arc,
                            ))
                else:
                    # No real downstream node/arc (e.g. india-oem serving
                    # market/region customers directly) -- dispatch
                    # straight from inventory, rationed proportionally
                    # across backlogged customers.
                    total_owed = node.total_backlog()
                    if total_owed > 0:
                        available = min(node.inventory_on_hand, total_owed)
                        scale = available / total_owed if total_owed > available else 1.0
                        for customer_id, owed in list(node.backlog.items()):
                            if owed <= 0:
                                continue
                            dispatched = node.dispatch_shipment(customer_id, owed * scale)
                            if dispatched > 0:
                                self.log.append(SupplyChainEvent(
                                    event_type=EventType.SHIPMENT_DISPATCHED,
                                    source_node=node_id,
                                    week=week,
                                    quantity_lce=dispatched,
                                    payload={"customer": customer_id},
                                ))

            # Step-2: Reorder from upstream if below base level stock
            if policy is None or not upstream_ids:
                continue # Source nodes don't order
            inv_position = node.total_supply_position()
            order_qty = policy.order_quantity(inv_position)
            if order_qty <= 0:
                continue

            # Phase-1: single upstream supplier per node
            supplier_id = upstream_ids[0]
            arc = self.graph.arc_data(supplier_id, node_id)
            order_qty = min(order_qty, arc["capacity_lce"])

            # Notify upstream of demand
            supplier_node = self.graph.get_node(supplier_id)
            supplier_node.receive_demand(node_id, order_qty)
            self.log.append(SupplyChainEvent(
                event_type = EventType.DEMAND_RECEIVED,
                source_node = supplier_id,
                week=week,
                quantity_lce=order_qty,
                payload={"ordered_by": node_id},
            ))
            self.log.append(SupplyChainEvent(
                event_type=EventType.ORDER_PLACED,
                source_node=node_id,
                week=week,
                quantity_lce=order_qty,
                payload={"supplier": supplier_id},
            ))

            # Spawn shipment process (handles dispatch + transit + arrival)
            self.env.process(self._shipment_process(
                supplier_id=supplier_id,
                receiver_id=node_id,
                order_qty=order_qty,
                arc=arc,
            ))

    # SHIPMENT PROCESS
    def _shipment_process(self, supplier_id: str, receiver_id: str, order_qty: float, arc: dict,):
        """
        Models one shipment from supplier to receiver.
        Synchronous: supplier dispatches immediately.
        Async: yield timeout(lead_time) handles the transit delay.
        Receiver's in_transit is updated with ACTUAL dispatched amount.
        """
        supplier = self.graph.get_node(supplier_id)
        receiver = self.graph.get_node(receiver_id)
        lead_time = arc["lead_time_weeks"]
        transport_loss = arc.get("transport_loss", 0.0)

        # Supplier dispatches what it actually has (maybe less than order_qty)
        actual_dispatched = supplier.dispatch_shipment(receiver_id, order_qty)
        if actual_dispatched <= 0:
            return

        week_dispatched = int(self.env.now)
        receiver.place_order(actual_dispatched)
        self.log.append(SupplyChainEvent(
            event_type=EventType.SHIPMENT_DISPATCHED,
            source_node=supplier_id,
            week=week_dispatched,
            quantity_lce=actual_dispatched,
            payload={"dest": receiver_id},
        ))

        # Wait for transit
        yield self.env.timeout(lead_time)

        # Taking into account transport loss (moisture, spoilage, inspection rejection)
        arrived_qty = actual_dispatched * (1.0 - transport_loss)

        receiver.receive_shipment(arrived_qty)
        week_arrived = int(self.env.now)
        self.log.append(SupplyChainEvent(
            event_type=EventType.SHIPMENT_RECEIVED,
            source_node=receiver_id,
            week=week_arrived,
            quantity_lce=arrived_qty,
            payload={"from": supplier_id},
        ))

    # RECYCLING INJECTION PROCESS
    def _recycling_injection_process(self):
        """Recovers LCE from india-recycling and injects it at china-processing."""
        recycler = self.graph.get_node("india-recycling")
        china_proc = self.graph.get_node("china-processing")
        while True:
            yield self.env.timeout(1)
            week = int(self.env.now)

            available = recycler.inventory_on_hand
            if available <= 0:
                continue
            recycler.inventory_on_hand -= available

            self.env.process(
                self._recycling_arrival(available, week, china_proc)
            )

    def _recycling_arrival(self, qty: float, week_dispatched: int, china_proc):
        """Deliver recovered LCE to china-processing after transit."""
        yield self.env.timeout(_RECYCLING_LEAD_TIME)
        arrived = qty * (1.0 - _RECYCLING_TRANSPORT_LOSS)
        china_proc.inventory_on_hand += arrived     # direct shipment, not a shipment
        week_arrived = int(self.env.now)
        self.log.append(SupplyChainEvent(
            event_type=EventType.EXTERNAL_SUPPLY,
            source_node="china-processing",
            week=week_arrived,
            quantity_lce=arrived,
            payload={
                "from": "india-recycling",
                "dispatched_week": week_dispatched,
            },
        ))

    # METRICS SNAPSHOT PROCESS
    def _snapshot_process(self, total_weeks: int):
        """Records system-wide state at end of each week for analysis.

        "nodes" generalizes the original three hardcoded per-node fields
        (oem_inventory, pack_inventory, china_proc_inventory, etc.) to
        EVERY node in the chain, keyed by node_id -- added so a per-stage
        week-by-week trajectory (a sparkline showing exactly when a
        disruption's shock hits a given stage and how long it takes to
        recover) can be drawn for any node, not just the three that
        happened to be named explicitly early on. The original fields are
        kept unchanged alongside it so nothing that already reads them
        (main.py's diagnostic loop, existing tests) breaks."""
        for _ in range(total_weeks):
            yield self.env.timeout(1)
            week = int(self.env.now)
            oem = self.graph.get_node("india-oem")
            pack = self.graph.get_node("india-pack-assembly")
            china = self.graph.get_node("china-processing")
            self.weekly_snapshots.append({
                "week": week,
                "total_inventory": self.graph.total_inventory(),
                "total_in_transit": self.graph.total_in_transit(),
                "total_backlog": self.graph.total_backlog(),
                "oem_inventory": oem.inventory_on_hand,
                "oem_backlog": oem.total_backlog(),
                "pack_inventory": pack.inventory_on_hand,
                "pack_backlog": pack.total_backlog(),
                "china_proc_inventory": china.inventory_on_hand,
                "nodes": {
                    n.node_id: {
                        "inventory": n.inventory_on_hand,
                        "backlog": n.total_backlog(),
                    }
                    for n in self.graph.all_nodes()
                },
            })

    # ANALYSIS HELPERS
    def bullwhip_coefficient(self, node_id: str) -> float:
        """Ratio of order variance at node to demand variance at OEM.
        Bullwhip coefficient = Var(orders at node_id) / Var(demand at OEM)
        > 1.0: orders at this node are more variable than OEM demand (bullwhip)
        = 1.0: no amplification
        < 1.0: dampening (shouldn't occur under normal policy)

        Source: Chen et al. (2000), "Quantifying the Bullwhip Effect", Management Science 46(3).
        """
        import statistics

        def _weekly_totals(events) -> list[float]:
            """Sum same-week events before computing variance. With a
            single demand/order stream per node (Phase 1-3a default) this
            is a no-op -- there's already exactly one event per week.
            It matters once a node can log MORE than one event in the
            same week (Phase 3b: OEM gets one DEMAND_RECEIVED per region,
            per week) -- without this, variance would be computed over
            individual REGION-level draws rather than over TOTAL weekly
            demand, understating the true aggregate mean and corrupting
            the ratio bullwhip theory actually cares about."""
            totals: dict[int, float] = {}
            for e in events:
                totals[e.week] = totals.get(e.week, 0.0) + e.quantity_lce
            return list(totals.values())

        oem_demands = _weekly_totals(self.log.query(
            node_id="india-oem", event_type=EventType.DEMAND_RECEIVED
        ))
        node_orders = _weekly_totals(self.log.query(
            node_id=node_id, event_type=EventType.ORDER_PLACED
        ))
        if len(oem_demands) < 2 or len(node_orders) < 2:
            return float("nan")
        var_demand = statistics.variance(oem_demands)
        var_orders = statistics.variance(node_orders)
        if var_demand == 0:
            return float("inf")
        return var_orders/var_demand

    def fill_rate(self, node_id: str = "india-oem") -> float:
        """Fraction of demand that was dispatched on time."""
        total_demand = self.log.total_flow(
            EventType.DEMAND_RECEIVED, node_id=node_id
        )
        total_dispatched = self.log.total_flow(
            EventType.SHIPMENT_DISPATCHED, node_id=node_id
        )
        if total_demand == 0:
            return 0.0
        return total_dispatched / total_demand

    def fill_rate_by_region(self, region_id: str) -> float:
        """Fill rate for ONE india-oem region (Phase 3b). All regions share
        "india-oem" as source_node, so regions are told apart by payload,
        not by node_id: DEMAND_RECEIVED carries payload["region"] (set in
        _market_demand_process) and SHIPMENT_DISPATCHED carries
        payload["customer"] (set in _node_process's Step 1, which already
        tags every dispatch with the customer_id it was rationed to)."""
        total_demand = sum(
            e.quantity_lce for e in self.log.query(
                node_id="india-oem", event_type=EventType.DEMAND_RECEIVED
            )
            if e.payload.get("region") == region_id
        )
        total_dispatched = sum(
            e.quantity_lce for e in self.log.query(
                node_id="india-oem", event_type=EventType.SHIPMENT_DISPATCHED
            )
            if e.payload.get("customer") == region_id
        )
        if total_demand == 0:
            return 0.0
        return total_dispatched / total_demand

    def _recalibration_process(self, node_id: str):
        """
        Periodically recalibrates a node's safety stock from its own
        recently observed incoming order history, instead of leaving it
        fixed for the whole run.
        """
        policy = self.policies.get(node_id)
        if policy is None:
            return
        while True:
            yield self.env.timeout(_RECALIBRATION_INTERVAL)
            week = int(self.env.now)
            window_start = max(1, week-_RECALIBRATION_WINDOW+1)
            events = self.log.query(
                node_id = node_id, event_type = EventType.DEMAND_RECEIVED, week_start = window_start, week_end = week,
            )
            # Sum same-week events before recalibrating -- see the
            # matching note in bullwhip_coefficient(). Without this, a
            # node receiving several DEMAND_RECEIVED events in one week
            # (Phase 3b: OEM, once demand is split per region) would have
            # its safety stock recalibrated against individual REGION-level
            # draws instead of true total weekly demand.
            weekly_totals: dict[int, float] = {}
            for e in events:
                weekly_totals[e.week] = weekly_totals.get(e.week, 0.0) + e.quantity_lce
            observed = list(weekly_totals.values())
            if len(observed) < _MIN_SAMPLES_FOR_RECALIBRATION:
                continue
            policy.recalibrate(observed, service_level=self.service_level)

    def _disruption_process(self, disruption: Disruption):
        """Waits until start_week, degrades the target parameter, waits
        duration_weeks, then restores the original value exactly."""
        yield self.env.timeout(disruption.start_week)

        if disruption.target_type == "node":
            target = self.graph.get_node(disruption.target_id)
            original_value = getattr(target, disruption.parameter)
        else:
            from_id, to_id = disruption.target_id
            target = self.graph.arc_data(from_id, to_id)
            original_value = target[disruption.parameter]

        degraded_value = original_value * (1.0 - disruption.reduction_pct)

        if disruption.target_type == "node":
            setattr(target, disruption.parameter, degraded_value)
        else:
            target[disruption.parameter] = degraded_value

        self.log.append(SupplyChainEvent(
            event_type=EventType.DISRUPTION_STARTED,
            source_node=disruption.label(),
            week=int(self.env.now),
            quantity_lce=0.0,
            payload={"parameter": disruption.parameter, "reduced_to": degraded_value, "original": original_value},
        ))

        yield self.env.timeout(disruption.duration_weeks)

        if disruption.target_type == "node":
            setattr(target, disruption.parameter, original_value)
        else:
            target[disruption.parameter] = original_value

        self.log.append(SupplyChainEvent(
            event_type=EventType.DISRUPTION_ENDED,
            source_node=disruption.label(),
            week=int(self.env.now),
            quantity_lce=0.0,
            payload={"parameter": disruption.parameter, "restored_to": original_value},
        ))



