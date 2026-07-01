import type { UserProfile, ScoredCandidate } from "./types.js";
import { extractFeatureVector, jaccardSimilarity } from "./features.js";

export interface CandidateInput {
  id: number;
  media_type?: string;
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
}

interface SignalWeights {
  genre: number;
  keyword: number;
  crew: number;
  era: number;
}

const NORMAL_WEIGHTS: SignalWeights = {
  genre: 0.30,
  keyword: 0.25,
  crew: 0.20,
  era: 0.10,
};

const COLD_START_WEIGHTS: SignalWeights = {
  genre: 0.60,
  keyword: 0.15,
  crew: 0.10,
  era: 0.05,
};

export function scoreCandidates(
  profile: UserProfile,
  candidates: CandidateInput[],
  seedIds: Set<number>,
): ScoredCandidate[] {
  const weights = profile.totalSeeds < 5 ? COLD_START_WEIGHTS : NORMAL_WEIGHTS;

  const seedFeatures = candidates
    .filter((c) => seedIds.has(c.id))
    .map(extractFeatureVector);

  return candidates
    .filter((c) => !seedIds.has(c.id))
    .map((candidate) => {
      const vec = extractFeatureVector(candidate);

      const genreScore = seedFeatures.length > 0
        ? seedFeatures.reduce((sum, sf) => sum + jaccardSimilarity(vec.genres, sf.genres), 0) / seedFeatures.length
        : profileGenreScore(profile, vec.genres);

      const keywordScore = keywordVecScore(profile, vec.keywordIds);

      const crewScore = seedFeatures.length > 0
        ? seedFeatures.reduce((sum, sf) => sum + jaccardSimilarity(vec.crewIds, sf.crewIds), 0) / seedFeatures.length
        : profileCrewScore(profile, vec.crewIds);

      const eraScore = profile.favDecades.has(vec.decade) ? 1 : 0;

      const signalSum = weights.genre + weights.keyword + weights.crew + weights.era;
      const total =
        (genreScore * weights.genre +
          keywordScore * weights.keyword +
          crewScore * weights.crew +
          eraScore * weights.era) / signalSum;

      return {
        tmdbId: candidate.id,
        mediaType: candidate.media_type === "tv" ? ("tv" as const) : ("movie" as const),
        title: candidate.title || candidate.name || "Unknown",
        posterPath: candidate.poster_path ?? null,
        year: candidate.release_date
          ? new Date(candidate.release_date).getFullYear()
          : candidate.first_air_date
            ? new Date(candidate.first_air_date).getFullYear()
            : 0,
        genres: (candidate.genres || []).map((g) => ({ id: g.id, name: g.name })),
        voteAverage: candidate.vote_average ?? 0,
        matchScore: Math.round(total * 100),
        signals: { genre: genreScore, keyword: keywordScore, crew: crewScore, era: eraScore },
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 50);
}

function profileGenreScore(profile: UserProfile, genres: number[]): number {
  let score = 0;
  for (const g of genres) {
    score += profile.genreWeights[g] ?? 0;
  }
  const denom = Math.max(Object.keys(profile.genreWeights).length, 1);
  return sigmoid(score / denom);
}

function keywordVecScore(profile: UserProfile, keywordIds: number[]): number {
  let score = 0;
  for (const kwId of keywordIds) {
    score += profile.keywordVec[kwId] ?? 0;
  }
  return sigmoid(score / 5);
}

function profileCrewScore(profile: UserProfile, crewIds: number[]): number {
  let score = 0;
  for (const cId of crewIds) {
    score += profile.crewScores[cId] ?? 0;
  }
  return sigmoid(score);
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
