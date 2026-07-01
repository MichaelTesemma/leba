import crypto from "crypto";
import path from "path";
import { loadConfig, getDebridMode } from "./debrid.js";
import type { DebridProvider, DebridFileInfo, DebridStream, DebridMode } from "./debrid.js";

interface ActiveDebridStream {
  url: string;
  files: DebridFileInfo[];
  streamKey: string;
}

const RD_BASE = "https://api.real-debrid.com/rest/1.0";
const TB_BASE = "https://api.torbox.app/v1/api";

interface RDTorrentInfo {
  id: string;
  status: string;
  files: { id: number; path: string; bytes: number; selected: number }[];
  links: string[];
  progress: number;
}

interface TBFileInfo {
  id: number;
  name: string;
  size: number;
  short_name: string;
  mimetype: string;
}

interface TBTorrentInfo {
  id: number;
  hash: string;
  name: string;
  download_state: string;
  download_finished: boolean;
  files: TBFileInfo[];
}

function isVideoFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".mkv", ".mp4", ".avi", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".ts", ".mpg", ".mpeg"].includes(ext);
}

class RealDebridProvider implements DebridProvider {
  name = "realdebrid";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async rdFetch(endpoint: string, opts: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${RD_BASE}${endpoint}`, {
      ...opts,
      headers: { ...this.headers(), ...opts.headers },
    });
    if (res.status === 401) throw new Error("debrid_auth_failed");
    if (res.status === 403) throw new Error("debrid_premium_required");
    if (res.status === 429) throw new Error("debrid_rate_limited");
    return res;
  }

  private formBody(params: Record<string, string>): URLSearchParams {
    return new URLSearchParams(params);
  }

  async validateKey() {
    try {
      const res = await this.rdFetch("/user");
      if (!res.ok) return { valid: false, premium: false, expiration: null, username: null };
      const data = await res.json() as { type: string; expiration: string; username: string };
      return {
        valid: true,
        premium: data.type === "premium",
        expiration: data.expiration || null,
        username: data.username || null,
      };
    } catch {
      return { valid: false, premium: false, expiration: null, username: null };
    }
  }

  async checkCached(_infoHashes: string[]): Promise<Map<string, boolean>> {
    return new Map();
  }

  warmCache(magnetURI: string, fileIdx?: number): void {
    this.rdFetch("/torrents/addMagnet", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: this.formBody({ magnet: magnetURI }),
    }).then(async (addRes) => {
      if (!addRes.ok) return;
      const { id } = await addRes.json() as { id: string };
      try {
        const info = await this.pollTorrentStatus(id, ["waiting_files_selection", "downloaded"], 10000);
        if (info.status === "waiting_files_selection") {
          const files = this.pickFiles(info.files, fileIdx);
          await this.rdFetch(`/torrents/selectFiles/${id}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: this.formBody({ files }),
          });
        }
      } catch { /* ignore */ }
    }).catch(() => {});
  }

  async unrestrict(magnetURI: string, fileIdx?: number): Promise<DebridStream> {
    const addRes = await this.rdFetch("/torrents/addMagnet", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: this.formBody({ magnet: magnetURI }),
    });
    if (!addRes.ok) {
      const err = await addRes.json().catch(() => ({})) as { error?: string };
      throw new Error(`debrid_add_failed: ${err.error || addRes.status}`);
    }
    const { id } = await addRes.json() as { id: string };

    try {
      let info = await this.pollTorrentStatus(id, ["waiting_files_selection", "downloaded"], 30000);
      let selectedRdId: number | null = null;
      if (info.status === "waiting_files_selection") {
        const filesToSelect = this.pickFiles(info.files, fileIdx);
        selectedRdId = parseInt(filesToSelect, 10);
        await this.rdFetch(`/torrents/selectFiles/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: this.formBody({ files: filesToSelect }),
        });
        info = await this.pollTorrentStatus(id, ["downloaded"], 30000);
      }

      if (!info.links || info.links.length === 0) throw new Error("debrid_no_links");

      const allFiles: DebridFileInfo[] = info.files.map((f) => ({
        id: f.id, path: f.path, bytes: f.bytes,
      }));

      const unRes = await this.rdFetch("/unrestrict/link", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: this.formBody({ link: info.links[0] }),
      });
      if (!unRes.ok) throw new Error("debrid_unrestrict_failed");

      const dl = await unRes.json() as { download: string; filename: string; filesize: number };
      const videoFileIndex = selectedRdId ? selectedRdId - 1 : 0;
      return { url: dl.download, filename: dl.filename, filesize: dl.filesize, fileIndex: videoFileIndex, files: allFiles };
    } catch (err) {
      try { await this.rdFetch(`/torrents/delete/${id}`, { method: "DELETE" }); } catch {}
      throw err;
    }
  }

  private pickFiles(files: RDTorrentInfo["files"], preferredIdx?: number): string {
    if (preferredIdx !== undefined) {
      const target = files.find((f) => f.id === preferredIdx + 1);
      if (target && isVideoFile(target.path)) return String(target.id);
    }
    const videoFiles = files.filter((f) => isVideoFile(f.path));
    if (videoFiles.length === 0) return "all";
    return String(videoFiles.reduce((a, b) => (b.bytes > a.bytes ? b : a)).id);
  }

  private async pollTorrentStatus(id: string, targetStatuses: string[], timeoutMs: number): Promise<RDTorrentInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.rdFetch(`/torrents/info/${id}`);
      if (!res.ok) throw new Error("debrid_poll_failed");
      const info = await res.json() as RDTorrentInfo;
      if (targetStatuses.includes(info.status)) return info;
      if (["magnet_error", "error", "virus", "dead"].includes(info.status)) {
        throw new Error(`debrid_torrent_${info.status}`);
      }
      await new Promise((r) => setTimeout(r, timeoutMs <= 30000 ? 1000 : 2000));
    }
    throw new Error("debrid_timeout");
  }
}

class TorBoxProvider implements DebridProvider {
  name = "torbox";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private headers() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async tbFetch(endpoint: string, opts: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${TB_BASE}${endpoint}`, {
      ...opts,
      headers: { ...this.headers(), ...opts.headers },
    });
    if (res.status === 401 || res.status === 403) throw new Error("debrid_auth_failed");
    if (res.status === 429) throw new Error("debrid_rate_limited");
    return res;
  }

  async validateKey() {
    try {
      const res = await this.tbFetch("/user/me");
      if (!res.ok) return { valid: false, premium: false, expiration: null, username: null };
      const { data } = await res.json() as { data: { plan: number; premium_expires_at: string; email: string } };
      return {
        valid: true,
        premium: data.plan > 0,
        expiration: data.premium_expires_at || null,
        username: data.email || null,
      };
    } catch {
      return { valid: false, premium: false, expiration: null, username: null };
    }
  }

  async checkCached(infoHashes: string[]): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (infoHashes.length === 0) return result;
    const batches: string[][] = [];
    for (let i = 0; i < infoHashes.length; i += 50) batches.push(infoHashes.slice(i, i + 50));
    for (const batch of batches) {
      try {
        const hashParam = batch.map((h) => h.toLowerCase()).join(",");
        const res = await this.tbFetch(`/torrents/checkcached?hash=${hashParam}&format=object`);
        if (!res.ok) { for (const h of batch) result.set(h.toLowerCase(), false); continue; }
        const { data } = await res.json() as { data: Record<string, unknown> | null };
        for (const h of batch) result.set(h.toLowerCase(), !!data?.[h.toLowerCase()]);
      } catch {
        for (const h of batch) result.set(h.toLowerCase(), false);
      }
    }
    return result;
  }

  warmCache(magnetURI: string, _fileIdx?: number): void {
    this.tbFetch("/torrents/createtorrent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ magnet: magnetURI }),
    }).catch(() => {});
  }

  async unrestrict(magnetURI: string, fileIdx?: number): Promise<DebridStream> {
    const addRes = await this.tbFetch("/torrents/createtorrent", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ magnet: magnetURI }),
    });
    if (!addRes.ok) {
      const err = await addRes.json().catch(() => ({})) as { detail?: string };
      throw new Error(`debrid_add_failed: ${err.detail || addRes.status}`);
    }
    const { data: addData } = await addRes.json() as { data: { torrent_id: number; hash: string } };
    const torrentId = addData.torrent_id;

    try {
      const torrent = await this.pollTorrentReady(torrentId, 30000);
      const allFiles: DebridFileInfo[] = torrent.files.map((f: TBFileInfo) => ({
        id: f.id, path: f.name, bytes: f.size,
      }));
      const videoFile = this.pickFile(torrent.files, fileIdx);
      if (!videoFile) throw new Error("debrid_no_links");

      const dlRes = await fetch(
        `${TB_BASE}/torrents/requestdl?token=${encodeURIComponent(this.apiKey)}&torrent_id=${torrentId}&file_id=${videoFile.id}`,
      );
      if (!dlRes.ok) throw new Error("debrid_unrestrict_failed");
      const { data: dlUrl } = await dlRes.json() as { data: string };

      return {
        url: dlUrl, filename: videoFile.short_name || videoFile.name,
        filesize: videoFile.size, fileIndex: fileIdx ?? allFiles.findIndex((f) => f.id === videoFile.id),
        files: allFiles,
      };
    } catch (err) {
      try {
        await this.tbFetch("/torrents/controltorrent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ torrent_id: torrentId, operation: "delete" }),
        });
      } catch {}
      throw err;
    }
  }

  private pickFile(files: TBFileInfo[], preferredIdx?: number): TBFileInfo | null {
    if (preferredIdx !== undefined) {
      const target = files.find((f) => f.id === preferredIdx);
      if (target && isVideoFile(target.name)) return target;
    }
    const videoFiles = files.filter((f) => isVideoFile(f.name));
    if (videoFiles.length === 0) return null;
    return videoFiles.reduce((a, b) => (b.size > a.size ? b : a));
  }

  private async pollTorrentReady(torrentId: number, timeoutMs: number): Promise<TBTorrentInfo> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.tbFetch(`/torrents/mylist?bypass_cache=true&id=${torrentId}`);
      if (!res.ok) throw new Error("debrid_poll_failed");
      const { data } = await res.json() as { data: TBTorrentInfo | null };
      if (!data) throw new Error("debrid_poll_failed");
      if (data.download_finished) return data;
      const errorStates = ["stalled (no seeds)", "paused", "error", "failed"];
      if (errorStates.includes(data.download_state)) {
        throw new Error(`debrid_torrent_${data.download_state.replace(/\s+/g, "_")}`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("debrid_timeout");
  }
}

export class DebridService {
  private activeDebridStreams = new Map<string, ActiveDebridStream>();
  private activeDebridKeys = new Map<string, string>();
  private provider: DebridProvider | null | undefined = undefined;

  getProvider(): DebridProvider | null {
    if (this.provider === undefined) this.reloadProvider();
    return this.provider || null;
  }

  getMode(): DebridMode {
    return getDebridMode();
  }

  reloadProvider(): void {
    const cfg = loadConfig();
    if (cfg?.provider === "realdebrid" && cfg.apiKey) {
      this.provider = new RealDebridProvider(cfg.apiKey);
    } else if (cfg?.provider === "torbox" && cfg.apiKey) {
      this.provider = new TorBoxProvider(cfg.apiKey);
    } else {
      this.provider = null;
    }
  }

  setActiveStream(infoHash: string, url: string, files: DebridFileInfo[]): string {
    const normalized = infoHash.toLowerCase();
    const previous = this.activeDebridStreams.get(normalized);
    if (previous) this.activeDebridKeys.delete(previous.streamKey);
    const streamKey = crypto.randomBytes(16).toString("hex");
    this.activeDebridStreams.set(normalized, { url, files, streamKey });
    this.activeDebridKeys.set(streamKey, normalized);
    return streamKey;
  }

  getActiveUrl(infoHash: string): string | null {
    return this.activeDebridStreams.get(infoHash.toLowerCase())?.url || null;
  }

  getActiveFiles(infoHash: string): DebridFileInfo[] {
    return this.activeDebridStreams.get(infoHash.toLowerCase())?.files || [];
  }

  getActiveStreamByKey(streamKey: string): ActiveDebridStream | null {
    const infoHash = this.activeDebridKeys.get(streamKey);
    if (!infoHash) return null;
    return this.activeDebridStreams.get(infoHash) || null;
  }
}
