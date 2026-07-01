import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { SearchRegistry } from "../../../lib/search/registry.js";
import type { SearchProvider, SearchResult } from "../../../lib/search/types.js";

function createMockProvider(name: string, results: SearchResult[]): SearchProvider {
  return {
    name,
    async search(_query: string, _imdbId?: string): Promise<SearchResult[]> {
      return results;
    },
  };
}

describe("SearchRegistry", () => {
  it("creates with default providers", () => {
    const registry = new SearchRegistry();
    assert.ok(registry.getProviders().length >= 10);
  });

  it("deduplicates by infoHash, keeping higher seeders", async () => {
    const registry = new SearchRegistry();
    const p1 = createMockProvider("tpb", [
      { name: "Test A", infoHash: "aaa", size: 100, seeders: 5, leechers: 2, source: "tpb" },
    ]);
    const p2 = createMockProvider("yts", [
      { name: "Test B", infoHash: "aaa", size: 100, seeders: 10, leechers: 3, source: "yts" },
    ]);

    // Replace registry providers with mocks
    const providers = [p1, p2];
    Object.defineProperty(registry, "providers", { value: providers });
    const results = await registry.searchAll("test");
    assert.equal(results.length, 1);
    assert.equal(results[0].seeders, 10);
    assert.equal(results[0].source, "yts");
  });

  it("handles empty search results", async () => {
    const registry = new SearchRegistry();
    // Empty providers
    Object.defineProperty(registry, "providers", { value: [] });
    const results = await registry.searchAll("nothing");
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0);
  });

  it("copes with provider failures", async () => {
    const failingProvider: SearchProvider = {
      name: "tpb",
      async search() { throw new Error("Network error"); },
    };
    const goodProvider: SearchProvider = {
      name: "yts",
      async search(_q: string) {
        return [{ name: "Result", infoHash: "bbb", size: 0, seeders: 1, leechers: 0, source: "yts" }];
      },
    };
    const registry = new SearchRegistry();
    Object.defineProperty(registry, "providers", { value: [failingProvider, goodProvider] });
    const results = await registry.searchAll("test");
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "yts");
  });
});
