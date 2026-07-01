import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DebridService } from "../../../lib/torrent/debrid-service.js";

describe("DebridService", () => {
  let service: DebridService;

  afterEach(() => {
    service = undefined as unknown as DebridService;
  });

  it("creates with no provider (no config)", () => {
    service = new DebridService();
    const provider = service.getProvider();
    assert.equal(provider, null);
  });

  it("returns 'on' as default mode", () => {
    service = new DebridService();
    assert.equal(service.getMode(), "on");
  });

  it("manages active stream state", () => {
    service = new DebridService();
    const infoHash = "abcdef1234567890abcdef1234567890abcdef12";
    const url = "https://example.com/stream";
    const files = [{ id: 1, path: "movie.mp4", bytes: 1000 }];

    const streamKey = service.setActiveStream(infoHash, url, files);
    assert.ok(streamKey.length > 0);
    assert.equal(typeof streamKey, "string");

    const activeUrl = service.getActiveUrl(infoHash);
    assert.equal(activeUrl, url);

    const activeFiles = service.getActiveFiles(infoHash);
    assert.deepEqual(activeFiles, files);
  });

  it("looks up active stream by key", () => {
    service = new DebridService();
    const infoHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const url = "https://example.com/stream2";
    const files = [{ id: 2, path: "show.mkv", bytes: 2000 }];

    const streamKey = service.setActiveStream(infoHash, url, files);
    const result = service.getActiveStreamByKey(streamKey);
    assert.ok(result !== null);
    assert.equal(result.url, url);
    assert.deepEqual(result.files, files);
  });

  it("replaces previous stream on same infoHash", () => {
    service = new DebridService();
    const infoHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const key1 = service.setActiveStream(infoHash, "url1", []);
    const key2 = service.setActiveStream(infoHash, "url2", []);

    // First key should no longer resolve
    assert.equal(service.getActiveStreamByKey(key1), null);
    // Second key should resolve
    assert.ok(service.getActiveStreamByKey(key2) !== null);
    assert.equal(service.getActiveUrl(infoHash), "url2");
  });

  it("returns empty array for missing infoHash files", () => {
    service = new DebridService();
    assert.deepEqual(service.getActiveFiles("nonexistent"), []);
  });

  it("returns null for missing infoHash url", () => {
    service = new DebridService();
    assert.equal(service.getActiveUrl("nonexistent"), null);
  });
});
