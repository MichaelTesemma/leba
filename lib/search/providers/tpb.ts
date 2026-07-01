import type { SearchProvider, SearchResult } from "../types.js";

export function createTpbProvider(): SearchProvider {
  return {
    name: "tpb",
    async search(query: string): Promise<SearchResult[]> {
      const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Leba/2.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return (Array.isArray(data) ? data : [])
        .filter((r: any) => r.id !== "0" && r.name !== "No results returned")
        .map((r: any) => ({
          name: r.name,
          infoHash: (r.info_hash || "").toLowerCase(),
          size: parseInt(r.size, 10) || 0,
          seeders: parseInt(r.seeders, 10) || 0,
          leechers: parseInt(r.leechers, 10) || 0,
          source: "tpb",
        }));
    },
  };
}
