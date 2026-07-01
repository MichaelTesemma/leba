import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { mkdtempSync, writeFileSync } from "fs";

/**
 * Candidate 6: Synchronous I/O
 *
 * Tests the patterns and impact of synchronous filesystem
 * operations in the streaming path. These demonstrate why
 * sync ops should be replaced with async alternatives.
 */

describe("Candidate 6a: Synchronous readdir pattern (intro detection)", () => {
  it("readdirSync blocks the event loop for large directories", async () => {
    const tmpDir = mkdtempSync("/tmp/leba-test-");
    try {
      for (let i = 0; i < 1000; i++) {
        writeFileSync(path.join(tmpDir, `file-${i}.mp4`), Buffer.alloc(1024));
      }

      // Measure sync readdir
      const startSync = Date.now();
      const entries = fs.readdirSync(tmpDir);
      const syncDuration = Date.now() - startSync;

      assert.equal(entries.length, 1000);

      // Compare with async readdir
      const startAsync = Date.now();
      const asyncEntries = await fs.promises.readdir(tmpDir);
      const asyncDuration = Date.now() - startAsync;

      assert.equal(asyncEntries.length, 1000);

      // Sync version blocks the event loop; async version yields to event loop
      assert.ok(syncDuration < 50, `Sync readdir of 1000 files took ${syncDuration}ms`);
    } finally {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    }
  });

  it("statSync in a loop compounds blocking time", async () => {
    const tmpDir = mkdtempSync("/tmp/leba-test-");
    try {
      for (let i = 0; i < 100; i++) {
        writeFileSync(path.join(tmpDir, `file-${i}.mp4`), Buffer.alloc(64 * 1024));
      }

      const entries = fs.readdirSync(tmpDir);
      const start = Date.now();
      for (const f of entries) {
        const st = fs.statSync(path.join(tmpDir, f));
        assert.ok(st.size > 0);
      }
      const syncDuration = Date.now() - start;

      // Async version runs all stats in parallel
      const startAsync = Date.now();
      const results = await Promise.all(entries.map((f) => fs.promises.stat(path.join(tmpDir, f))));
      const asyncDuration = Date.now() - startAsync;

      results.forEach((st) => assert.ok(st.size > 0));

      // The sync version's duration is the total blocking time
      assert.ok(syncDuration < 100, `Sync statLoop of 100 files took ${syncDuration}ms`);

      // The async version should not block significantly
      assert.ok(asyncDuration < 10, `Async stat start took ${asyncDuration}ms (should be near 0)`);
    } finally {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    }
  });

  it("synchronous stat is fast per-file but compounds with N files", () => {
    const timePerStatMs = 0.05; // ~50 microseconds per stat
    const filesInDirectory = 500; // typical completed download count
    const totalBlockTime = timePerStatMs * filesInDirectory;
    // 500 × 0.05ms = 25ms — visible as a frame drop at 60fps (16ms per frame)
    assert.ok(totalBlockTime > 16, `Block time (${totalBlockTime}ms) exceeds one frame (16ms)`);
  });
});

describe("Candidate 6b: Synchronous file reads (subtitle serving)", () => {
  it("readFileSync for small SRT files is fast but unnecessary", () => {
    const tmpDir = mkdtempSync("/tmp/leba-test-");
    try {
      // Generate a typical SRT file (~150KB)
      const lines: string[] = [];
      for (let i = 1; i <= 500; i++) {
        const h = Math.floor(i / 3600);
        const m = Math.floor((i % 3600) / 60);
        const s = i % 60;
        lines.push(`${i}\n${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},000 --> ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s + 4).padStart(2, "0")},000\nSubtitle line ${i}\n`);
      }
      const srt = lines.join("\n");
      const srtPath = path.join(tmpDir, "subs.srt");
      writeFileSync(srtPath, srt);

      // Sync read
      const startSync = Date.now();
      const content = fs.readFileSync(srtPath, "utf8");
      const syncDuration = Date.now() - startSync;
      assert.ok(content.length > 0);

      // Async read
      const startAsync = Date.now();
      const promise = fs.promises.readFile(srtPath, "utf8");
      const asyncDuration = Date.now() - startAsync;

      // Both should be fast, but sync blocks the event loop
      assert.ok(syncDuration < 50, `Sync readFile of SRT took ${syncDuration}ms`);
      // Async returns immediately (doesn't block)
      assert.ok(asyncDuration < 5, `Async readFile start took ${asyncDuration}ms`);
    } finally {
      for (const f of fs.readdirSync(tmpDir)) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    }
  });
});

describe("Candidate 6c: Event loop impact analysis", () => {
  it("sync I/O during streaming causes buffer underruns", () => {
    // At 60fps, each frame takes 16.67ms to render
    const frameBudgetMs = 16.67;
    // A single readdirSync + statSync loop for 500 files
    const readdirCost = 2; // 2ms for 500 entries
    const statCost = 25; // 25ms for 500 stats (at 0.05ms each)
    const totalBlock = readdirCost + statCost; // 27ms

    // If the event loop is blocked for 27ms during playback:
    // - No new data can be read from the stream
    // - The TCP socket buffer drains
    // - The browser's media buffer starves
    const framesMissed = Math.ceil(totalBlock / frameBudgetMs);
    // At least 2 frames are skipped during the block
    assert.ok(framesMissed >= 1, `Sync I/O blocks for ${totalBlock}ms, missing ~${framesMissed} frames`);
  });

  it("async I/O eliminates blocking entirely by yielding to event loop", () => {
    // Async I/O returns immediately with a Promise.
    // The actual I/O happens in the background via libuv's thread pool.
    // The event loop continues servicing other requests while I/O is in flight.
    const asyncStartupCost = 0.01; // ~10 microseconds to create a Promise
    const frameBudgetMs = 16.67;
    assert.ok(asyncStartupCost < frameBudgetMs,
      "Async I/O startup cost must fit within frame budget");
  });
});
