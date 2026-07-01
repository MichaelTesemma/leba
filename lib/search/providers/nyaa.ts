import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function createNyaaProvider(): SearchProvider {
  return {
    name: "nyaa",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query)}&p=0&s=seeders&o=desc`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const rowRegex = /<tr[^>]*>\s*<td[^>]*>(\d+)<\/td>.*?<a href="\/view\/(\d+)"[^>]*title="([^"]{5,})"[^>]*>.*?<\/tr>/gs;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(html)) !== null && results.length < 20) {
          const seeders = parseInt(rowMatch[1], 10) || 0;
          const name = rowMatch[3].trim();
          const context = rowMatch[0];
          const sizeMatch = context.match(/([\d.]+)\s*(TiB|GiB|MiB|KiB)/i);
          results.push({
            name,
            infoHash: `nyaa:${rowMatch[2]}`,
            size: sizeMatch ? parseSize(sizeMatch[1] + sizeMatch[2].toLowerCase().replace("i", "")) : 0,
            seeders,
            leechers: 0,
            source: "nyaa",
          });
        }
        await Promise.all(results.slice(0, 15).map(async (r) => {
          try {
            const id = r.infoHash.split(":")[1];
            const detailUrl = `https://nyaa.si/view/${id}`;
            const detailResp = await fetch(detailUrl, {
              headers: { "User-Agent": "Mozilla/5.0" },
              signal: AbortSignal.timeout(8000),
            });
            if (!detailResp.ok) return;
            const detailHtml = await detailResp.text();
            const hashMatch = detailHtml.match(/([a-f0-9]{40})/);
            if (hashMatch) r.infoHash = hashMatch[1].toLowerCase();
          } catch { /* skip */ }
        }));
        return results.filter((r) => r.infoHash.length === 40 || r.infoHash.startsWith("nyaa:"));
      } catch {
        return [];
      }
    },
  };
}
