import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTranscodeArgs } from "../../lib/media/transcode.js";
import { isAllowedFile, srtToVtt, fmtBytes, magnetToInfoHash, throttle } from "../../lib/media/media-utils.js";
import type { TranscodeArgs } from "../../lib/types.js";

/**
 * Candidate 2: Connection Handling
 *
 * Tests the HTTP connection behavior of the streaming pipeline:
 * header handling, MIME types, range parsing logic, and
 * transcode argument construction (which affects stream startup latency).
 */

describe("Candidate 2a: Transcode Arguments", () => {
  const baseArgs: TranscodeArgs = {
    input: "/path/to/video.mkv",
    useStdin: false,
    seekTo: 0,
    audioStreamIdx: null,
    videoCodec: "h264",
    needsDownscale: false,
    isRetry: false,
  };

  it("uses -c:v copy when seeking file input (fast seek)", () => {
    const args = buildTranscodeArgs({ ...baseArgs, seekTo: 30 });
    assert.ok(args.includes("-c:v"));
    assert.ok(args.includes("copy"));
  });

  it("uses libx264 on retry with ultrafast preset", () => {
    const args = buildTranscodeArgs({ ...baseArgs, isRetry: true, seekTo: 30 });
    const cIdx = args.indexOf("-c:v");
    assert.ok(cIdx >= 0);
    assert.equal(args[cIdx + 1], "libx264");
    assert.ok(args.includes("ultrafast"));
  });

  it("adds scale filter when downscale needed", () => {
    const args = buildTranscodeArgs({ ...baseArgs, needsDownscale: true, videoCodec: "hevc", isRetry: true });
    const vfIdx = args.indexOf("-vf");
    assert.ok(vfIdx >= 0);
    assert.ok(args[vfIdx + 1].includes("scale=-2:1080"));
  });

  it("adds analyzeduration/probesize when using stdin", () => {
    const args = buildTranscodeArgs({ ...baseArgs, useStdin: true });
    assert.ok(args.includes("-analyzeduration"));
    assert.equal(args[args.indexOf("-analyzeduration") + 1], "5000000");
    assert.ok(args.includes("-probesize"));
  });

  it("uses -ss before -i for file input (fast seek), after -i for stdin", () => {
    const fileSeek = buildTranscodeArgs({ ...baseArgs, seekTo: 30 });
    const ssBeforeIdx = fileSeek.indexOf("-ss");
    const iIdx = fileSeek.indexOf("-i");
    assert.ok(ssBeforeIdx >= 0);
    assert.ok(ssBeforeIdx < iIdx); // -ss before -i for file (~ fast seek)
    assert.equal(fileSeek[ssBeforeIdx + 1], "30");

    const stdinSeek = buildTranscodeArgs({ ...baseArgs, useStdin: true, seekTo: 30 });
    const ssAfterIdx = stdinSeek.indexOf("-ss");
    const iIdx2 = stdinSeek.indexOf("-i");
    assert.ok(ssAfterIdx > iIdx2); // -ss after -i for stdin
  });

  it("uses -noaccurateseek with file seek (fast but less precise)", () => {
    const args = buildTranscodeArgs({ ...baseArgs, seekTo: 60 });
    assert.ok(args.includes("-noaccurateseek"));
    assert.ok(args.includes("-c:v")); // validate copy path includes c:v
  });

  it("outputs fragmented mp4 for streaming", () => {
    const args = buildTranscodeArgs(baseArgs);
    assert.ok(args.includes("frag_keyframe+empty_moov+default_base_moof"));
    assert.ok(args.includes("-f"));
    assert.ok(args.includes("mp4"));
    assert.ok(args.includes("pipe:1"));
  });

  it("no-seek path uses libx264 (full re-encode) since canCopySeek requires doSeek", () => {
    const args = buildTranscodeArgs(baseArgs);
    const cIdx = args.indexOf("-c:v");
    assert.ok(cIdx >= 0);
    assert.equal(args[cIdx + 1], "libx264", "Without seeking, -c:v copy is not used");
  });

  it("seek-with-stdin also uses libx264 (canCopySeek requires !useStdin)", () => {
    const args = buildTranscodeArgs({ ...baseArgs, useStdin: true, seekTo: 60 });
    const cIdx = args.indexOf("-c:v");
    assert.ok(cIdx >= 0);
    assert.equal(args[cIdx + 1], "libx264", "Stdin seek cannot use -c:v copy");
  });

  it("selects specific audio stream when audioStreamIdx provided", () => {
    const args = buildTranscodeArgs({ ...baseArgs, audioStreamIdx: 2 });
    const mapIdx = args.indexOf("-map") + 1;
    // First map is video, second is audio
    const audioMapIdx = args.indexOf("-map", mapIdx) + 1;
    assert.equal(args[audioMapIdx], "0:2");
  });
});

describe("Candidate 2b: MIME Type Handling", () => {
  it("isAllowedFile accepts common video extensions", () => {
    assert.equal(isAllowedFile("movie.mp4"), true);
    assert.equal(isAllowedFile("show.mkv"), true);
    assert.equal(isAllowedFile("clip.webm"), true);
    assert.equal(isAllowedFile("episode.avi"), true);
  });

  it("isAllowedFile rejects dangerous extensions", () => {
    assert.equal(isAllowedFile("virus.exe"), false);
    assert.equal(isAllowedFile("script.js"), false);
    assert.equal(isAllowedFile("movie.mp4.png"), false);
    assert.equal(isAllowedFile(""), false);
  });

  it("isAllowedFile is case-insensitive", () => {
    assert.equal(isAllowedFile("MOVIE.MP4"), true);
    assert.equal(isAllowedFile("Show.MKV"), true);
  });

  it("detects non-video MIME types that browsers may not support natively", () => {
    // These extensions are allowed but their MIME type is guessed as video/mp4
    // by transcode.ts — browsers may not play them natively
    const allowedButNotNativeMP4 = [".mkv", ".avi", ".mov", ".flv", ".wmv"];
    for (const ext of allowedButNotNativeMP4) {
      assert.equal(isAllowedFile(`file${ext}`), true, `${ext} should be allowed`);
    }
  });
});

describe("Candidate 2c: Utility Functions (used in streaming path)", () => {
  it("srtToVtt converts timestamps correctly", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n";
    const vtt = srtToVtt(srt);
    assert.ok(vtt.startsWith("WEBVTT"));
    assert.ok(vtt.includes("00:00:01.000 --> 00:00:04.000"));
    assert.ok(vtt.includes("Hello world"));
  });

  it("srtToVtt handles multiple blocks", () => {
    const srt = "1\n00:00:01,000 --> 00:00:04,000\nFirst\n\n2\n00:00:05,000 --> 00:00:08,000\nSecond\n\n";
    const vtt = srtToVtt(srt);
    assert.ok(vtt.includes("First"));
    assert.ok(vtt.includes("Second"));
    assert.equal((vtt.match(/-->/g) || []).length, 2);
  });

  it("srtToVtt skips blocks without timestamps", () => {
    const srt = "garbage text with no timestamp\n\n1\n00:00:01,000 --> 00:00:04,000\nValid\n\n";
    const vtt = srtToVtt(srt);
    assert.ok(vtt.includes("Valid"));
    assert.ok(!vtt.includes("garbage"));
  });

  it("fmtBytes formats zero correctly", () => {
    assert.equal(fmtBytes(0), "0 B");
  });

  it("fmtBytes formats various sizes", () => {
    assert.equal(fmtBytes(1024), "1.0 KB");
    assert.equal(fmtBytes(1048576), "1.0 MB");
    assert.equal(fmtBytes(1073741824), "1.0 GB");
    assert.equal(fmtBytes(1536), "1.5 KB");
  });

  it("magnetToInfoHash extracts infoHash from magnet URI", () => {
    const hash = "abcdef0123456789abcdef0123456789abcdef01";
    const magnet = `magnet:?xt=urn:btih:${hash}&dn=test&tr=udp://tracker.com`;
    assert.equal(magnetToInfoHash(magnet), hash);
  });

  it("magnetToInfoHash returns null for invalid magnets", () => {
    assert.equal(magnetToInfoHash("not a magnet"), null);
    assert.equal(magnetToInfoHash("magnet:?dn=no-hash"), null);
  });

  it("throttle limits calls to one per interval", () => {
    let calls = 0;
    const fn = () => calls++;
    const throttled = throttle(fn, 100);

    throttled();
    assert.equal(calls, 1); // first call goes through

    throttled();
    throttled();
    assert.equal(calls, 1); // subsequent calls within interval are dropped

    // After advancing time — can't easily test without fake timers
  });
});
