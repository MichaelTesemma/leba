import type { SearchProvider, SearchResult } from "../types.js";
import { parseSize } from "../types.js";

export function createTorrentGalaxyProvider(): SearchProvider {
  return {
    name: "tgx",
    async search(query: string): Promise<SearchResult[]> {
      try {
        const url = `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(query)}&nox=2`;
        const resp = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          signal: AbortSignal.timeout(12000),
        });
        if (!resp.ok) return [];
        const html = await resp.text();
        const results: SearchResult[] = [];
        const jsonMatch = html.match(/var results\s*=\s*(\[.*?\]);/s);
        if (jsonMatch) {
          try {
            const data: any[] = JSON.parse(jsonMatch[1]);
            for (const item of data.slice(0, 30)) {
              const hash = (item.hash || "").toLowerCase();
              if (!hash || hash.length !== 40) continue;
              results.push({
                name: item.name || item.title || "",
                infoHash: hash,
                size: parseSize(item.size || ""),
                seeders: parseInt(item.seeders, 10) || 0,
                leechers: parseInt(item.leechers, 10) || 0,
                source: "tgx",
              });
            }
          } catch { /* fallback to HTML */ }
        }
        if (results.length === 0) {
          const rowRegex = /<a href="\/torrent\/(\d+)\//g;
          let match;
          while ((match = rowRegex.exec(html)) !== null && results.length < 30) {
            const id = match[1];
            const start = Math.max(0, match.index - 200);
            const end = Math.min(html.length, match.index + 500);
            const chunk = html.slice(start, end);
            const nameMatch = chunk.match(/title="([^"]{10,})"/);
            const seedMatch = chunk.match(/title="Seeders[^"]*">\s*([\d,]+)/);
            const sizeMatch = chunk.match(/([\d.]+\s*(?:TB|GB|MB))/i);
            const hashMatch = chunk.match(/([a-f0-9]{40})/i);
            if (nameMatch) {
              results.push({
                name: nameMatch[1].trim(),
                infoHash: hashMatch?.[1]?.toLowerCase() || `tgx:${id}`,
                size: sizeMatch ? parseSize(sizeMatch[1]) : 0,
                seeders: seedMatch ? parseInt(seedMatch[1].replace(/,/g, ""), 10) : 0,
                leechers: 0,
                source: "tgx",
              });
            }
          }
        }
        return results;
      } catch {
        return [];
      }
    },
  };
}
