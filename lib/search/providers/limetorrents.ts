import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function createLimeTorrentsProvider(): SearchProvider {
  return {
    name: "lime",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://www.limetorrents.lol/search/all/${encodeURIComponent(query)}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const rowRegex = /<tr>.*?<td class="tdleft".*?<a[^>]+href="([^"]+)"[^>]*title="([^"]{5,})"[^>]*>.*?<\/tr>/gs;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(html)) !== null && results.length < 20) {
          const link = rowMatch[1];
          const name = rowMatch[2].trim();
          const hashMatch = link.match(/\/([a-f0-9]{40})\.html/i);
          const infoHash = hashMatch ? hashMatch[1].toLowerCase() : "";
          if (!infoHash) continue;
          const context = rowMatch[0];
          const sizeMatch = context.match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
          const seedMatch = context.match(/seeders[^>]*>\s*([\d,]+)/i);
          results.push({
            name,
            infoHash,
            size: sizeMatch ? parseSize(`${sizeMatch[1]} ${sizeMatch[2]}`) : 0,
            seeders: seedMatch ? parseInt(seedMatch[1].replace(/,/g, ""), 10) : 0,
            leechers: 0,
            source: "lime",
          });
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
