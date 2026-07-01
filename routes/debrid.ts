import type { Express, Request, Response } from "express";
import type { LogCtx, DebridCtx } from "../lib/types.js";
import {
  loadConfig, saveConfig, deleteConfig,
  type DebridMode,
} from "../lib/torrent/debrid.js";

export default function debridRoutes(app: Express, ctx: LogCtx & DebridCtx): void {
  const { log, debrid } = ctx;

  app.get("/api/debrid/status", (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.json({
      configured: !!cfg,
      provider: cfg?.provider || null,
      mode: debrid.getMode(),
    });
  });

  app.post("/api/debrid/config", async (req: Request, res: Response) => {
    const { apiKey, provider, mode } = req.body as { apiKey?: string; provider?: string; mode?: DebridMode };
    if (!apiKey || !provider) {
      return res.status(400).json({ error: "apiKey and provider are required" });
    }
    if (provider !== "realdebrid" && provider !== "torbox") {
      return res.status(400).json({ error: "Unsupported provider. Supported: realdebrid, torbox" });
    }

    saveConfig(provider, apiKey, mode || "on");
    debrid.reloadProvider();
    log("info", "Debrid config saved", { provider, mode: mode || "on" });
    res.json({ ok: true });
  });

  app.post("/api/debrid/mode", async (req: Request, res: Response) => {
    const { mode } = req.body as { mode?: DebridMode };
    if (mode !== "on" && mode !== "off") {
      return res.status(400).json({ error: "mode must be 'on' or 'off'" });
    }
    const cfg = loadConfig();
    if (!cfg) return res.status(400).json({ error: "Debrid not configured" });
    saveConfig(cfg.provider, cfg.apiKey, mode);
    log("info", "Debrid mode changed", { mode });
    res.json({ ok: true, mode });
  });

  app.delete("/api/debrid/config", (_req: Request, res: Response) => {
    deleteConfig();
    debrid.reloadProvider();
    log("info", "Debrid config removed");
    res.json({ ok: true });
  });

  app.get("/api/debrid/verify", async (_req: Request, res: Response) => {
    const provider = debrid.getProvider();
    if (!provider) {
      return res.json({ configured: false, valid: false, premium: false, expiration: null, username: null });
    }
    try {
      const result = await provider.validateKey();
      res.json({ configured: true, ...result });
    } catch (err) {
      log("warn", "Debrid verify failed", { error: (err as Error).message });
      res.json({ configured: true, valid: false, premium: false, expiration: null, username: null });
    }
  });

  app.post("/api/debrid/cached", async (req: Request, res: Response) => {
    const { infoHashes } = req.body as { infoHashes?: string[] };
    if (!infoHashes || !Array.isArray(infoHashes)) {
      return res.status(400).json({ error: "infoHashes array required" });
    }
    const provider = debrid.getProvider();
    if (!provider) {
      return res.json({ cached: {} });
    }
    try {
      const result = await provider.checkCached(infoHashes);
      const cached: Record<string, boolean> = {};
      for (const [hash, isCached] of result) cached[hash] = isCached;
      res.json({ cached });
    } catch (err) {
      log("warn", "Debrid cache check failed", { error: (err as Error).message });
      res.json({ cached: {} });
    }
  });
}
