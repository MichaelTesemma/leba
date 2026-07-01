import type { SearchProvider, SearchResult } from "./types.js";
import { createTpbProvider } from "./providers/tpb.js";
import { createYtsProvider } from "./providers/yts.js";
import { createEztvProvider } from "./providers/eztv.js";
import { create1337xProvider } from "./providers/torrent1337x.js";
import { createTorrentGalaxyProvider } from "./providers/torrentgalaxy.js";
import { createBtdiggProvider } from "./providers/btdigg.js";
import { createBitsearchProvider } from "./providers/bitsearch.js";
import { createBt4gProvider } from "./providers/bt4g.js";
import { createLimeTorrentsProvider } from "./providers/limetorrents.js";
import { createNyaaProvider } from "./providers/nyaa.js";

export interface TieredSearchOpts {
  log?: (level: "info" | "warn" | "err", msg: string, data?: unknown) => void;
}

/**
 * Wraps a promise with a timeout that returns [] on timeout instead of rejecting.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string, log?: TieredSearchOpts["log"]): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      if (log) log("warn", "Provider timed out", { provider: label, ms });
      resolve([] as unknown as T);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve([] as unknown as T); },
    );
  });
}

export class SearchRegistry {
  private providers: SearchProvider[] = [];

  constructor(opts?: TieredSearchOpts) {
    this.providers = [
      createTpbProvider(),
      createYtsProvider(),
      createEztvProvider(),
      create1337xProvider(),
      createTorrentGalaxyProvider(),
      createBitsearchProvider(),
      createBt4gProvider(),
      createBtdiggProvider(),
      createLimeTorrentsProvider(),
      createNyaaProvider(),
    ];
  }

  getProviders(): readonly SearchProvider[] {
    return this.providers;
  }

  async searchAll(query: string, imdbId?: string, log?: TieredSearchOpts["log"]): Promise<SearchResult[]> {
    // Tier 1: Fast JSON APIs (3s timeout)
    const tier1 = this.providers.filter((p) =>
      ["tpb", "yts", "eztv"].includes(p.name)
    ).map((p) => withTimeout(p.search(query, imdbId), 3000, p.name, log));

    // Tier 2: Structured HTML sites (5s timeout)
    const tier2 = this.providers.filter((p) =>
      ["tgx", "bitsearch", "bt4g", "1337x"].includes(p.name)
    ).map((p) => withTimeout(p.search(query, imdbId), 5000, p.name, log));

    // Tier 3: DHT indexers and niche (7s timeout)
    const tier3 = this.providers.filter((p) =>
      ["btdigg", "lime", "nyaa"].includes(p.name)
    ).map((p) => withTimeout(p.search(query, imdbId), 7000, p.name, log));

    const [r1, r2, r3] = await Promise.all([
      Promise.allSettled(tier1),
      Promise.allSettled(tier2),
      Promise.allSettled(tier3),
    ]);

    const all: SearchResult[] = [
      ...r1.filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === "fulfilled").flatMap((r) => r.value),
      ...r2.filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === "fulfilled").flatMap((r) => r.value),
      ...r3.filter((r): r is PromiseFulfilledResult<SearchResult[]> => r.status === "fulfilled").flatMap((r) => r.value),
    ];

    // Dedupe by infoHash, keep the one with more seeders
    const seen = new Map<string, SearchResult>();
    for (const r of all) {
      if (!r.infoHash) continue;
      const existing = seen.get(r.infoHash);
      if (!existing || r.seeders > existing.seeders) {
        seen.set(r.infoHash, r);
      }
    }

    return [...seen.values()];
  }
}
