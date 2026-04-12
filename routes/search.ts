import type { Express, Request, Response } from "express";
import { scoreTorrent, parseTags, findEpisodeFile as findEpisodeFileFromList, findLargestVideoFile, hasWrongEpisode, coversTargetSeason } from "../lib/torrent/torrent-scoring.js";
import { fmtBytes, throttle } from "../lib/media/media-utils.js";
import { searchTorrentio } from "../lib/torrent/torrentio.js";
import { getDebridProvider, setActiveDebridStream, getDebridMode } from "../lib/torrent/debrid.js";
import type { ServerContext, Torrent } from "../lib/types.js";

interface SearchResult {
  name: string;
  infoHash: string;
  size: number;
  seeders: number;
  leechers: number;
  source: string;
  seasonPack?: boolean;
  fileIdx?: number;
  languages?: string[];
  hasSubs?: boolean;
  subLanguages?: string[];
  multiAudio?: boolean;
  foreignOnly?: boolean;
}

export default function searchRoutes(app: Express, ctx: ServerContext): void {
  const { log, DOWNLOAD_PATH, availabilityCache, AVAIL_TTL } = ctx;
  // Access ctx.client via getter (not destructured) so deferred init is visible
  const client = () => ctx.client;

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker.bittor.pw:1337/announce",
  "udp://public.popcorn-tracker.org:6969/announce",
  "udp://tracker.dler.org:6969/announce",
  "udp://exodus.desync.com:6969",
  "udp://open.demonii.com:1337/announce",
];

async function searchTPB(query: string): Promise<SearchResult[]> {
  const url = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Leba/2.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await resp.json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
}

async function searchEZTV(query: string, imdbId: string | undefined): Promise<SearchResult[]> {
  if (!imdbId) return [];
  // EZTV API requires IMDB ID (numeric part only)
  const numericId = imdbId.replace(/\D/g, "");
  if (!numericId) return [];
  try {
    const results: SearchResult[] = [];
    // Fetch up to 3 pages to get good coverage
    for (let page = 1; page <= 3; page++) {
      const url = `https://eztvx.to/api/get-torrents?imdb_id=${numericId}&limit=100&page=${page}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Leba/2.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await resp.json();
      if (!data.torrents || data.torrents.length === 0) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    // Filter by query terms (to match specific episode)
    const terms = query.toLowerCase().split(/\s+/);
    return results.filter((r) => {
      const name = r.name.toLowerCase();
      return terms.every((term) => name.includes(term));
    });
  } catch {
    return [];
  }
}

async function searchYTS(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=20&sort_by=seeds`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Leba/2.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await resp.json();
    if (!data.data?.movies) return [];
    const results: SearchResult[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const movie of data.data.movies as any[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
}

// ── 1337x ───────────────────────────────────────────────────────
async function search1337x(query: string): Promise<SearchResult[]> {
  try {
    // 1337x has a search page — scrape torrent names and magnet links
    const url = `https://1337x.to/search/${encodeURIComponent(query)}/1/`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // Extract torrent rows
    const rowMatches = html.match(/<td class="coll-1 name".*?<\/td>.*?<\/tr>/gs) || [];
    for (const row of rowMatches.slice(0, 30)) {
      // Name
      const nameMatch = row.match(/>([^<]+)<\/a>\s*<\/td>/);
      if (!nameMatch) continue;
      const name = nameMatch[1].replace(/<[^>]+>/g, "").trim();
      if (name.length < 3) continue;

      // Magnet/hash from link
      const linkMatch = row.match(/href="\/torrent\/(\d+)\//);
      if (!linkMatch) continue;

      // Seeders
      const seedMatch = row.match(/<td class="[\s\w]*seeds">(\d+)<\/td>/);
      const seeders = seedMatch ? parseInt(seedMatch[1], 10) : 0;

      // Leechers
      const leechMatch = row.match(/<td class="[\s\w]*leeches">(\d+)<\/td>/);
      const leechers = leechMatch ? parseInt(leechMatch[1], 10) : 0;

      // Size
      const sizeMatch = row.match(/([\d.]+\s*(?:TB|GB|MB))/i);
      const size = sizeMatch ? parseSize(sizeMatch[1]) : 0;

      // We can't get the hash from search page — need to visit torrent page
      // For now, use the URL as a unique ID and let downstream dedup handle it
      results.push({
        name,
        infoHash: `1337x:${linkMatch[1]}`, // Temporary — real hash fetched below
        size,
        seeders,
        leechers,
        source: "1337x",
      });
    }

    // Fetch real hashes for top results (batch)
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
}

// ── TorrentGalaxy ───────────────────────────────────────────────
async function searchTorrentGalaxy(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://torrentgalaxy.to/torrents.php?search=${encodeURIComponent(query)}&nox=2`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // TorrentGalaxy embeds JSON in the page
    const jsonMatch = html.match(/var results\s*=\s*(\[.*?\]);/s);
    if (jsonMatch) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      } catch { /* fallback to HTML parsing */ }
    }

    // Fallback: parse HTML table
    if (results.length === 0) {
      const rowRegex = /<a href="\/torrent\/(\d+)\//g;
      let match;
      while ((match = rowRegex.exec(html)) !== null && results.length < 30) {
        const id = match[1];
        // Get surrounding context
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
}

// ── BTDigg (DHT search engine) ─────────────────────────────────
async function searchBTDigg(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://btdig.com/search?q=${encodeURIComponent(query)}&p=0&order=0`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // BTDigg has a very regular structure
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

      results.push({
        name,
        infoHash,
        size,
        seeders: 0, // BTDigg doesn't expose seeders
        leechers: 0,
        source: "btdigg",
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ── Bitsearch ──────────────────────────────────────────────────
async function searchBitsearch(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://bitsearch.to/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // Bitsearch renders results in a structured list
    const itemRegex = /<a href="\/torrent\/([^"]+)"[^>]*>(.*?)<\/a>/gs;
    let itemMatch;
    while ((itemMatch = itemRegex.exec(html)) !== null && results.length < 20) {
      const id = itemMatch[1];
      const htmlContent = itemMatch[2];
      const nameMatch = htmlContent.match(/title="([^"]{5,})"/);
      if (!nameMatch) continue;

      // Get size from nearby context
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
}

// ── BT4G ──────────────────────────────────────────────────────
async function searchBT4G(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://bt4g.org/search/${encodeURIComponent(query)}/1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // BT4G has clean result cards
    const detailRegex = /<a href="\/torrent\/([a-f0-9]{40})"[^>]*title="([^"]{5,})"/gi;
    let match;
    while ((match = detailRegex.exec(html)) !== null && results.length < 20) {
      const infoHash = match[1].toLowerCase();
      const name = match[2].trim();

      // Size from nearby text
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
}

// ── LimeTorrents ──────────────────────────────────────────────
async function searchLimeTorrents(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://www.limetorrents.lol/search/all/${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // LimeTorrents has a regular table structure
    const rowRegex = /<tr>.*?<td class="tdleft".*?<a[^>]+href="([^"]+)"[^>]*title="([^"]{5,})"[^>]*>.*?<\/tr>/gs;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(html)) !== null && results.length < 20) {
      const link = rowMatch[1];
      const name = rowMatch[2].trim();

      // Extract hash from URL
      const hashMatch = link.match(/\/([a-f0-9]{40})\.html/i);
      const infoHash = hashMatch ? hashMatch[1].toLowerCase() : "";
      if (!infoHash) continue;

      // Size from nearby context
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
}

// ── Nyaa (Anime only) ─────────────────────────────────────────
async function searchNyaa(query: string): Promise<SearchResult[]> {
  try {
    const url = `https://nyaa.si/?f=0&c=0_0&q=${encodeURIComponent(query)}&p=0&s=seeders&o=desc`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return [];
    const html = await resp.text();

    const results: SearchResult[] = [];

    // Nyaa has a clean table
    const rowRegex = /<tr[^>]*>\s*<td[^>]*>(\d+)<\/td>.*?<a href="\/view\/(\d+)"[^>]*title="([^"]{5,})"[^>]*>.*?<\/tr>/gs;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(html)) !== null && results.length < 20) {
      const seeders = parseInt(rowMatch[1], 10) || 0;
      const name = rowMatch[3].trim();

      // Get size from nearby context
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

    // Fetch real hashes for nyaa entries (batch)
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
}

/**
 * Parse a human-readable size string like "1.5 GB" into bytes.
 */
function parseSize(str: string): number {
  const match = str.trim().match(/^([\d.]+)\s*(TB|GB|MB|KB)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = { TB: 1099511627776, GB: 1073741824, MB: 1048576, KB: 1024 };
  return Math.round(num * (multipliers[unit] || 1));
}

async function searchTorrents(query: string, imdbId?: string): Promise<SearchResult[]> {
  const [tpb, eztv, yts, x1337, tgx, btdigg, bitsearch, bt4g, lime, nyaa] = await Promise.allSettled([
    searchTPB(query),
    searchEZTV(query, imdbId),
    searchYTS(query),
    search1337x(query),
    searchTorrentGalaxy(query),
    searchBTDigg(query),
    searchBitsearch(query),
    searchBT4G(query),
    searchLimeTorrents(query),
    searchNyaa(query),
  ]);

  const all: SearchResult[] = [
    ...(tpb.status === "fulfilled" ? tpb.value : []),
    ...(eztv.status === "fulfilled" ? eztv.value : []),
    ...(yts.status === "fulfilled" ? yts.value : []),
    ...(x1337.status === "fulfilled" ? x1337.value : []),
    ...(tgx.status === "fulfilled" ? tgx.value : []),
    ...(btdigg.status === "fulfilled" ? btdigg.value : []),
    ...(bitsearch.status === "fulfilled" ? bitsearch.value : []),
    ...(bt4g.status === "fulfilled" ? bt4g.value : []),
    ...(lime.status === "fulfilled" ? lime.value : []),
    ...(nyaa.status === "fulfilled" ? nyaa.value : []),
  ];

  // Dedupe by infoHash, keep the one with more seeders
  const seen = new Map<string, SearchResult>();
  for (const r of all) {
    if (!r.infoHash) continue;
    const existing = seen.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) {
      seen.set(r.infoHash, r);
    }
  }

  const merged = [...seen.values()];
  log("info", "Multi-provider search", {
    query,
    tpb: tpb.status === "fulfilled" ? tpb.value.length : 0,
    eztv: eztv.status === "fulfilled" ? eztv.value.length : 0,
    yts: yts.status === "fulfilled" ? yts.value.length : 0,
    "1337x": x1337.status === "fulfilled" ? x1337.value.length : 0,
    tgx: tgx.status === "fulfilled" ? tgx.value.length : 0,
    btdigg: btdigg.status === "fulfilled" ? btdigg.value.length : 0,
    bitsearch: bitsearch.status === "fulfilled" ? bitsearch.value.length : 0,
    bt4g: bt4g.status === "fulfilled" ? bt4g.value.length : 0,
    lime: lime.status === "fulfilled" ? lime.value.length : 0,
    nyaa: nyaa.status === "fulfilled" ? nyaa.value.length : 0,
    merged: merged.length,
  });

  return merged;
}


// ---- Availability Check ----

async function checkOneAvailability(title: string, year: string | number | undefined, type: string): Promise<boolean> {
  const cacheKey = `${title.toLowerCase()}:${year || ""}`;
  const cached = availabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AVAIL_TTL) return cached.available;

  const query = year ? `${title} ${year}` : title;
  try {
    const results = await searchTorrents(query);
    const hasMatch = results.some((r) => scoreTorrent(r, title, year as number | undefined, type) > 0);
    availabilityCache.set(cacheKey, { available: hasMatch, ts: Date.now() });
    return hasMatch;
  } catch {
    return false;
  }
}

async function runPool<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = [];
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

app.post("/api/check-availability", async (req: Request, res: Response) => {
  const { items } = req.body as { items?: Array<{ id: number; title: string; year?: string; type?: string }> };
  if (!Array.isArray(items) || items.length === 0) return res.json({ available: [] });

  const capped = items.slice(0, 40);
  const tasks = capped.map((item) => () =>
    checkOneAvailability(item.title, item.year, item.type || "movie").then((ok) => ok ? item.id : null)
  );

  try {
    const results = await runPool(tasks, 6);
    const available = results.filter(Boolean);
    log("info", "Availability check", { requested: capped.length, available: available.length });
    res.json({ available });
  } catch (err) {
    log("err", "Availability check failed", { error: (err as Error).message });
    res.json({ available: capped.map((i) => i.id) }); // fail open — show everything
  }
});


async function searchTV(title: string, season: number, episode: number, imdbId?: string): Promise<SearchResult[]> {
  // Primary: try Torrentio (requires IMDB ID)
  if (imdbId) {
    try {
      const torrentioResults = await searchTorrentio(imdbId, "tv", season, episode);
      if (torrentioResults.length > 0) {
        log("info", "Torrentio search succeeded", { title, season, episode, results: torrentioResults.length });
        return torrentioResults;
      }
    } catch (err) {
      log("warn", "Torrentio search failed, falling back", { error: (err as Error).message });
    }
  }

  // Fallback: existing multi-provider search
  log("info", "Using fallback search", { title, season, episode });
  const s = String(season).padStart(2, "0");
  const e = String(episode).padStart(2, "0");
  const episodeQuery = `${title} S${s}E${e}`;
  const seasonQuery = `${title} S${s}`;
  const titleQuery = title;

  const [episodeResults, seasonResults, titleResults] = await Promise.all([
    searchTorrents(episodeQuery, imdbId),
    searchTorrents(seasonQuery, imdbId),
    searchTorrents(titleQuery, imdbId),
  ]);

  const filteredTitleResults = titleResults.filter((r) => coversTargetSeason(r.name, season));

  const seen = new Map<string, SearchResult>();
  for (const r of [...episodeResults, ...seasonResults, ...filteredTitleResults]) {
    if (!r.infoHash) continue;
    if (hasWrongEpisode(r.name, season, episode)) continue;

    const existing = seen.get(r.infoHash);
    if (!existing || r.seeders > existing.seeders) {
      const sPad = String(Math.abs(season)).padStart(2, "0");
      const ePad = String(Math.abs(episode)).padStart(2, "0");
      const hasEp = new RegExp(`S${sPad}E${ePad}(?!\\d)`, "i").test(r.name)
        || new RegExp(`S${Math.abs(season)}E${Math.abs(episode)}(?!\\d)`, "i").test(r.name);
      const hasSsn = new RegExp(`S${s}(?!\\d)`, "i").test(r.name)
        || /complete|full.season|season.\d|all.seasons/i.test(r.name)
        || coversTargetSeason(r.name, season);
      const isSeasonPack = !hasEp && hasSsn;
      seen.set(r.infoHash, { ...r, seasonPack: isSeasonPack });
    }
  }
  return [...seen.values()];
}

// Return scored torrent options for user selection
app.post("/api/search-streams", async (req: Request, res: Response) => {
  const { title, year, type, season, episode, imdbId } = req.body as {
    title: string; year?: number; type?: string; season?: number; episode?: number; imdbId?: string;
  };
  if (!title) return res.status(400).json({ error: "Title is required" });

  let results: SearchResult[];
  if (type === "tv" && season && episode) {
    results = await searchTV(title, season, episode, imdbId);
  } else {
    // Primary: try Torrentio for movies
    if (imdbId) {
      try {
        const torrentioResults = await searchTorrentio(imdbId, "movie");
        if (torrentioResults.length > 0) {
          log("info", "Torrentio movie search succeeded", { title, results: torrentioResults.length });
          results = torrentioResults;
        } else {
          const query = year ? `${title} ${year}` : title;
          results = await searchTorrents(query, imdbId);
        }
      } catch {
        const query = year ? `${title} ${year}` : title;
        results = await searchTorrents(query, imdbId);
      }
    } else {
      const query = year ? `${title} ${year}` : title;
      results = await searchTorrents(query, imdbId);
    }
  }

  try {
    // Deduplicate by infoHash (keep the one with more seeders)
    const deduped = new Map<string, SearchResult>();
    for (const r of results) {
      const key = r.infoHash;
      const existing = deduped.get(key);
      if (!existing || r.seeders > existing.seeders) {
        deduped.set(key, r);
      }
    }

    const scored = [...deduped.values()]
      .map((r) => {
        const tags = parseTags(r.name);
        return {
          name: r.name,
          infoHash: r.infoHash,
          seeders: r.seeders,
          leechers: r.leechers,
          size: r.size,
          source: r.source,
          score: scoreTorrent(r, title, year, type || "movie"),
          tags,
          seasonPack: r.seasonPack || false,
          fileIdx: r.fileIdx,
          languages: r.languages || [],
          hasSubs: r.hasSubs || false,
          subLanguages: r.subLanguages || [],
          multiAudio: r.multiAudio || false,
          foreignOnly: r.foreignOnly || false,
        };
      })
      .filter((r) => r.score > 0)
      // Drop 4K/2160p+ — larger files, slower buffering, no benefit over 1080p
      .filter((r) => !/2160p|4k/i.test(r.name))
      .sort((a, b) => b.score - a.score || b.seeders - a.seeders);

    // Promote the best 1080p torrent to position 0
    const best1080 = scored.find((r) => /1080p/i.test(r.name));
    if (best1080) {
      const topIdx = scored.indexOf(best1080);
      if (topIdx > 0) {
        scored.splice(topIdx, 1);
        scored.unshift(best1080);
      }
    }

    const final = scored.slice(0, 50);

    // Check debrid cache availability if configured
    const debrid = getDebridProvider();
    if (debrid && final.length > 0) {
      try {
        const hashes = final.map((r) => r.infoHash);
        const cached = await debrid.checkCached(hashes);
        for (const r of final) {
          if (cached.get(r.infoHash.toLowerCase())) {
            (r as typeof r & { cached?: boolean }).cached = true;
          }
        }
      } catch (err) {
        log("warn", "Debrid cache check failed", { error: (err as Error).message });
      }
    }

    res.json({ results: final });
  } catch (err) {
    log("err", "Search streams failed", { error: (err as Error).message });
    res.json({ results: [] });
  }
});

// Resolve metadata for a list of infoHashes to determine file formats
app.post("/api/resolve-formats", async (req: Request, res: Response) => {
  const { infoHashes } = req.body as { infoHashes: string[] };
  if (!infoHashes || !Array.isArray(infoHashes)) {
    return res.status(400).json({ error: "infoHashes array required" });
  }

  const results: Record<string, { files: string[]; numPeers: number }> = {};

  await Promise.all(infoHashes.map((hash) => {
    return new Promise<void>((resolve) => {
      // Already loaded?
      const existing = client().torrents.find((t) => t.infoHash === hash);
      if (existing && existing.files.length > 0) {
        const files = existing.files.map((f) => f.name);
        results[hash] = { files, numPeers: existing.numPeers };
        resolve();
        return;
      }

      // Resolve metadata (just file list, deselect all files to avoid downloading)
      const magnet = `magnet:?xt=urn:btih:${hash}&tr=${TRACKERS.map(encodeURIComponent).join("&tr=")}`;
      const timeout = setTimeout(() => {
        // Timed out — remove if we added it just for metadata
        if (!existing) {
          const t = client().torrents.find((t) => t.infoHash === hash);
          if (t) try { t.destroy({ destroyStore: true }); } catch {}
        }
        resolve();
      }, 8000);

      try {
        const t = client().add(magnet, { path: DOWNLOAD_PATH, deselect: true });
        t.on("ready", () => {
          clearTimeout(timeout);
          const files = t.files.map((f) => f.name);
          results[hash] = { files, numPeers: t.numPeers };
          // Don't destroy — keep for potential playback
          t.files.forEach((f) => { try { f.deselect(); } catch {} });
          resolve();
        });
        t.on("error", () => { clearTimeout(timeout); resolve(); });
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }));

  res.json(results);
});

// Lightweight endpoint to poll live peer counts for loaded torrents
app.post("/api/live-peers", (req: Request, res: Response) => {
  const { infoHashes } = req.body as { infoHashes: string[] };
  if (!infoHashes || !Array.isArray(infoHashes)) {
    return res.status(400).json({ error: "infoHashes array required" });
  }
  const results: Record<string, { numPeers: number; downloadSpeed: number }> = {};
  for (const hash of infoHashes) {
    const t = client().torrents.find((t) => t.infoHash === hash);
    if (t) {
      results[hash] = { numPeers: t.numPeers, downloadSpeed: t.downloadSpeed };
    }
  }
  res.json(results);
});

interface TorrentPlayResult {
  infoHash: string;
  fileIndex: number;
  fileName: string;
  torrentName: string;
  totalSize: number;
  tags: string[];
  debridStreamKey?: string;
}

function respondWithTorrent(torrent: Torrent, season: number | undefined, episode: number | undefined, tags: string[], preferredFileIdx?: number): TorrentPlayResult | null {
  let videoFile: { file: { name: string; length: number }; index: number } | null = null;

  // If we have a preferred fileIdx from Torrentio, use it directly
  if (preferredFileIdx !== undefined && preferredFileIdx >= 0 && preferredFileIdx < torrent.files.length) {
    const f = torrent.files[preferredFileIdx];
    videoFile = { file: { name: f.name, length: f.length }, index: preferredFileIdx };
  } else if (season && episode) {
    videoFile = findEpisodeFile(torrent, season, episode);
  } else {
    videoFile = findLargestVideo(torrent);
  }

  if (!videoFile) return null;
  (torrent.files[videoFile.index] as { select(): void }).select();
  return {
    infoHash: torrent.infoHash,
    fileIndex: videoFile.index,
    fileName: videoFile.file.name,
    torrentName: torrent.name,
    totalSize: torrent.length,
    tags,
  };
}

app.post("/api/auto-play", async (req: Request, res: Response) => {
  const { title, year, type, season, episode, imdbId } = req.body as {
    title: string; year?: number; type?: string; season?: number; episode?: number; imdbId?: string;
  };
  if (!title) return res.status(400).json({ error: "Title is required" });

  let results: SearchResult[];
  if (type === "tv" && season && episode) {
    log("info", "Auto-play search (TV)", { title, season, episode });
    results = await searchTV(title, season, episode, imdbId);
  } else {
    if (imdbId) {
      try {
        const torrentioResults = await searchTorrentio(imdbId, "movie");
        if (torrentioResults.length > 0) {
          log("info", "Auto-play Torrentio succeeded", { title, results: torrentioResults.length });
          results = torrentioResults;
        } else {
          const query = year ? `${title} ${year}` : title;
          log("info", "Auto-play search", { query });
          results = await searchTorrents(query, imdbId);
        }
      } catch {
        const query = year ? `${title} ${year}` : title;
        log("info", "Auto-play fallback search", { query });
        results = await searchTorrents(query, imdbId);
      }
    } else {
      const query = year ? `${title} ${year}` : title;
      log("info", "Auto-play search", { query });
      results = await searchTorrents(query, imdbId);
    }
  }

  try {
    if (results.length === 0) {
      log("info", "Auto-play: no results");
      return res.status(404).json({ error: "not_found" });
    }

    const scored = results
      .map((r) => ({ ...r, score: scoreTorrent(r, title, year, type || "movie") }))
      .filter((r) => r.score > 0)
      // Drop 4K/2160p+ — larger files, slower buffering, no benefit over 1080p
      .filter((r) => !/2160p|4k/i.test(r.name))
      .sort((a, b) => b.score - a.score || b.seeders - a.seeders);

    if (scored.length === 0) {
      log("info", "Auto-play: no quality matches", { total: results.length });
      return res.status(404).json({ error: "not_found" });
    }

    // Promote best 1080p to position 0
    const best1080 = scored.find((r) => /1080p/i.test(r.name));
    if (best1080) {
      const topIdx = scored.indexOf(best1080);
      if (topIdx > 0) {
        scored.splice(topIdx, 1);
        scored.unshift(best1080);
        log("info", "Auto-play: promoted 1080p candidate", { name: best1080.name, score: best1080.score });
      }
    }

    // Try debrid — loop through top candidates until one works
    const debrid = getDebridProvider();
    const debridOn = debrid && getDebridMode() === "on";
    if (debridOn) {
      const candidates = scored.slice(0, 5);
      for (const candidate of candidates) {
        const tags = parseTags(candidate.name);
        const trackerParams = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
        const magnet = `magnet:?xt=urn:btih:${candidate.infoHash}&dn=${encodeURIComponent(candidate.name)}${trackerParams}`;
        try {
          log("info", "Auto-play selected", { name: candidate.name, score: candidate.score, seeders: candidate.seeders });
          const stream = await debrid.unrestrict(magnet, candidate.fileIdx);
          log("info", "Auto-play via debrid", { name: candidate.name, filename: stream.filename });
          const debridStreamKey = setActiveDebridStream(candidate.infoHash, stream.url, stream.files);
          return res.json({
            infoHash: candidate.infoHash, fileIndex: stream.fileIndex, fileName: stream.filename,
            torrentName: candidate.name, totalSize: stream.filesize, tags, debridStreamKey,
          } satisfies TorrentPlayResult);
        } catch (err) {
          log("warn", "Debrid failed for candidate, trying next", { name: candidate.name, error: (err as Error).message });
        }
      }
      log("err", "Debrid failed for all candidates", {});
      return res.status(502).json({ error: "debrid_failed" });
    }

    const best = scored[0];
    log("info", "Auto-play selected", { name: best.name, score: best.score, seeders: best.seeders, source: best.source });
    const tags = parseTags(best.name);
    const trackerParams = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
    const magnet = `magnet:?xt=urn:btih:${best.infoHash}&dn=${encodeURIComponent(best.name)}${trackerParams}`;

    // Reuse existing torrent if already in client
    const existing = client().torrents.find(
      (t) => t.infoHash === best.infoHash || t.infoHash === best.infoHash.toLowerCase()
    );

    const autoSeason = type === "tv" ? season : undefined;
    const autoEpisode = type === "tv" ? episode : undefined;

    if (existing) {
      // Already ready with files — return immediately
      if (existing.files && existing.files.length > 0) {
        const result = respondWithTorrent(existing, autoSeason, autoEpisode, tags);
        if (result) return res.json(result);
        // Torrent is ready but no matching video — don't wait for "ready" (it already fired)
        log("info", "Existing torrent has no matching video, retrying fresh", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      } else {
        // Still loading metadata — wait for ready
        log("info", "Waiting for existing torrent metadata", { infoHash: existing.infoHash });
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
            existing.on("ready", () => { clearTimeout(timeout); resolve(); });
            existing.on("error", (err) => { clearTimeout(timeout); reject(err); });
          });
          const result = respondWithTorrent(existing, autoSeason, autoEpisode, tags);
          if (result) return res.json(result);
        } catch {}
        // If still no good, remove the stuck torrent and try fresh
        log("info", "Removing stuck torrent, retrying", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      }
    }

    await new Promise<TorrentPlayResult>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for metadata")), 30000);
      let torrent: Torrent;
      try {
        torrent = client().add(magnet, { path: DOWNLOAD_PATH, deselect: true });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      torrent.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      torrent.on("ready", () => {
        clearTimeout(timeout);

        torrent.on("download", throttle(() => {
          log("info", "Progress", {
            name: torrent.name,
            progress: (torrent.progress * 100).toFixed(1) + "%",
            down: fmtBytes(torrent.downloadSpeed) + "/s",
            peers: torrent.numPeers,
          });
        }, 10000));

        torrent.on("done", () => {
          log("info", "Download complete", { name: torrent.name });
          torrent.pause();
        });

        torrent.on("error", (err) => log("err", "Torrent error", { error: (err as Error).message }));

        const result = respondWithTorrent(torrent, autoSeason, autoEpisode, tags);
        if (!result) {
          reject(new Error("No video files found in torrent"));
          return;
        }

        resolve(result);
      });
    }).then((data) => {
      if (!res.headersSent) res.json(data);
    }).catch((err) => {
      log("err", "Auto-play torrent failed", { error: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
    });
  } catch (err) {
    log("err", "Auto-play failed", { error: (err as Error).message });
    if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
  }
});

// Play a specific torrent by infoHash (user-selected from search-streams)
app.post("/api/play-torrent", async (req: Request, res: Response) => {
  const { infoHash, name, season, episode, fileIdx } = req.body as {
    infoHash: string; name?: string; season?: number; episode?: number; fileIdx?: number;
  };
  if (!infoHash) return res.status(400).json({ error: "infoHash is required" });

  const tags = parseTags(name || "");
  const trackerParams = TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join("");
  const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || "")}${trackerParams}`;

  // Try debrid if enabled — no WebTorrent fallback
  const debrid = getDebridProvider();
  const debridOn = debrid && getDebridMode() === "on";
  if (debridOn) {
    try {
      const stream = await debrid.unrestrict(magnet, fileIdx);
      log("info", "Play-torrent via debrid", { infoHash, filename: stream.filename });
      const debridStreamKey = setActiveDebridStream(infoHash, stream.url, stream.files);
      return res.json({
        infoHash,
        fileIndex: stream.fileIndex,
        fileName: stream.filename,
        torrentName: name || stream.filename,
        totalSize: stream.filesize,
        tags,
        debridStreamKey,
      } satisfies TorrentPlayResult);
    } catch (err) {
      log("err", "Debrid failed", { infoHash, error: (err as Error).message });
      return res.status(502).json({ error: "debrid_failed" });
    }
  }

  const existing = client().torrents.find(
    (t) => t.infoHash === infoHash || t.infoHash === infoHash.toLowerCase()
  );

  try {
    if (existing) {
      if (existing.files && existing.files.length > 0) {
        const result = respondWithTorrent(existing, season, episode, tags, fileIdx);
        if (result) return res.json(result);
        // Torrent is ready but no matching video — don't wait for "ready" (it already fired)
        log("info", "Existing torrent has no matching video, retrying fresh", { infoHash: existing.infoHash });
        try { existing.destroy({ destroyStore: false }); } catch {}
      } else {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
          existing.on("ready", () => { clearTimeout(timeout); resolve(); });
          existing.on("error", (err) => { clearTimeout(timeout); reject(err); });
        });
        const result = respondWithTorrent(existing, season, episode, tags, fileIdx);
        if (result) return res.json(result);
        try { existing.destroy({ destroyStore: false }); } catch {}
      }
    }

    await new Promise<TorrentPlayResult>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out")), 30000);
      let torrent: Torrent;
      try {
        torrent = client().add(magnet, { path: DOWNLOAD_PATH, deselect: true });
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
        return;
      }
      torrent.on("error", (err) => { clearTimeout(timeout); reject(err); });
      torrent.on("ready", () => {
        clearTimeout(timeout);
        torrent.on("done", () => {
          torrent.pause();
        });
        torrent.on("error", (err) => log("err", "Torrent error", { error: (err as Error).message }));
        const result = respondWithTorrent(torrent, season, episode, tags, fileIdx);
        if (!result) { reject(new Error("No video files")); return; }
        resolve(result);
      });
    }).then((data) => {
      if (!res.headersSent) res.json(data);
    }).catch((err) => {
      log("err", "Play-torrent failed", { error: (err as Error).message });
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
    });
  } catch (err) {
    log("err", "Play-torrent failed", { error: (err as Error).message });
    if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
  }
});

function findLargestVideo(torrent: Torrent) {
  return findLargestVideoFile(torrent.files);
}

function findEpisodeFile(torrent: Torrent, season: number, episode: number) {
  return findEpisodeFileFromList(torrent.files, season, episode);
}

}
