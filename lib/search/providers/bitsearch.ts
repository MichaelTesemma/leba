import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function createBitsearchProvider(): SearchProvider {
  return {
    name: "bitsearch",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://bitsearch.to/search?q=${encodeURIComponent(query)}`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const itemRegex = /<a href="\/torrent\/([^"]+)"[^>]*>(.*?)<\/a>/gs;
        let itemMatch;
        while ((itemMatch = itemRegex.exec(html)) !== null && results.length < 20) {
          const id = itemMatch[1];
          const htmlContent = itemMatch[2];
          const nameMatch = htmlContent.match(/title="([^"]{5,})"/);
          if (!nameMatch) continue;
          const start = Math.max(0, itemMatch.index - 100);
          const context = html.slice(start, itemMatch.index + 300);
          const sizeMatch = context.match(/([\d.]+)\s*(TB|GB|MB)/i);
          const seedMatch = context.match(/seeders[^>]*>\s*([\d,]+)/i);
          results.push({
            name: nameMatch[1].trim(),
            infoHash: id.length === 40 ? id.toLowerCase() : `bitsearch:${id}`,
            size: sizeMatch ? parseSize(`${sizeMatch[1]} ${sizeMatch[2]}`) : 0,
            seeders: seedMatch ? parseInt(seedMatch[1].replace(/,/g, ""), 10) : 0,
            leechers: 0,
            source: "bitsearch",
          });
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
