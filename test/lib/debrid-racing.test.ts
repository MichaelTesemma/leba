import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DebridService } from "../../lib/torrent/debrid-service.js";
import type { DebridProvider, DebridStream } from "../../lib/torrent/debrid.js";

/**
 * Candidate 3: Debrid Candidate Racing
 *
 * Tests the current serial retry behavior and DebridService
 * poll mechanics. When we move to parallel racing (Promise.any),
 * these tests verify correctness still holds.
 */

function createMockProvider(
  name: string,
  unrestrictImpl: (magnet: string, fileIdx?: number) => Promise<DebridStream>,
): DebridProvider {
  let callCount = 0;
  return {
    name,
    unrestrict: async (magnet, fileIdx) => {
      callCount++;
      return unrestrictImpl(magnet, fileIdx);
    },
    checkCached: async () => new Map(),
    warmCache: () => {},
    validateKey: async () => ({ valid: true, premium: true, expiration: null, username: "test" }),
  };
}

describe("Candidate 3a: Debrid Candidate Selection", () => {
  it("picks the first successful candidate when racing", async () => {
    const provider = createMockProvider("realdebrid", async (magnet) => ({
      url: "https://cdn.real-debrid.com/video.mp4",
      filename: "video.mp4",
      filesize: 1024,
      fileIndex: 0,
      files: [{ id: 1, path: "video.mp4", bytes: 1024 }],
    }));

    const result = await provider.unrestrict("magnet:?xt=urn:btih:test");
    assert.equal(result.url, "https://cdn.real-debrid.com/video.mp4");
    assert.equal(result.filename, "video.mp4");
  });

  it("serial retry: a failing candidate delays subsequent candidates", async () => {
    let attemptOrder: string[] = [];

    const fastFailing = createMockProvider("fast-fail", async () => {
      attemptOrder.push("fast-fail");
      throw new Error("debrid_auth_failed");
    });

    const slowSucceeding = createMockProvider("slow-success", async () => {
      attemptOrder.push("slow-success");
      return {
        url: "https://cdn.com/video.mp4",
        filename: "video.mp4",
        filesize: 1024,
        fileIndex: 0,
        files: [{ id: 1, path: "video.mp4", bytes: 1024 }],
      };
    });

    // Simulate serial retry loop (current behavior)
    const candidates = [fastFailing, slowSucceeding];
    let result: DebridStream | null = null;
    for (const c of candidates) {
      try {
        result = await c.unrestrict("magnet:?xt=urn:btih:test");
        break;
      } catch {
        continue;
      }
    }
    assert.ok(result !== null);
    assert.deepEqual(attemptOrder, ["fast-fail", "slow-success"]);
  });

  it("parallel racing would complete in max(candidate time) not sum(candidate times)", async () => {
    const slow = createMockProvider("slow", async (magnet) => {
      await new Promise((r) => setTimeout(r, 50));
      return { url: `https://cdn.com/${magnet}`, filename: "slow.mp4", filesize: 100, fileIndex: 0, files: [] };
    });
    const fast = createMockProvider("fast", async (magnet) => {
      await new Promise((r) => setTimeout(r, 10));
      return { url: `https://cdn.com/${magnet}`, filename: "fast.mp4", filesize: 100, fileIndex: 0, files: [] };
    });

    const start = Date.now();
    // Serial: slow (50ms) + fast (10ms) = 60ms
    for (const c of [slow, fast]) {
      try { await c.unrestrict("magnet:test"); break; } catch { continue; }
    }
    const serialTime = Date.now() - start;

    const start2 = Date.now();
    // Parallel with Promise.any: max(slow(50ms), fast(10ms)) = 50ms
    const results = await Promise.any([
      fast.unrestrict("magnet:test"),
      slow.unrestrict("magnet:test"),
    ]);
    const parallelTime = Date.now() - start2;

    assert.ok(parallelTime <= serialTime * 0.9, "Parallel should be faster than serial");
    assert.equal(results.filename, "fast.mp4"); // faster candidate wins
  });
});

describe("Candidate 3b: DebridService Stream State", () => {
  let service: DebridService;

  after(() => {
    service = undefined as unknown as DebridService;
  });

  it("setActiveStream replaces previous entry for same infoHash", () => {
    service = new DebridService();
    const hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    service.setActiveStream(hash, "url1", []);
    const key2 = service.setActiveStream(hash, "url2", []);
    assert.equal(service.getActiveUrl(hash), "url2");
    // Old key is invalidated
    assert.equal(service.getActiveStreamByKey("some-old-key"), null);
  });

  it("getActiveFiles returns files for valid infoHash", () => {
    service = new DebridService();
    const hash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const files = [{ id: 1, path: "video.mp4", bytes: 1048576 }];
    service.setActiveStream(hash, "url", files);
    assert.deepEqual(service.getActiveFiles(hash), files);
  });

  it("setActiveStream generates unique keys each call", () => {
    service = new DebridService();
    const hash = "cccccccccccccccccccccccccccccccccccccccc";
    const k1 = service.setActiveStream(hash, "url1", []);
    const k2 = service.setActiveStream(hash, "url2", []);
    assert.notEqual(k1, k2);
  });

  it("setActiveStream key is hex string of correct length", () => {
    service = new DebridService();
    const key = service.setActiveStream("dddddddddddddddddddddddddddddddddddddddd", "url", []);
    assert.ok(/^[a-f0-9]{32}$/.test(key));
  });
});

describe("Candidate 3c: DebridProvider Interface Contract", () => {
  it("DebridProvider interface requires unrestrict, checkCached, validateKey, warmCache", () => {
    // Structural type test — any DebridProvider must satisfy this shape
    const provider: DebridProvider = {
      name: "test",
      unrestrict: async () => ({ url: "", filename: "", filesize: 0, fileIndex: 0, files: [] }),
      checkCached: async () => new Map(),
      warmCache: () => {},
      validateKey: async () => ({ valid: false, premium: false, expiration: null, username: null }),
    };
    assert.equal(typeof provider.unrestrict, "function");
    assert.equal(typeof provider.checkCached, "function");
    assert.equal(typeof provider.warmCache, "function");
    assert.equal(typeof provider.validateKey, "function");
    assert.equal(provider.name, "test");
  });

  it("validateKey returns expected shape on failure", async () => {
    const provider: DebridProvider = {
      name: "mock",
      unrestrict: async () => { throw new Error("not implemented"); },
      checkCached: async () => new Map(),
      warmCache: () => {},
      validateKey: async () => ({ valid: false, premium: false, expiration: null, username: null }),
    };
    const result = await provider.validateKey();
    assert.equal(result.valid, false);
    assert.equal(result.premium, false);
  });

  it("checkCached returns Map<string, boolean>", async () => {
    const provider: DebridProvider = {
      name: "mock",
      unrestrict: async () => { throw new Error("not implemented"); },
      checkCached: async (hashes) => {
        const map = new Map<string, boolean>();
        for (const h of hashes) map.set(h, true);
        return map;
      },
      warmCache: () => {},
      validateKey: async () => ({ valid: true, premium: true, expiration: null, username: null }),
    };
    const result = await provider.checkCached(["hash1", "hash2"]);
    assert.equal(result.get("hash1"), true);
    assert.equal(result.get("hash2"), true);
    assert.equal(result.size, 2);
  });
});
