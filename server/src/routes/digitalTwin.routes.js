const express = require("express");
const { runScenario, getModelOverview } = require("../controllers/digitalTwinController");
const { requireAdmin } = require("../middleware/requireAdmin");

const router = express.Router();

router.get("/model", getModelOverview);
// Gated behind the same ADMIN_API_KEY write-protection every other write
// endpoint uses -- this one is heavier (spawns three Python subprocesses,
// can run for tens of seconds), so it's not left open to the public internet.
router.post("/run-scenario", requireAdmin, runScenario);

module.exports = router;
