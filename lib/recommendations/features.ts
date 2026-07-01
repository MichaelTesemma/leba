import type { FeatureVector } from "./types.js";

function normalizeKeywords(kw: unknown): { id: number }[] {
  if (Array.isArray(kw)) return kw;
  if (kw && typeof kw === "object") {
    const obj = kw as Record<string, unknown>;
    if (Array.isArray(obj.keywords)) return obj.keywords as { id: number }[];
    if (Array.isArray(obj.results)) return obj.results as { id: number }[];
  }
  return [];
}

export function extractFeatureVector(item: {
  genres?: { id: number }[];
  keywords?: unknown;
  cast?: { id?: number; tmdbId?: number }[];
  release_date?: string;
  first_air_date?: string;
  runtime?: number | null;
  episode_run_time?: number[];
}): FeatureVector {
  const dateStr = item.release_date || item.first_air_date;
  const year = dateStr ? new Date(dateStr).getFullYear() : 2000;

  const crewMemberIds = (item.cast || []).map((c) => c.tmdbId ?? c.id).filter((x): x is number => x != null);
  const uniqueCrew = [...new Set(crewMemberIds)];

  return {
    genres: (item.genres || []).map((g) => g.id).sort(),
    keywordIds: normalizeKeywords(item.keywords).map((k) => k.id).sort(),
    crewIds: uniqueCrew,
    decade: Math.floor(year / 10) * 10,
  };
}

export function jaccardSimilarity<T>(a: T[], b: T[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}
