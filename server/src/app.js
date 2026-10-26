const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");

const stationsRoutes = require("./routes/stations.routes");
const recommendationsRoutes = require("./routes/recommendations.routes");
const routeRoutes = require("./routes/route.routes");
const warehousesRoutes = require("./routes/warehouses.routes");
const digitalTwinRoutes = require("./routes/digitalTwin.routes");
const { errorHandler, notFound } = require("./middleware/errorHandler");

function createApp() {
  const app = express();
  app.set("trust proxy", 1); // behind Render/Railway/etc. proxies

  app.use(cors({ origin: process.env.CLIENT_ORIGIN || "*" }));
  app.use(express.json({ limit: "100kb" }));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  app.get("/api/health", (req, res) => {
    const dbUp = mongoose.connection.readyState === 1;
    res.status(dbUp ? 200 : 503).json({ status: dbUp ? "ok" : "db_unavailable" });
  });

  // Route planning fans out to public OSRM/Nominatim servers, so cap it.
  app.use("/api/route", rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false }));

  // Each run-scenario call spawns three Python subprocesses and can take
  // tens of seconds, so it's capped much harder than the ordinary API routes.
  app.use(
    "/api/digital-twin/run-scenario",
    rateLimit({ windowMs: 5 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false })
  );

  app.use("/api/stations", stationsRoutes);
  app.use("/api/recommendations", recommendationsRoutes);
  app.use("/api/route", routeRoutes);
  app.use("/api/warehouses", warehousesRoutes);
  app.use("/api/digital-twin", digitalTwinRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
