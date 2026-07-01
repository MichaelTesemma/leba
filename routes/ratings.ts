import type { Express, Request, Response } from "express";
import { tmdbCache, fetchTMDB, CACHE_TTL } from "../lib/cache/cache.js";
import type { LogCtx, RatingsCtx } from "../lib/types.js";
import { buildProfile } from "../lib/recommendations/profile.js";
import { scoreCandidates } from "../lib/recommendations/scorer.js";
import { discoverCandidates } from "../lib/recommendations/candidates.js";
import type { CandidateInput } from "../lib/recommendations/scorer.js";
import type { SeedItem, ScoredCandidate } from "../lib/recommendations/types.js";

const skippedItems = new Map<string, number>();

const ONE_DAY = 86_400_000;

export let recsVersion = 0;

function getSkippedIds(mediaType: string): Set<number> {
  const skipped = new Set<number>();
  for (const [key, ts] of skippedItems) {
    if (key.startsWith(`${mediaType}:`) && Date.now() - ts < ONE_DAY) {
      const id = Number(key.split(":").pop());
      if (!isNaN(id)) skipped.add(id);
    }
  }
  return skipped;
}

export default function ratingRoutes(app: Express, ctx: LogCtx & RatingsCtx): void {
  const { log, ratings } = ctx;

  app.get("/api/ratings", (_req: Request, res: Response) => {
    res.json(ratings.getAll());
  });

  app.post("/api/ratings", (req: Request, res: Response) => {
    const { tmdbId, mediaType, title, posterPath, value } = req.body as {
      tmdbId: number; mediaType: "movie" | "tv"; title?: string; posterPath?: string | null; value: number;
    };
    if (!tmdbId || !mediaType || !value) {
      return res.status(400).json({ error: "tmdbId, mediaType, and value required" });
    }
    if (value < 1 || value > 5) {
      return res.status(400).json({ error: "value must be between 1 and 5" });
    }
    ratings.rate(tmdbId, mediaType, value, title || "Unknown", posterPath ?? null);
    skippedItems.delete(`${mediaType}:${tmdbId}`);
    recsVersion++;
    log("info", "Rating saved", { tmdbId, mediaType, value });
    res.json({ success: true });
  });

  app.post("/api/ratings/skip", (req: Request, res: Response) => {
    const { tmdbId, mediaType } = req.body as { tmdbId: number; mediaType: string };
    if (!tmdbId || !mediaType) {
      return res.status(400).json({ error: "tmdbId and mediaType required" });
    }
    skippedItems.set(`${mediaType}:${tmdbId}`, Date.now());
    res.json({ success: true });
  });

  app.get("/api/ratings/queue", async (_req: Request, res: Response) => {
    const ratedIds = ratings.getRatedIds();
    const allRatings = ratings.getAll();
    const skippedMovie = getSkippedIds("movie");
    const skippedTV = getSkippedIds("tv");
    const cacheKey = `ratings:queue:recs:v3:${recsVersion}`;
    const cached = tmdbCache.get(cacheKey) as Record<string, unknown>[] | undefined;
    if (cached) return res.json(cached);

    try {
      const seenSeedIds = new Set<number>();
      const ratingSeeds: SeedItem[] = [];
      for (const r of allRatings) {
        if (seenSeedIds.has(r.tmdbId)) continue;
        seenSeedIds.add(r.tmdbId);
        ratingSeeds.push({ tmdbId: r.tmdbId, mediaType: r.mediaType, weight: r.value });
      }
      ratingSeeds.sort((a, b) => b.weight - a.weight);
      const seeds = ratingSeeds.slice(0, 5);

      let scored: ScoredCandidate[];

      if (seeds.length === 0) {
        const [movies, tv] = await Promise.all([
          fetchTMDB("/trending/movie/week") as Promise<{ results?: any[] }>,
          fetchTMDB("/trending/tv/week") as Promise<{ results?: any[] }>,
        ]);
        const allTrending = [...(movies.results || []), ...(tv.results || [])].slice(0, 60);
        scored = allTrending
          .filter((item) => !ratedIds.has(item.id) && !skippedMovie.has(item.id) && !skippedTV.has(item.id))
          .map((item) => ({
            tmdbId: item.id,
            mediaType: item.media_type || "movie",
            title: item.title || item.name || "Unknown",
            posterPath: item.poster_path,
            year: parseInt((item.release_date || item.first_air_date || "").slice(0, 4)) || 0,
            genres: (item.genre_ids || []).map((id: number) => ({ id, name: "" })),
            voteAverage: item.vote_average || 0,
            matchScore: 0,
            signals: { genre: 0, keyword: 0, crew: 0, era: 0 },
          }));
      } else {
        // Fetch seed details and build profile
        const seedData = new Map<number, Record<string, unknown>>();
        for (const seed of seeds) {
          try {
            const detail = await fetchTMDB(`/${seed.mediaType}/${seed.tmdbId}?append_to_response=credits,keywords`) as Record<string, unknown>;
            seedData.set(seed.tmdbId, detail);
          } catch { /* skip */ }
        }

        const profile = buildProfile(seeds, seedData);
        const topGenres = Object.entries(profile.genreWeights)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 4)
          .map(([id]) => Number(id));

        if (topGenres.length > 0) {
          // Fetch discover candidates for both types
          const [movieCandidates, tvCandidates] = await Promise.all([
            discoverCandidates("movie", topGenres, fetchTMDB),
            discoverCandidates("tv", topGenres, fetchTMDB),
          ]);
          const allCandidates = [...movieCandidates, ...tvCandidates];
          if (allCandidates.length > 0) {
            scored = scoreCandidates(profile, allCandidates as unknown as CandidateInput[], seenSeedIds);
          } else {
            scored = [];
          }
        } else {
          scored = [];
        }
      }

      const result = scored
        .filter((s) => !ratedIds.has(s.tmdbId) && !skippedMovie.has(s.tmdbId) && !skippedTV.has(s.tmdbId))
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 50)
        .map((s) => ({
          id: s.tmdbId,
          media_type: s.mediaType,
          title: s.title,
          name: s.title,
          poster_path: s.posterPath,
          release_date: s.year ? `${s.year}-01-01` : null,
          first_air_date: s.year ? `${s.year}-01-01` : null,
          genres: s.genres,
          vote_average: s.voteAverage,
        }));

      tmdbCache.set(cacheKey, result, CACHE_TTL.DISCOVER);
      res.json(result);
    } catch (err) {
      log("err", "Failed to fetch rating queue", { error: (err as Error).message });
      res.json([]);
    }
  });
}
