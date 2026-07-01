import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function createBtdiggProvider(): SearchProvider {
  return {
    name: "btdigg",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://btdig.com/search?q=${encodeURIComponent(query)}&p=0&order=0`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const divRegex = /<div class="one_result">(.*?)<\/div>\s*<div class="clear"><\/div>/gs;
        let divMatch;
        while ((divMatch = divRegex.exec(html)) !== null && results.length < 20) {
          const block = divMatch[1];
          const nameMatch = block.match(/<a[^>]+class="torrent_name"[^>]*>(.*?)<\/a>/);
          if (!nameMatch) continue;
          const name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
          const hashMatch = block.match(/urn:btih:([a-f0-9]{40})/i);
          const infoHash = hashMatch ? hashMatch[1].toLowerCase() : "";
          const sizeMatch = block.match(/Torrent size: ([\d.]+)\s*(TB|GB|MB|KB)/i);
          const size = sizeMatch ? parseSize(`${sizeMatch[1]} ${sizeMatch[2]}`) : 0;
          results.push({ name, infoHash, size, seeders: 0, leechers: 0, source: "btdigg" });
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
