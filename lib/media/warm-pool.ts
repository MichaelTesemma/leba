import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type { LogFn } from "../types.js";

/**
 * A pool of warm ffmpeg processes kept alive with a dummy encoding loop.
 * When `acquire()` is called, the warm process is killed and a replacement
 * is spawned immediately, so the *next* acquire finds a warm process.
 *
 * The goal is to overlap ffmpeg spawn time with the preceding request
 * handling, so seeks and retries don't block waiting for ffmpeg to start.
 */
export class WarmPool {
  private warm: ChildProcess | null = null;
  private warming = false;
  private log: LogFn;

  constructor(log: LogFn) {
    this.log = log;
  }

  /**
   * Acquire a warm process. Returns immediately if one is ready,
   * otherwise spawns a new one (cold start).
   */
  acquire(): void {
    const p = this.warm;
    this.warm = null;
    this.warming = false;

    if (p && !p.killed) {
      p.kill("SIGKILL");
    }

    this.startWarming();
  }

  /**
   * Discard any warm process (cleanup on stream end).
   */
  discard(): void {
    if (this.warm && !this.warm.killed) {
      this.warm.kill("SIGKILL");
    }
    this.warm = null;
    this.warming = false;
  }

  private startWarming(): void {
    if (this.warming) return;
    this.warming = true;

    const proc = spawn("ffmpeg", [
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
      "-t", "1",
      "-f", "null", "-",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.on("error", () => {
      this.warm = null;
      this.warming = false;
    });

    proc.on("close", () => {
      if (this.warm === proc) this.warm = null;
      this.warming = false;
    });

    this.warm = proc;
  }
}
