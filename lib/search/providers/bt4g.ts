import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function createBt4gProvider(): SearchProvider {
  return {
    name: "bt4g",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://bt4g.org/search/${encodeURIComponent(query)}/1`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const detailRegex = /<a href="\/torrent\/([a-f0-9]{40})"[^>]*title="([^"]{5,})"/gi;
        let match;
        while ((match = detailRegex.exec(html)) !== null && results.length < 20) {
          const infoHash = match[1].toLowerCase();
          const name = match[2].trim();
          const start = Math.max(0, match.index - 50);
          const context = html.slice(start, match.index + 400);
          const sizeMatch = context.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
          results.push({
            name,
            infoHash,
            size: sizeMatch ? parseSize(`${sizeMatch[1]} ${sizeMatch[2]}`) : 0,
            seeders: 0,
            leechers: 0,
            source: "bt4g",
          });
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
