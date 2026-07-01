import type { SeedItem } from "./types.js";

interface TMDBResult {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genres?: { id: number; name: string }[];
  keywords?: unknown;
  cast?: { id?: number; tmdbId?: number }[];
  runtime?: number | null;
  episode_run_time?: number[];
  media_type?: string;
}

const DISCOVER_PAGES = 3;

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function discoverCandidates(
  mediaType: "movie" | "tv",
  topGenres: number[],
  fetchTMDB: (path: string) => Promise<unknown>,
): Promise<TMDBResult[]> {
  const seen = new Set<number>();
  const results: TMDBResult[] = [];
  const params = new URLSearchParams();
  if (topGenres.length > 0) params.set("with_genres", topGenres.join("|"));
  params.set("sort_by", "vote_average.desc");
  params.set("vote_count.gte", "100");
  params.set("vote_average.gte", "5");

  for (let page = 1; page <= DISCOVER_PAGES; page++) {
    try {
      params.set("page", String(page));
      const data = await fetchTMDB(`/discover/${mediaType}?${params}`) as { results?: any[] };
      if (!data.results || data.results.length === 0) break;
      for (const item of data.results) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        item.media_type = mediaType;
        // Discover returns genre_ids (int[]) instead of genres ({id,name}[])
        if (!item.genres && item.genre_ids) {
          item.genres = item.genre_ids.map((id: number) => ({ id, name: "" }));
        }
        results.push(item);
      }
    } catch {
      break;
    }
  }

  return results;
}

export async function generateCandidates(
  seeds: SeedItem[],
  fetchTMDB: (path: string) => Promise<unknown>,
): Promise<{ candidates: TMDBResult[]; seedData: Map<number, Record<string, unknown>> }> {
  const seedData = new Map<number, Record<string, unknown>>();
  const seen = new Set<number>();
  const candidates: TMDBResult[] = [];

  for (const seed of seeds) {
    const type = seed.mediaType;
    try {
      const detail = await fetchTMDB(`/${type}/${seed.tmdbId}?append_to_response=credits,keywords`);
      seedData.set(seed.tmdbId, detail as Record<string, unknown>);

      const similar = await fetchTMDB(`/${type}/${seed.tmdbId}/similar`) as { results?: TMDBResult[] };
      const recs = await fetchTMDB(`/${type}/${seed.tmdbId}/recommendations`) as { results?: TMDBResult[] };

      for (const item of [...(similar.results || []), ...(recs.results || [])]) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          item.media_type = item.media_type || type;
          candidates.push(item);
        }
      }
    } catch {
      // skip seeds that fail to resolve
    }
  }

  return { candidates, seedData };
}
