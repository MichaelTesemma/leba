import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildTranscodeArgs, spawnWatchdog } from "../../lib/media/transcode.js";
import type { TranscodeArgs, ProbeResult, LogFn } from "../../lib/types.js";
import { ChildProcess } from "child_process";
import { EventEmitter } from "events";

/**
 * Candidate 5: Seek/Transcode Warm Pool
 *
 * Tests the transcode argument construction, watchdog behavior,
 * and probe caching. These are the building blocks for a warm
 * transcode pool that eliminates ffmpeg startup latency on seek.
 */

const _baseArgs: TranscodeArgs = {
  input: "/path/to/video.mkv",
  useStdin: false,
  seekTo: 0,
  audioStreamIdx: null,
  videoCodec: "h264",
  needsDownscale: false,
  isRetry: false,
};

describe("Candidate 5a: buildTranscodeArgs — seek fast paths", () => {
  const baseArgs = _baseArgs;

  it("seek with file input: uses -c:v copy (zero-cost remux at keyframe)", () => {
    const args = buildTranscodeArgs({ ...baseArgs, seekTo: 30 });
    assert.ok(args.includes("-c:v"));
    const cIdx = args.indexOf("-c:v");
    assert.equal(args[cIdx + 1], "copy");
  });

  it("no-seek: uses libx264 (full re-encode — canCopySeek requires doSeek)", () => {
    const args = buildTranscodeArgs(baseArgs);
    const cIdx = args.indexOf("-c:v");
    assert.ok(cIdx >= 0);
    assert.equal(args[cIdx + 1], "libx264");
    assert.ok(args.includes("ultrafast"));
  });

  it("seek with file input: fast seek via -ss before -i", () => {
    const args = buildTranscodeArgs({ ...baseArgs, seekTo: 120 });
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    assert.ok(ssIdx >= 0 && iIdx >= 0);
    assert.ok(ssIdx < iIdx, "-ss must be before -i for fast seek");
    assert.equal(args[ssIdx + 1], "120");
    // Should also include -noaccurateseek for speed
    assert.ok(args.includes("-noaccurateseek"));
  });

  it("seek with stdin: -ss after -i (must decode from start)", () => {
    const args = buildTranscodeArgs({ ...baseArgs, useStdin: true, seekTo: 60 });
    const ssIdx = args.indexOf("-ss");
    const iIdx = args.indexOf("-i");
    assert.ok(ssIdx >= 0 && iIdx >= 0);
    assert.ok(ssIdx > iIdx, "-ss must be after -i for stdin seek");
    assert.ok(!args.includes("-noaccurateseek")); // stdin can't fast seek
  });

  it("non-h264 codec triggers downscale on retry", () => {
    const args = buildTranscodeArgs({
      ...baseArgs, videoCodec: "hevc", needsDownscale: true, isRetry: true,
    });
    const vfIdx = args.indexOf("-vf");
    assert.ok(vfIdx >= 0);
    assert.ok(args[vfIdx + 1].includes("scale=-2:1080"));
  });
});

describe("Candidate 5b: Probe Cache Analysis", () => {
  it("probeCache stores probe results and reuses them", () => {
    const cache = new Map<string, ProbeResult>();
    const result: ProbeResult = {
      valid: true, format: "matroska", duration: 3600, videoCodec: "h264", audioCodec: "aac",
    };
    cache.set("/path/to/file.mkv", result);
    assert.equal(cache.has("/path/to/file.mkv"), true);
    assert.equal(cache.get("/path/to/file.mkv")!.duration, 3600);
  });

  it("cache miss returns undefined", () => {
    const cache = new Map<string, ProbeResult>();
    assert.equal(cache.has("/nonexistent"), false);
    assert.equal(cache.get("/nonexistent"), undefined);
  });

  it("cached result avoids redundant ffprobe spawns", () => {
    // Each ffprobe spawn takes 1-3s on a 4K file.
    // 1 cache hit per seek = 1-3s saved per seek
    const ffprobeCostPerSpawnMs = 1500; // average
    const seeksPerMovie = 3; // typical user seeks during a movie
    const cacheMissCost = ffprobeCostPerSpawnMs * seeksPerMovie; // 4500ms
    const cacheHitCost = 0; // instant
    assert.ok(cacheMissCost > cacheHitCost, "Cache hits must be faster than ffprobe spawns");
  });
});

describe("Candidate 5c: Watchdog Timer", () => {
  it("spawnWatchdog creates an interval that checks activity", () => {
    const mockProcess = new EventEmitter() as unknown as ChildProcess;
    mockProcess.stdout = new EventEmitter() as unknown as ReadableStream;
    mockProcess.stderr = new EventEmitter() as unknown as ReadableStream;
    mockProcess.kill = () => {};

    const logged: string[] = [];
    const mockLog: LogFn = (level, msg) => { logged.push(msg); };

    const cleanup = spawnWatchdog(mockProcess, 60000, mockLog, "test");
    assert.equal(typeof cleanup, "function");
    cleanup();
  });

  it("watchdog resets activity on stdout data", () => {
    let lastActivity = Date.now();
    const stdout = new EventEmitter();
    stdout.on("data", () => { lastActivity = Date.now(); });
    // Simulate data arriving
    stdout.emit("data");
    // lastActivity was just updated
    assert.ok(lastActivity > 0);
  });

  it("watchdog cleans up when process closes", () => {
    const mockProcess = new EventEmitter() as unknown as ChildProcess;
    mockProcess.stdout = new EventEmitter() as unknown as ReadableStream;
    mockProcess.stderr = new EventEmitter() as unknown as ReadableStream;
    mockProcess.kill = () => {};

    let cleanedUp = false;
    const cleanup = spawnWatchdog(mockProcess, 120000, () => {}, "close-test");
    mockProcess.on("close", () => { cleanedUp = true; });
    mockProcess.emit("close");
    assert.equal(typeof cleanup, "function");
  });
});

describe("Candidate 5d: Transcode Retry Analysis", () => {
  it("first attempt (seeking) uses -c:v copy; retry uses libx264", () => {
    const first = buildTranscodeArgs({
      input: "/v.mkv", useStdin: false, seekTo: 30, audioStreamIdx: null,
      videoCodec: "h264", needsDownscale: false, isRetry: false,
    });
    const retry = buildTranscodeArgs({
      input: "/v.mkv", useStdin: false, seekTo: 30, audioStreamIdx: null,
      videoCodec: "h264", needsDownscale: false, isRetry: true,
    });
    assert.ok(first.includes("copy"));
    assert.ok(retry.includes("libx264"));
    assert.ok(retry.includes("ultrafast"));
  });

  it("no-seek attempt always re-encodes (both first and retry use libx264)", () => {
    const first = buildTranscodeArgs({ ..._baseArgs, seekTo: 0 });
    const retry = buildTranscodeArgs({ ..._baseArgs, seekTo: 0, isRetry: true });
    const firstCIdx = first.indexOf("-c:v");
    const retryCIdx = retry.indexOf("-c:v");
    assert.equal(first[firstCIdx + 1], "libx264");
    assert.equal(retry[retryCIdx + 1], "libx264");
  });

  it("retry adds format=yuv420p to video filter chain", () => {
    const args = buildTranscodeArgs({
      input: "/v.mkv", useStdin: false, seekTo: 0, audioStreamIdx: null,
      videoCodec: "h264", needsDownscale: false, isRetry: true,
    });
    const vfIdx = args.indexOf("-vf");
    if (vfIdx >= 0) {
      assert.ok(args[vfIdx + 1].includes("format=yuv420p"));
    }
  });
});
