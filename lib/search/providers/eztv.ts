import type { SearchProvider, SearchResult } from "../types.js";

export function createEztvProvider(): SearchProvider {
  return {
    name: "eztv",
    async search(query: string, imdbId?: string): Promise<SearchResult[]> {
      if (!imdbId) return [];
      const numericId = imdbId.replace(/\D/g, "");
      if (!numericId) return [];
      try {
        const results: SearchResult[] = [];
        for (let page = 1; page <= 3; page++) {
          const url = `https://eztvx.to/api/get-torrents?imdb_id=${numericId}&limit=100&page=${page}`;
          const resp = await fetch(url, {
            headers: { "User-Agent": "Leba/2.0" },
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) break;
          const data: any = await resp.json();
          if (!data.torrents || data.torrents.length === 0) break;
          for (const t of data.torrents as any[]) {
            results.push({
              name: t.title || t.filename,
              infoHash: (t.hash || "").toLowerCase(),
              size: parseInt(t.size_bytes, 10) || 0,
              seeders: parseInt(t.seeds, 10) || 0,
              leechers: parseInt(t.peers, 10) || 0,
              source: "eztv",
            });
          }
          if (data.torrents.length < 100) break;
        }
        const terms = query.toLowerCase().split(/\s+/);
        return results.filter((r) => {
          const name = r.name.toLowerCase();
          return terms.every((term) => name.includes(term));
        });
      } catch {
        return [];
      }
    },
  };
}
