import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function create1337xProvider(): SearchProvider {
  return {
    name: "1337x",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const rowMatches = html.match(/<td class="coll-1 name".*?<\/td>.*?<\/tr>/gs) || [];
        for (const row of rowMatches.slice(0, 30)) {
          const nameMatch = row.match(/>([^<]+)<\/a>\s*<\/td>/);
          if (!nameMatch) continue;
          const name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
          if (name.length < 3) continue;
          const linkMatch = row.match(/href="\/torrent\/(\d+)\//);
          if (!linkMatch) continue;
          const seedMatch = row.match(/<td class="[\s\w]*seeds">(\d+)<\/td>/);
          const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;
          const leechMatch = row.match(/<td class="[\s\w]*leeches">(\d+)<\/td>/);
          const leechers = leechMatch ? parseInt(leechMatch[1], 10) : 0;
          const sizeMatch = row.match(/([\d.]+\s*(?:TB|GB|MB))/i);
          const size = sizeMatch ? parseSize(sizeMatch[1]) : 0;
          results.push({
            name,
            infoHash: `1337x:${linkMatch[1]}`,
            size,
            seeders,
            leechers,
            source: "1337x",
          });
        }
        await Promise.all(results.slice(0, 15).map(async (r) => {
          try {
            const id = r.infoHash.split(":")[1];
            const detailUrl = `https://1337x.to/torrent/${id}/x/`;
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
        return results.filter((r) => r.infoHash.length === 40);
      } catch {
        return [];
      }
    },
  };
}
