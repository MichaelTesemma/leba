import type { Express, Request, Response } from "express";
import { tmdbCache, fetchTMDB } from "../lib/cache/cache.js";
import type { LogCtx, RatingsCtx } from "../lib/types.js";

const GENRE_NAMES: Record<number, string> = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
  80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
  14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV",
  53: "Thriller", 10752: "War", 37: "Western",
};

const GENRE_NAMES_TV: Record<number, string> = {
  10759: "Action/Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
  99: "Documentary", 18: "Drama", 10751: "Family", 10762: "Kids",
  9648: "Mystery", 10763: "News", 10764: "Reality", 10765: "Sci-Fi/Fantasy",
  10766: "Soap", 10767: "Talk", 10768: "War/Politics", 37: "Western",
};

const ALL_GENRE_NAMES = { ...GENRE_NAMES, ...GENRE_NAMES_TV };

const GENRE_CACHE_TTL = 86_400_000; // 24 hours

export default function profileRoutes(app: Express, ctx: LogCtx & RatingsCtx): void {
  const { log, ratings } = ctx;

  app.get("/api/profile", async (_req: Request, res: Response) => {
    const allRatings = ratings.getAll();
    if (allRatings.length === 0) {
      return res.json({ totalRatings: 0, genres: [], keywords: [], directors: [], actors: [], decades: [], distribution: [], ratings: [] });
    }

    // Fetch genre names from TMDB for label mapping
    let genreMap: Record<number, string>;
    try {
      const cachedGenres = tmdbCache.get("profile:genreNames") as Record<number, string> | undefined;
      if (cachedGenres) {
        genreMap = cachedGenres;
      } else {
        const [movieGenres, tvGenres] = await Promise.all([
          fetchTMDB("/genre/movie/list").catch(() => ({ genres: [] })),
          fetchTMDB("/genre/tv/list").catch(() => ({ genres: [] })),
        ]);
        genreMap = { ...ALL_GENRE_NAMES };
        for (const g of (movieGenres as any)?.genres || []) genreMap[g.id] = g.name;
        for (const g of (tvGenres as any)?.genres || []) genreMap[g.id] = g.name;
        tmdbCache.set("profile:genreNames", genreMap, GENRE_CACHE_TTL);
      }
    } catch {
      genreMap = ALL_GENRE_NAMES;
    }

    // Build genre weights from ratings
    const genreWeights: Record<number, number> = {};
    const keywordVec: Record<number, number> = {};
    const keywordNames: Record<number, string> = {};
    const decadeCounts: Record<number, number> = {};
    const distribution = [0, 0, 0, 0, 0];
    const dirScores: Record<number, { name: string; weight: number }> = {};
    const actorScores: Record<number, { name: string; weight: number }> = {};

    // Fetch detail for each rated item to get genres/keywords/cast
    const PROFILE_TTL = 3_600_000; // 1 hour
    for (const r of allRatings) {
      const cacheKey = `profile:detail:${r.mediaType}:${r.tmdbId}`;
      let detail = tmdbCache.get(cacheKey) as Record<string, any> | undefined;
      if (!detail) {
        try {
          detail = await fetchTMDB(`/${r.mediaType}/${r.tmdbId}?append_to_response=credits,keywords`) as Record<string, any>;
          tmdbCache.set(cacheKey, detail, PROFILE_TTL);
        } catch {
          continue;
        }
      }

      const w = r.value;
      distribution[r.value - 1] = (distribution[r.value - 1] ?? 0) + 1;

      const gIds: number[] = (detail.genres || []).map((g: any) => g.id);
      for (const id of gIds) {
        genreWeights[id] = (genreWeights[id] ?? 0) + w;
      }

      const kwItems: { id: number; name: string }[] = detail.keywords?.keywords || detail.keywords?.results || [];
      for (const kw of kwItems) {
        keywordVec[kw.id] = (keywordVec[kw.id] ?? 0) + w;
        if (!keywordNames[kw.id]) keywordNames[kw.id] = kw.name;
      }

      const year = detail.release_date || detail.first_air_date
        ? new Date(detail.release_date || detail.first_air_date).getFullYear()
        : 2000;
      const decade = Math.floor(year / 10) * 10;
      decadeCounts[decade] = (decadeCounts[decade] ?? 0) + 1;

      const credits = detail.credits as any;
      if (credits) {
        for (const c of (credits.crew || []).filter((m: any) => m.job === "Director")) {
          const map = dirScores;
          if (!map[c.id]) map[c.id] = { name: c.name, weight: 0 };
          map[c.id].weight += w;
        }
        for (const c of (credits.cast || []).slice(0, 10)) {
          const map = actorScores;
          if (!map[c.id]) map[c.id] = { name: c.name, weight: 0 };
          map[c.id].weight += w;
        }
      }
    }

    const genres = Object.entries(genreWeights)
      .map(([id, weight]) => ({ id: Number(id), name: genreMap[Number(id)] ?? `Genre ${id}`, weight }))
      .sort((a, b) => b.weight - a.weight);

    const keywords = Object.entries(keywordVec)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([id, weight]) => ({ id: Number(id), name: keywordNames[Number(id)] || `kw_${id}`, weight }));

    const directors = Object.entries(dirScores)
      .sort(([, a], [, b]) => b.weight - a.weight)
      .slice(0, 10)
      .map(([tmdbId, info]) => ({ tmdbId: Number(tmdbId), name: info.name, weight: info.weight }));

    const actors = Object.entries(actorScores)
      .sort(([, a], [, b]) => b.weight - a.weight)
      .slice(0, 10)
      .map(([tmdbId, info]) => ({ tmdbId: Number(tmdbId), name: info.name, weight: info.weight }));

    const decades = Object.entries(decadeCounts)
      .map(([d, count]) => ({ decade: Number(d), count }))
      .sort((a, b) => a.decade - b.decade);

    const ratedMovies = allRatings.map((r) => {
      const cached = tmdbCache.get(`profile:detail:${r.mediaType}:${r.tmdbId}`) as Record<string, any> | undefined;
      const movieYear = cached
        ? new Date(cached.release_date || cached.first_air_date || 0).getFullYear()
        : null;
      return {
        id: r.tmdbId,
        title: r.title,
        posterPath: r.posterPath,
        year: movieYear && movieYear > 1900 ? movieYear : null,
        mediaType: r.mediaType,
        value: r.value,
      };
    });

    res.json({
      totalRatings: allRatings.length,
      genres, keywords, directors, actors, decades, distribution,
      ratings: ratedMovies,
    });
  });
}
