import path from "path";
import { statSync } from "fs";
import { Agent as HttpAgent, Agent as HttpsAgent, request as httpRequest } from "http";
import type { IncomingMessage } from "http";
import type { Express, Request, Response } from "express";
import { jobKey } from "../lib/cache/torrent-caches.js";
import { isAllowedFile } from "../lib/media/media-utils.js";
import {
  probeMedia as _probeMedia, serveFile, serveFromTorrent,
  serveLiveTranscode as _serveLiveTranscode,
} from "../lib/media/transcode.js";
import type { ClientCtx, CacheCtx, StreamTrackingCtx, LogCtx, DebridCtx, Torrent, TorrentFile } from "../lib/types.js";



/**
 * Preload the first ~2 MB of a torrent file to speed up time-to-first-frame.
 * The MP4 moov atom (required for playback) typically lives in the first few pieces.
 */
function preloadFirstPieces(file: TorrentFile, torrent: Torrent): void {
  const target = Math.min(2 * 1024 * 1024, file.length); // 2 MB or file size
  const piecesNeeded = Math.ceil(target / torrent.pieceLength);
  const startPiece = Math.ceil(file.offset / torrent.pieceLength);
  const endPiece = Math.min(startPiece + piecesNeeded - 1, file._endPiece);

  // Select the first pieces with highest priority (1 = highest in WebTorrent)
  torrent.select(startPiece, endPiece, 1);
}

/**
 * Validate that a URL is safe to proxy — rejects internal/private IPs and dangerous schemes.
 */
function isSafeProxyUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    // Only allow http/https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();

    // Reject localhost and loopback
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;

    // Reject private/internal IP ranges
    if (/^10\./.test(hostname)) return false;
    if (/^192\.168\./.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
    if (/^169\.254\./.test(hostname)) return false; // link-local
    if (/^0\./.test(hostname)) return false; // 0.0.0.0/8

    // Reject dangerous schemes already caught by protocol check above
    if (hostname === "0.0.0.0") return false;

    return true;
  } catch {
    return false;
  }
}

export default function streamRoutes(app: Express, ctx: ClientCtx & CacheCtx & StreamTrackingCtx & LogCtx & DebridCtx): void {
  const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 10 });
  const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 10 });

  const {
    log, diskPath, isFileComplete, streamTracking, debrid,
    durationCache, activeReaders,
    completedFiles, activeTranscodes, probeCache,
  } = ctx;
  // Access ctx.client via getter (not destructured) so deferred init is visible
  const client = () => ctx.client;

  const probeMedia = (filePath: string) => _probeMedia(filePath, probeCache, log);

  app.get("/api/stream/:infoHash/:fileIndex", streamTracking, async (req: Request, res: Response) => {
    const { infoHash, fileIndex } = req.params as Record<string, string>;
    const torrent = client().torrents.find((t) => t.infoHash === infoHash);

    // Torrent removed but file still on disk — serve directly
    if (!torrent) {
      const fileKey = `${infoHash}:${fileIndex}`;
      const cached = completedFiles.get(fileKey);
      if (cached) {
        try {
          const stat = statSync(cached.path);
          if (stat.size === cached.size) {
            const ext = path.extname(cached.name).toLowerCase();
            log("info", "Serving from disk (torrent removed)", { file: cached.name });
            return serveFile(cached.path, cached.size,
              ext === ".webm" ? "video/webm" : "video/mp4", req, res);
          }
        } catch {}
        completedFiles.delete(fileKey);
      }
      return res.status(404).json({ error: "Torrent not found" });
    }

    const file = torrent.files[parseInt(fileIndex, 10)];
    if (!file) return res.status(404).json({ error: "File not found" });

    if (!isAllowedFile(file.name)) {
      return res.status(403).json({ error: "File type not allowed" });
    }

    const ext = path.extname(file.name).toLowerCase();
    const fileIdx = parseInt(fileIndex, 10);
    const audioStreamIdx = req.query.audio ? parseInt(req.query.audio as string, 10) : null;

    // Kill any previous live transcode for this file (e.g. from before a seek).
    const streamKey = `${torrent.infoHash}:${fileIdx}`;
    const prev = activeTranscodes.get(streamKey);
    if (prev) {
      log("info", "Killing previous transcode for new stream request", { streamKey });
      prev.cleanup();
      activeTranscodes.delete(streamKey);
    }

    // Ensure this file is selected and prioritized
    file.select();
    // Deselect other files so bandwidth goes to the requested file
    torrent.files.forEach((f, i) => {
      if (i !== fileIdx && f.length > 0) {
        try { f.deselect(); } catch {}
      }
    });

    const complete = isFileComplete(torrent, file);
    const filePath = diskPath(torrent, file);

    // Verify file is real media — only when complete.
    const cacheKey = jobKey(torrent.infoHash, fileIndex);

    if (complete) {
      try {
        const probe = await probeMedia(filePath);
        if (!probe.valid) {
          log("warn", "Blocked fake media file", { name: file.name, reason: probe.reason });
          return res.status(403).json({ error: "File failed media verification: " + probe.reason });
        }
        // Cache duration from probe so it's immediately available
        if (probe.duration && probe.duration > 0 && !durationCache.has(cacheKey)) {
          durationCache.set(cacheKey, probe.duration);
        }
      } catch {}
    }

    // Complete on disk — serve directly (mpv handles all formats)
    if (complete && audioStreamIdx === null) {
      log("info", "Serving from disk", { file: file.name });
      return serveFile(diskPath(torrent, file), file.length,
        ext === ".webm" ? "video/webm" : "video/mp4", req, res);
    }

    // Complete + audio track override — demux with ffmpeg
    if (complete && audioStreamIdx !== null) {
      log("info", "Serving with audio track override", { file: file.name, audioStreamIdx });
      return _serveLiveTranscode({
        inputPath: diskPath(torrent, file),
        useStdin: false,
        seekTo: parseFloat(req.query.t as string) || 0,
        audioStreamIdx,
        streamKey: `${torrent.infoHash}:${fileIdx}`,
      }, req, res, ctx);
    }

    // Still downloading — preload first pieces then stream via WebTorrent
    log("info", "Streaming via WebTorrent", { file: file.name });
    preloadFirstPieces(file, torrent);
    serveFromTorrent(file, req, res, activeReaders);
  });

  // ── Debrid stream proxy ──────────────────────────────────────────
  // Proxies an already-authorized debrid direct download URL with range request support.
  app.get("/api/debrid-stream", async (req: Request, res: Response) => {
    const streamKey = req.query.streamKey as string;
    if (!streamKey) return res.status(400).json({ error: "streamKey required" });

    const activeStream = debrid.getActiveStreamByKey(streamKey);
    if (!activeStream) return res.status(404).json({ error: "stream not found" });

    const { url } = activeStream;

    // SSRF protection: validate URL before proxying
    if (!isSafeProxyUrl(url)) {
      log("warn", "Blocked unsafe debrid stream URL", { url });
      return res.status(400).json({ error: "Invalid stream URL" });
    }

    const seekTo = parseFloat(req.query.t as string) || 0;
    const audioStreamIdx = req.query.audio ? parseInt(req.query.audio as string, 10) : null;

    // Determine file extension for content type
    let ext: string;
    try {
      ext = path.extname(new URL(url).pathname).toLowerCase() || ".mkv";
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    if (seekTo > 0 || audioStreamIdx !== null) {
      // Transcode path — ffmpeg for seeking or audio demux
      log("info", "Debrid stream via transcode", { ext, seekTo });
      return _serveLiveTranscode({
        inputPath: url,
        useStdin: false,
        seekTo,
        audioStreamIdx,
        streamKey: null,
      }, req, res, ctx);
    }

    // Direct proxy with range support (using http.request for keep-alive)
    try {
      const urlObj = new URL(url);
      const agent = urlObj.protocol === "https:" ? httpsAgent : httpAgent;

      const reqOpts = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "GET",
        headers: {
          ...(req.headers.range ? { Range: req.headers.range } : {}),
          Host: urlObj.host,
        },
        agent,
      };

      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const req2 = httpRequest(reqOpts, (res2) => resolve(res2));
        req2.on("error", reject);
        req2.end();
      });

      const status = upstream.statusCode || 200;
      if (status >= 400 && status !== 206) {
        return res.status(status).json({ error: "debrid_stream_failed" });
      }

      res.status(status);

      // Force fresh connection — prevents stale keep-alive after sleep/wake
      res.setHeader("Connection", "close");

      // Forward relevant headers
      const fwd = ["content-type", "content-length", "content-range", "accept-ranges"];
      for (const h of fwd) {
        const v = upstream.headers[h];
        if (v) res.setHeader(h, v);
      }
      if (!upstream.headers["content-type"]) {
        res.setHeader("Content-Type", ext === ".webm" ? "video/webm" : "video/mp4");
      }

      // Pipe the body
      upstream.on("error", () => res.end());
      res.on("close", () => upstream.destroy());
      upstream.pipe(res);
    } catch (err) {
      log("err", "Debrid stream proxy failed", { error: (err as Error).message });
      if (!res.headersSent) res.status(502).json({ error: "debrid_proxy_failed" });
    }
  });
}
