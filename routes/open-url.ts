import { execFile } from "child_process";
import type { Express, Request, Response } from "express";
import type { LogCtx } from "../lib/types.js";

export default function openUrlRoutes(app: Express, ctx: LogCtx): void {
  app.post("/api/open-url", (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };

    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: "Invalid URL — only http/https allowed" });
      return;
    }

    // Use the platform's default browser — execFile avoids shell injection
    const [cmd, args] = process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", url]]
        : ["xdg-open", [url]];

    execFile(cmd, args, { windowsHide: true }, (err) => {
      if (err) ctx.log("warn", "Failed to open URL", { error: err.message, url });
    });

    res.json({ ok: true });
  });
}
