export interface SearchResult {
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

export interface SearchProvider {
  readonly name: string;
  search(query: string, imdbId?: string): Promise<SearchResult[]>;
}

export function parseSize(str: string): number {
  const match = str.trim().match(/^([\d.]+)\s*(TB|GB|MB|KB)$/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = { TB: 1099511627776, GB: 1073741824, MB: 1048576, KB: 1024 };
  return Math.round(num * (multipliers[unit] || 1));
}
