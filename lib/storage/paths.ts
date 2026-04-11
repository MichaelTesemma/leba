import path from "path";
import os from "os";

export const isWindows = process.platform === "win32";

export function configDir(): string {
  if (process.env.MAGNET_CONFIG_DIR) return process.env.MAGNET_CONFIG_DIR;
  return isWindows
    ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Leba")
    : path.join(os.homedir(), ".config", "leba");
}

export function downloadDir(): string {
  return process.env.DOWNLOAD_PATH || path.join(os.tmpdir(), "leba");
}

export function transcodeDir(): string {
  return process.env.TRANSCODE_PATH || path.join(os.tmpdir(), "leba-transcoded");
}

export function dataDir(profile = "default"): string {
  return path.join(configDir(), "data", profile);
}

export function sessionsPath(): string {
  return path.join(configDir(), "sessions.json");
}

export function rcSessionsPath(): string {
  return path.join(configDir(), "rc-sessions.json");
}
