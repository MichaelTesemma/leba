export interface SeedItem {
  tmdbId: number;
  mediaType: "movie" | "tv";
  weight: number;
}

export interface FeatureVector {
  genres: number[];
  keywordIds: number[];
  crewIds: number[];
  decade: number;
}

export interface UserProfile {
  genreWeights: Record<number, number>;
  keywordVec: Record<number, number>;
  crewScores: Record<number, number>;
  favDecades: Set<number>;
  totalSeeds: number;
}

export interface ScoredCandidate {
  tmdbId: number;
  mediaType: "movie" | "tv";
  title: string;
  posterPath: string | null;
  year: number;
  genres: { id: number; name: string }[];
  voteAverage: number;
  matchScore: number;
  signals: { genre: number; keyword: number; crew: number; era: number };
}

export interface RecommendationResult {
  profile: {
    totalSeeds: number;
    topGenres: { id: number; name: string; weight: number }[];
  };
  recommendations: ScoredCandidate[];
}
