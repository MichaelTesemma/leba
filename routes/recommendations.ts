import type { Express, Request, Response } from "express";
import { tmdbCache, fetchTMDB } from "../lib/cache/cache.js";
import type { LogCtx, StorageCtx, RatingsCtx } from "../lib/types.js";
import { buildProfile } from "../lib/recommendations/profile.js";
import { scoreCandidates } from "../lib/recommendations/scorer.js";
import { discoverCandidates } from "../lib/recommendations/candidates.js";
import type { RecommendationResult, SeedItem, ScoredCandidate } from "../lib/recommendations/types.js";
import type { CandidateInput } from "../lib/recommendations/scorer.js";
import { recsVersion } from "./ratings.js";

const RECS_CACHE_TTL = 60 * 60 * 1000;
const DETAIL_TTL = 24 * 60 * 60 * 1000;
const MAX_SEEDS = 5;

interface TrendingResult {
  id: number;
  title?: string;
  name?: string;
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  genre_ids?: number[];
  media_type?: string;
}

async function fetchTrendingFallback(tmdbFetch: typeof fetchTMDB, mediaType: "movie" | "tv"): Promise<ScoredCandidate[]> {
  try {
    const data = await tmdbFetch(`/trending/${mediaType}/week`) as { results?: TrendingResult[] };
    return (data.results || []).slice(0, 20).map((item, i) => ({
      tmdbId: item.id,
      mediaType: item.media_type as "movie" | "tv" || mediaType,
      title: item.title || item.name || "Unknown",
      posterPath: item.poster_path,
      year: parseInt((item.release_date || item.first_air_date || "").slice(0, 4)) || 0,
      genres: [],
      voteAverage: item.vote_average || 0,
      matchScore: 0.5 - i * 0.01,
      signals: { genre: 0, keyword: 0, crew: 0, era: 0 },
    }));
  } catch {
    return [];
  }
}

function scToCandidateInput(items: ScoredCandidate[]): CandidateInput[] {
  return items.map((t) => ({
    id: t.tmdbId,
    media_type: t.mediaType,
    title: t.title,
    name: t.title,
    poster_path: t.posterPath,
    release_date: t.year ? `${t.year}-01-01` : undefined,
    first_air_date: t.year ? `${t.year}-01-01` : undefined,
    vote_average: t.voteAverage,
    genres: t.genres as { id: number; name: string }[],
  }));
}

function cachedFetchTMDB(path: string): ReturnType<typeof fetchTMDB> {
  const cached = tmdbCache.get(`rec:${path}`) as Record<string, unknown> | undefined;
  if (cached) return Promise.resolve(cached);
  return fetchTMDB(path).then((data) => {
    tmdbCache.set(`rec:${path}`, data as Record<string, unknown>, DETAIL_TTL);
    return data;
  });
}

export default function recommendationRoutes(app: Express, ctx: LogCtx & StorageCtx & RatingsCtx): void {
  const { log, watchHistory, savedList, ratings } = ctx;

  app.get("/api/recommendations", async (req: Request, res: Response) => {
    const mediaType = req.query.type === "tv" ? "tv" : "movie";
    const cacheKey = `recommendations:v3:${recsVersion}:${mediaType}`;
    const cached = tmdbCache.get(cacheKey) as RecommendationResult | undefined;
    if (cached) return res.json(cached);

    const allRatings = ratings.getAll();
    const recentlyWatched = watchHistory.getRecentlyWatched();
    const savedItems = savedList.getAll();

    // Build seeds from all sources
    const seeds: SeedItem[] = [];
    const seenSeedIds = new Set<number>();

    const ratingSeeds: SeedItem[] = [];
    for (const r of allRatings) {
      if (seenSeedIds.has(r.tmdbId)) continue;
      seenSeedIds.add(r.tmdbId);
      ratingSeeds.push({ tmdbId: r.tmdbId, mediaType: r.mediaType, weight: r.value });
    }
    ratingSeeds.sort((a, b) => b.weight - a.weight);
    for (const s of ratingSeeds.slice(0, MAX_SEEDS)) seeds.push(s);

    for (const r of recentlyWatched) {
      if (seenSeedIds.has(r.tmdbId)) continue;
      seenSeedIds.add(r.tmdbId);
      seeds.push({ tmdbId: r.tmdbId, mediaType: r.mediaType, weight: r.finished ? 4 : r.position / r.duration > 0.5 ? 3 : 2 });
    }

    for (const s of savedItems) {
      if (seenSeedIds.has(s.tmdbId)) continue;
      seenSeedIds.add(s.tmdbId);
      seeds.push({ tmdbId: s.tmdbId, mediaType: s.mediaType, weight: 4 });
    }

    const cappedSeeds = seeds.slice(0, MAX_SEEDS);

    let scored: ScoredCandidate[];

    if (cappedSeeds.length === 0) {
      scored = await fetchTrendingFallback(cachedFetchTMDB, mediaType);
      log("info", `No seeds, using ${mediaType} trending fallback`);
    } else {
      // Fetch seed details and build profile from ALL seeds
      const seedData = new Map<number, Record<string, unknown>>();
      for (const seed of cappedSeeds) {
        try {
          const detail = await cachedFetchTMDB(`/${seed.mediaType}/${seed.tmdbId}?append_to_response=credits,keywords`);
          seedData.set(seed.tmdbId, detail as Record<string, unknown>);
        } catch {
          // skip seeds that fail
        }
      }

      const profile = buildProfile(cappedSeeds, seedData);
      const topGenres = Object.entries(profile.genreWeights)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([id]) => Number(id));

      if (topGenres.length === 0) {
        // No genre signals — use trending scored against any available profile data
        log("warn", "No genre weight in profile, using trending fallback");
        const trending = await fetchTrendingFallback(cachedFetchTMDB, mediaType);
        if (trending.length > 0 && seedData.size > 0) {
          scored = scoreCandidates(profile, scToCandidateInput(trending), seenSeedIds);
        } else {
          scored = trending;
        }
      } else {
        const candidates = await discoverCandidates(mediaType, topGenres, cachedFetchTMDB);
        if (candidates.length === 0) {
          log("warn", `Discover returned no ${mediaType} candidates, using trending`);
          const trending = await fetchTrendingFallback(cachedFetchTMDB, mediaType);
          if (trending.length > 0 && seedData.size > 0) {
            scored = scoreCandidates(profile, scToCandidateInput(trending), seenSeedIds);
          } else {
            scored = trending;
          }
        } else {
          scored = scoreCandidates(profile, candidates as unknown as CandidateInput[], seenSeedIds);
          log("info", `Generated ${mediaType} recommendations from discover`, {
            seeds: cappedSeeds.length,
            topGenres: topGenres.join(","),
            candidates: candidates.length,
            results: scored.length,
          });
        }
      }
    }

    const result: RecommendationResult = {
      profile: { totalSeeds: cappedSeeds.length, topGenres: [] },
      recommendations: scored,
    };

    tmdbCache.set(cacheKey, result, RECS_CACHE_TTL);
    res.json(result);
  });
}
