import type { UserProfile, SeedItem } from "./types.js";
import { extractFeatureVector } from "./features.js";

export function buildProfile(
  seeds: SeedItem[],
  seedData: Map<number, Record<string, unknown>>,
): UserProfile {
  const genreWeights: Record<number, number> = {};
  const keywordVec: Record<number, number> = {};
  const crewScores: Record<number, number> = {};
  const favDecades = new Set<number>();

  for (const seed of seeds) {
    const item = seedData.get(seed.tmdbId);
    if (!item) continue;

    const vec = extractFeatureVector(item as Parameters<typeof extractFeatureVector>[0]);
    const w = seed.weight;

    for (const gId of vec.genres) {
      genreWeights[gId] = (genreWeights[gId] ?? 0) + w;
    }

    for (const kwId of vec.keywordIds) {
      keywordVec[kwId] = (keywordVec[kwId] ?? 0) + w;
    }

    for (const cId of vec.crewIds) {
      crewScores[cId] = (crewScores[cId] ?? 0) + w;
    }

    if (w > 0) favDecades.add(vec.decade);
  }

  return { genreWeights, keywordVec, crewScores, favDecades, totalSeeds: seeds.length };
}
