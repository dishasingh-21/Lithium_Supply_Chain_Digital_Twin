// Single source of truth for where the backend API lives.
//
// Deployed (combined Render service): server/src/app.js now serves this
// client/ folder itself via express.static, so client and API are
// same-origin in production -- a plain relative "/api" always resolves
// correctly there, with no URL to hardcode or update on redeploy.
//
// Local dev: if you're opening this client through a separate dev server
// (e.g. VS Code Live Server on :5500) rather than http://localhost:5000
// itself, "/api" would resolve against :5500 and 404, so this keeps the
// explicit localhost:5000 fallback for that one case.
const isLocalDevServer = ["localhost", "127.0.0.1", ""].includes(window.location.hostname)
  && window.location.port !== "5000";
window.API_BASE_URL = window.API_BASE_URL || (isLocalDevServer ? "http://localhost:5000/api" : "/api");
