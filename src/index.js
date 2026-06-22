import express from "express";
import cors from "cors";
import morgan from "morgan";
import { config } from "./config.js";
import { runMigrations } from "./migrate.js";
import { ticketsRouter } from "./routes/tickets.js";
import { startEmailPoller, stopEmailPoller } from "./services/emailPoller.js";
import { startSlaMonitor, stopSlaMonitor } from "./services/slaMonitor.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan("tiny"));

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "rpm-crm-backend" })
);

app.use("/api/tickets", ticketsRouter);

// Central error handler — FastAPI-style { detail }
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ detail: err.message || "Internal Server Error" });
});

async function main() {
  await runMigrations();
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
