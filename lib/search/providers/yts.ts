import type { SearchProvider, SearchResult } from "../types.js";

export function createYtsProvider(): SearchProvider {
  return {
    name: "yts",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Leba/2.0" },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) return [];
        const data: any = await resp.json();
        if (!data.data?.movies) return [];
        const results: SearchResult[] = [];
        for (const movie of data.data.movies as any[]) {
          for (const torrent of (movie.torrents || []) as any[]) {
            results.push({
              name: `${movie.title_long} ${torrent.quality} ${torrent.type}`.trim(),
              infoHash: (torrent.hash || "").toLowerCase(),
              size: parseInt(torrent.size_bytes, 10) || 0,
              seeders: parseInt(torrent.seeds, 10) || 0,
              leechers: parseInt(torrent.peers, 10) || 0,
              source: "yts",
            });
          }
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
