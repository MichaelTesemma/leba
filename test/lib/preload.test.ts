import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Candidate 1: Preload Pipeline
 *
 * Tests the mathematical model behind preloadFirstPieces:
 * piece selection, preload size calculation, and offset math.
 * These are the invariants that must hold when we move preload
 * to happen during play-request (rather than stream-request).
 */

interface TorrentFile {
  offset: number;
  length: number;
  _endPiece: number;
}

interface Torrent {
  pieceLength: number;
}

function preloadPieces(
  file: TorrentFile,
  torrent: Torrent,
  preloadBytes: number = 2 * 1024 * 1024,
): { startPiece: number; endPiece: number; bytes: number } {
  const target = Math.min(preloadBytes, file.length);
  const piecesNeeded = Math.ceil(target / torrent.pieceLength);
  const startPiece = Math.ceil(file.offset / torrent.pieceLength);
  const endPiece = Math.min(startPiece + piecesNeeded - 1, file._endPiece);
  return { startPiece, endPiece, bytes: target };
}

describe("Candidate 1: Preload Pipeline", () => {
  it("preloads 2MB for a large file with default piece size", () => {
    const file: TorrentFile = { offset: 0, length: 4 * 1024 * 1024 * 1024, _endPiece: 32768 };
    const torrent: Torrent = { pieceLength: 128 * 1024 }; // 128KB pieces (common default)
    const result = preloadPieces(file, torrent);
    assert.equal(result.startPiece, 0);
    assert.equal(result.endPiece, 15); // 16 pieces × 128KB = 2MB
    assert.equal(result.bytes, 2 * 1024 * 1024);
  });

  it("starts piece selection from file offset, not zero", () => {
    const file: TorrentFile = { offset: 1024 * 1024 * 128, length: 4 * 1024 * 1024 * 1024, _endPiece: 65536 };
    const torrent: Torrent = { pieceLength: 128 * 1024 };
    const result = preloadPieces(file, torrent);
    assert.equal(result.startPiece, 1024); // 128MB / 128KB
    assert.ok(result.endPiece >= result.startPiece);
  });

  it("caps preload at file length for small files", () => {
    const file: TorrentFile = { offset: 0, length: 512 * 1024, _endPiece: 4 };
    const torrent: Torrent = { pieceLength: 128 * 1024 };
    const result = preloadPieces(file, torrent);
    assert.equal(result.bytes, 512 * 1024); // capped at file length
    assert.equal(result.endPiece, 3); // 4 pieces (0-3) for 512KB
  });

  it("does not exceed endPiece", () => {
    const file: TorrentFile = { offset: 0, length: 10 * 1024 * 1024, _endPiece: 5 };
    const torrent: Torrent = { pieceLength: 128 * 1024 };
    const result = preloadPieces(file, torrent, 10 * 1024 * 1024);
    // target=10MB, piecesNeeded=ceil(10MB/128KB)=80, min(0+80-1,5)=5
    assert.equal(result.endPiece, 5);
    assert.ok(result.endPiece <= file._endPiece);
  });

  it("handles 1-piece preload for very small piece sizes", () => {
    const file: TorrentFile = { offset: 0, length: 4 * 1024, _endPiece: 1 };
    const torrent: Torrent = { pieceLength: 4 * 1024 }; // 4KB pieces
    const result = preloadPieces(file, torrent);
    // target = min(2MB, 4KB) = 4KB, piecesNeeded = ceil(4KB/4KB) = 1
    assert.equal(result.startPiece, 0);
    assert.equal(result.endPiece, 0);
    assert.equal(result.bytes, 4 * 1024);
  });

  it("dynamic preload size: high-bitrate video needs more", () => {
    // Simulate a 1080p file at ~15Mbps bitrate
    const bitrateMbps = 15;
    const desiredSeconds = 3;
    const preloadBytesEstimate = (bitrateMbps * 1024 * 1024 / 8) * desiredSeconds;
    // ~15 Mbps / 8 = ~1.875 MB/s × 3s = ~5.625 MB
    assert.ok(preloadBytesEstimate > 2 * 1024 * 1024); // more than the current 2MB default
    assert.ok(preloadBytesEstimate < 10 * 1024 * 1024);

    const file: TorrentFile = { offset: 0, length: 4 * 1024 * 1024 * 1024, _endPiece: 32768 };
    const torrent: Torrent = { pieceLength: 128 * 1024 };
    const result = preloadPieces(file, torrent, preloadBytesEstimate);
    assert.equal(result.startPiece, 0);
    // Should select more pieces than the 2MB default
    const defaultResult = preloadPieces(file, torrent, 2 * 1024 * 1024);
    assert.ok(result.endPiece > defaultResult.endPiece);
  });

  it("preload time estimate is a fraction of total download time", () => {
    // At 5 MB/s download speed, 2MB takes ~400ms
    // File pieces are independent — preloading first few pieces
    // should not block the rest of the file from downloading
    const downloadSpeedBps = 5 * 1024 * 1024; // 5 MB/s
    const preloadSize2MB = 2 * 1024 * 1024;
    const preloadSizeDynamic = 5.625 * 1024 * 1024;
    const time2MB = preloadSize2MB / downloadSpeedBps;
    const timeDynamic = preloadSizeDynamic / downloadSpeedBps;
    // Even dynamic preload should complete in < 2 seconds at 5 MB/s
    assert.ok(timeDynamic < 2);
    assert.ok(time2MB < 0.5);
  });
});
