import type { JsonStore } from "./store.js";

export interface RatingRecord {
  tmdbId: number;
  mediaType: "movie" | "tv";
  value: number;       // 1-5
  title: string;
  posterPath: string | null;
  createdAt: string;   // ISO 8601
}

function ratingKey(mediaType: string, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export class RatingStore {
  constructor(private store: JsonStore<RatingRecord>) {}

  rate(tmdbId: number, mediaType: "movie" | "tv", value: number, title: string, posterPath: string | null): void {
    this.store.set(ratingKey(mediaType, tmdbId), {
      tmdbId, mediaType, value, title, posterPath,
      createdAt: new Date().toISOString(),
    });
  }

  getRating(mediaType: string, tmdbId: number): RatingRecord | undefined {
    return this.store.get(ratingKey(mediaType, tmdbId));
  }

  getAll(): RatingRecord[] {
    return this.store.values().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRatedIds(): Set<number> {
    return new Set(this.store.values().map((r) => r.tmdbId));
  }

  getByMediaType(type: "movie" | "tv"): RatingRecord[] {
    return this.store.values().filter((r) => r.mediaType === type);
  }

  get size(): number { return this.store.size; }
}
