import path from "path";
import { statSync } from "fs";
// @ts-expect-error — no @types/webtorrent available
import WebTorrent from "webtorrent";
import crypto from "crypto";
import { BoundedMap } from "../cache/bounded-map.js";
import { registerCache, cleanupHash } from "../cache/torrent-caches.js";
import { downloadDir, transcodeDir, dataDir } from "../storage/paths.js";
import { dumpRcSessions } from "../storage/rc-sessions.js";
import { JsonStore } from "../storage/store.js";
import { WatchHistory } from "../storage/watch-history.js";
import { SavedList } from "../storage/saved-list.js";
import type { WatchRecord } from "../storage/watch-history.js";
import type { SavedItem } from "../storage/saved-list.js";
import type { Request, Response, NextFunction } from "express";
import type {
  CompletedFile, StreamEntry, ActiveTranscode,
  AvailEntry, IntroEntry, ProbeResult, RCSession, SeekEntry,
  Torrent, TorrentFile, TorrentClient, LogLevel, ServerContext,
} from "../types.js";

interface CreateContextOverrides {
  client?: TorrentClient;
}

export function createContext(overrides: CreateContextOverrides = {}): ServerContext {
  const client: TorrentClient = overrides.client || (new WebTorrent() as unknown as TorrentClient);

  const DOWNLOAD_PATH = downloadDir();
  const TRANSCODE_PATH = transcodeDir();

  const durationCache = new Map<string, number>(); // "infoHash:fileIndex" -> seconds
  const seekIndexCache = new BoundedMap<SeekEntry[]>(20); // "infoHash:fileIndex" -> [{ time, offset }, ...]
  const seekIndexPending = new Set<string>();
  const activeFiles = new Map<string, Set<number>>();
  const completedFiles = new BoundedMap<CompletedFile>(200); // Bounded — prevents memory leak from completed torrents
  const streamTracker = new Map<string, StreamEntry>();
  const activeTranscodes = new Map<string, ActiveTranscode>();
  const availabilityCache = new BoundedMap<AvailEntry>(500); // Bounded + TTL — prevents growth during binge sessions
  const AVAIL_TTL = 2 * 60 * 60 * 1000;

  registerCache("durationCache", durationCache as Map<string, unknown>, "hash:index");
  registerCache("seekIndexCache", seekIndexCache as unknown as Map<string, unknown>, "hash:index");
  registerCache("seekIndexPending", seekIndexPending, "hash:index");
  registerCache("activeFiles", activeFiles as Map<string, unknown>, "hash");

  const introCache = new BoundedMap<IntroEntry>(100); // "tmdbId:season" -> { intro_start, intro_end, source }
  // Not registered with torrent-caches — keyed by tmdbId, not infoHash.
  // BoundedMap LRU eviction handles size; entries are cross-torrent so cleanup-by-hash doesn't apply.

  const probeCache = new BoundedMap<ProbeResult>(50); // filePath -> result
  registerCache("probeCache", probeCache as unknown as Map<string, unknown>, "path");

  // ── Persistent storage ──────────────────────────────────────────────
  const profileDir = dataDir();
  const watchHistoryStore = new JsonStore<WatchRecord>(path.join(profileDir, "watch-history.json"), 5000, log);
  const watchHistory = new WatchHistory(watchHistoryStore);
  const savedListStore = new JsonStore<SavedItem>(path.join(profileDir, "saved-list.json"), 5000, log);
  const savedList = new SavedList(savedListStore);

  // Stable token generated once per server start. After the PC passes nginx
  // basic auth once, the app sets a 30-day cookie with this token. Nginx's
  // auth_request accepts the cookie on subsequent requests, skipping the
  // basic auth prompt.
  const pcAuthToken = crypto.randomBytes(16).toString("hex");

  // ── Remote Control sessions ──────────────────────────────────────────
  const rcSessions = new Map<string, RCSession>(); // sessionId -> { playerClient, remoteClients, playbackState, lastActivity }

  // Expire sessions after 24h of inactivity
  const _rcExpiry = setInterval(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let deleted = false;
    for (const [id, s] of rcSessions) {
      if (s.lastActivity < cutoff) {
        if (s.playerClient) s.playerClient.end();
        for (const c of s.remoteClients) c.end();
        rcSessions.delete(id);
        deleted = true;
        log("info", "RC session expired", { sessionId: id });
      }
    }
    if (deleted) dumpRcSessions(rcSessions);
  }, 60 * 1000);
  if (_rcExpiry.unref) _rcExpiry.unref();

  function log(level: LogLevel, msg: string, data?: unknown): void {
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = ({ info: "INFO", warn: "WARN", err: " ERR" } as Record<string, string>)[level] || level;
    const extra = data ? " " + JSON.stringify(data) : "";
    console.log(`[${ts}] ${prefix}  ${msg}${extra}`);
  }

  function diskPath(torrent: Torrent, file: TorrentFile): string {
    return path.join(DOWNLOAD_PATH, file.path);
  }

  function isFileComplete(torrent: Torrent, file: TorrentFile): boolean {
    if (file.length > 0 && file.downloaded < file.length) return false;
    try {
      const stat = statSync(diskPath(torrent, file));
      return stat.size === file.length;
    } catch {
      return false;
    }
  }

  // Clean all caches for a torrent — delegates to central registry
  function cleanupTorrentCaches(infoHash: string, torrent?: Torrent): void {
    // Persist paths for completed files so they can be served after torrent removal
    if (torrent?.files) {
      for (let i = 0; i < torrent.files.length; i++) {
        const f = torrent.files[i];
        const fp = diskPath(torrent, f);
        try {
          const stat = statSync(fp);
          if (stat.size === f.length && stat.size > 0) {
            completedFiles.set(`${infoHash}:${i}`, { path: fp, size: f.length, name: f.name });
          }
        } catch { /* file doesn't exist */ }
      }
    }
    const filePaths = torrent?.files
      ? torrent.files.map((f: TorrentFile) => diskPath(torrent, f))
      : [];
    cleanupHash(infoHash, filePaths);
  }

  function trackStreamOpen(infoHash: string): void {
    const entry = streamTracker.get(infoHash) || { count: 0, idleTimer: null };
    entry.count++;
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    streamTracker.set(infoHash, entry);
  }

  function trackStreamClose(infoHash: string): void {
    const entry = streamTracker.get(infoHash);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count > 0) return;
    // All streams closed — kill background transcodes after 2 min
    // If torrent has completed files on disk, just pause it instead of destroying
    // (destroying forces a slow re-add from peers next time the user plays it)
    entry.idleTimer = setTimeout(() => {
      const torrent = client.torrents.find((t: Torrent) => t.infoHash === infoHash);
      if (torrent) {
        const hasCompleteFiles = torrent.files.some((f: TorrentFile) => {
          try { return f.length > 0 && statSync(diskPath(torrent, f)).size === f.length; }
          catch { return false; }
        });
        if (hasCompleteFiles) {
          if (!torrent.paused) torrent.pause();
          log("info", "Paused idle torrent (files on disk)", { name: torrent.name });
        } else {
          cleanupTorrentCaches(infoHash, torrent);
          log("info", "Auto-removing idle torrent", { name: torrent.name });
          torrent.destroy({ destroyStore: false });
        }
      }
      streamTracker.delete(infoHash);
    }, 2 * 60 * 1000);
    if (entry.idleTimer.unref) entry.idleTimer.unref();
  }

  // Middleware that auto-tracks stream open/close for any /api/stream* route.
  // INVARIANT: Every endpoint that serves torrent data MUST go through this
  // middleware, or the idle timer will destroy the torrent prematurely.
  function streamTracking(req: Request, res: Response, next: NextFunction): void {
    const infoHash = req.params.infoHash as string | undefined;
    if (!infoHash) return next();
    trackStreamOpen(infoHash);
    res.on("close", () => trackStreamClose(infoHash));
    next();
  }

  return {
    get client() { return client; },
    DOWNLOAD_PATH, TRANSCODE_PATH,
    durationCache, seekIndexCache, seekIndexPending,
    activeFiles, completedFiles, streamTracker, activeTranscodes,
    availabilityCache, AVAIL_TTL, introCache, probeCache, pcAuthToken,
    rcSessions, watchHistory, savedList,
    log, diskPath, isFileComplete, cleanupTorrentCaches,
    trackStreamOpen, trackStreamClose, streamTracking,
  };
}
