import type { Torrent, TorrentFile } from "../types.js";

/**
 * Preload the first ~2 MB of a torrent file to speed up time-to-first-frame.
 * The MP4 moov atom (required for playback) typically lives in the first few pieces.
 */
export function preloadFirstPieces(file: TorrentFile, torrent: Torrent): void {
  const target = Math.min(2 * 1024 * 1024, file.length);
  const piecesNeeded = Math.ceil(target / torrent.pieceLength);
  const startPiece = Math.ceil(file.offset / torrent.pieceLength);
  const endPiece = Math.min(startPiece + piecesNeeded - 1, file._endPiece);

  torrent.select(startPiece, endPiece, 1);
}
