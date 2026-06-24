import express from "express";
import cors from "cors";
import morgan from "morgan";
import { config } from "./config.js";
import { runMigrations } from "./migrate.js";
import { loadSettings, getSettings, setAutoReplyEnabled } from "./settings.js";
import { ticketsRouter } from "./routes/tickets.js";
import { authRouter } from "./routes/auth.js";
import { authMiddleware, requireModule } from "./auth/middleware.js";
import { startEmailPoller, stopEmailPoller } from "./services/emailPoller.js";
import { startSlaMonitor, stopSlaMonitor } from "./services/slaMonitor.js";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" })); // allow base64 reply attachments
app.use(morgan("tiny"));

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "rpm-crm-backend" })
);

app.use("/api/auth", authRouter);
app.use("/api/tickets", authMiddleware, ticketsRouter);

// Runtime settings (auto-reply toggle). Any authenticated user may read the
// state; only those allocated the Auto-reply module may change it.
app.get("/api/settings", authMiddleware, (_req, res) => res.json(getSettings()));
app.patch("/api/settings", authMiddleware, requireModule("autoreply"), async (req, res, next) => {
  try {
    if (typeof req.body.autoReplyEnabled === "boolean")
      await setAutoReplyEnabled(req.body.autoReplyEnabled);
    res.json(getSettings());
  } catch (e) {
    next(e);
  }
});

// Central error handler — FastAPI-style { detail }
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ detail: err.message || "Internal Server Error" });
});

async function main() {
  await runMigrations();
  await loadSettings();
  startEmailPoller();
  startSlaMonitor();

  const server = app.listen(config.port, () =>
    console.log(`[HTTP] RPM CRM backend listening on :${config.port}`)
  );

  const shutdown = () => {
    console.log("\n[HTTP] shutting down...");
    stopEmailPoller();
    stopSlaMonitor();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
