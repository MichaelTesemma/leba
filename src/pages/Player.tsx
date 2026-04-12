// ── Player.tsx — Artplayer playback ──
//
// Video playback is handled by Artplayer (HTML5 video with custom controls).
// When running in the Qt/QML shell, a native mpv player could be used instead,
// but for the standalone web app, Artplayer is the primary player.
//
// Architecture:
//   React (Player.tsx) → Artplayer → HTTP stream → Express server → WebTorrent
//   Events flow from Artplayer → React state → watch history / remote control

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { useSubtitles } from "../lib/useSubtitles";
import { useAudioTracks } from "../lib/useAudioTracks";
import { useSeek } from "../lib/useSeek";
import { useIntro } from "../lib/useIntro";
import { formatBytes } from "../lib/utils";
import { playTorrent, fetchLivePeers, fetchLanIp, searchStreams, autoPlay, fetchSeason, reportWatchProgress } from "../lib/api";
import type Artplayer from "artplayer";
import { playbackKey, shouldRestorePosition } from "../lib/playback-position";
import "./Player.css";

export default function Player() {
  const { infoHash, fileIndex } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { startStream, active, effectiveTimeRef, subsRef, activeSubRef, audioTracksRef, activeAudioRef, commandRef, dlProgressRef, dlSpeedRef, dlPeersRef, rcSessionId, rcAuthToken, rcRemoteConnected, rcQrRequested, setRcSessionId, setRcAuthToken, introRangeRef, episodeInfoRef, sourcesRef, subSize, adjustSubSize, setSubSizeAbsolute, subDelayRef } = usePlayer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = useMemo(() => {
    const key = `playerState:${infoHash}:${fileIndex}`;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) return JSON.parse(saved);
    } catch {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (location.state as any) || null;
  }, [infoHash, fileIndex]); // Stable key — avoids recomputation on every navigation
  const [currentTags, setCurrentTags] = useState<string[]>(state?.tags || []);
  const tags: string[] = currentTags.length > 0 ? currentTags : (active?.tags || []);
  const mediaTitle: string = state?.title || active?.title || "";
  const preSelectedAudio: number | null = state?.audioTrack ?? null;
  const preSelectedSub: string | null = state?.subtitle ?? null;
  const [torrentNotFound, setTorrentNotFound] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const seekRef = useRef<HTMLDivElement>(null);

  // Source switcher state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [sources, setSources] = useState<any[]>(state?.sources || []);
  sourcesRef.current = sources;
  const [showSources, setShowSources] = useState(false);
  const [switchingSource, setSwitchingSource] = useState<string | null>(null);
  const [livePeers, setLivePeers] = useState<Record<string, { numPeers: number; downloadSpeed: number }>>({});
  const livePeerTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  // Group sources by resolution for quality picker
  const qualityGroups = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const groups: Record<string, any[]> = {};
    const order = ["1080p", "720p", "480p"];
    for (const group of order) groups[group] = [];
    groups["Other"] = [];
    for (const s of sources) {
      const tag = s.tags?.find((t: string) => ["1080p", "720p", "480p"].includes(t));
      (groups[tag || "Other"] ?? groups["Other"]).push(s);
    }
    // Sort each group by score descending
    for (const g of Object.values(groups)) g.sort((a: any, b: any) => b.score - a.score);
    return groups;
  }, [sources]);

  // Episode list state (for TV shows / season packs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [episodes, setEpisodes] = useState<any[]>([]);
  const [showEpisodes, setShowEpisodes] = useState(false);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);

  const isTV = state?.type === "tv" || tags.some((t) => /S\d{1,2}E\d{1,2}|season/i.test(t));

  useEffect(() => {
    if (!isTV || !infoHash || episodes.length > 0) return;
    let cancelled = false;
    setLoadingEpisodes(true);
    import("../lib/api").then(({ fetchStatus }) => {
      fetchStatus(infoHash).then((data) => {
        if (cancelled || !data?.files) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vids = data.files.filter((f: any) => f.isVideo).sort((a: any, b: any) => {
          // Sort by episode number extracted from filename
          const epA = a.name.match(/[Ss]\d{1,2}[Ee](\d{1,3})/i);
          const epB = b.name.match(/[Ss]\d{1,2}[Ee](\d{1,3})/i);
          if (epA && epB) return parseInt(epA[1], 10) - parseInt(epB[1], 10);
          return a.index - b.index;
        });
        if (!cancelled) setEpisodes(vids);
      }).catch(() => {}).finally(() => { if (!cancelled) setLoadingEpisodes(false); });
    });
    return () => { cancelled = true; };
  }, [infoHash, isTV]);

  const currentQuality = useMemo(() => {
    const tag = tags?.find((t: string) => ["1080p", "720p", "480p"].includes(t));
    return tag || "Auto";
  }, [tags]);

  // Fetch sources for current content
  useEffect(() => {
    if (!state?.title) return;
    setSources(state?.sources || []);
    if (state?.sources?.length > 0) return;
    searchStreams(state.title, state.year, state.type, state.season, state.episode, state.imdbId)
      .then((results) => { if (results.length > 0) setSources(results); })
      .catch(() => {});
  }, [infoHash]);

  // Tell QML how many sources are available (for showing/hiding source button)
  useEffect(() => {
    // noop — no QML in web-only mode
  }, [sources.length]);

  // Notify QML when source panel opens/closes
  useEffect(() => {
    // noop — no QML in web-only mode
  }, [showSources]);

  // Poll live peers only for the currently playing torrent
  useEffect(() => {
    if (!showSources || !active?.infoHash) {
      clearInterval(livePeerTimer.current);
      return;
    }
    const poll = () => {
      fetchLivePeers([active.infoHash]).then(setLivePeers).catch(() => {});
    };
    poll();
    livePeerTimer.current = setInterval(poll, 3000);
    return () => clearInterval(livePeerTimer.current);
  }, [showSources, active?.infoHash]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSwitchSource = useCallback(async (source: any) => {
    if (source.infoHash === active?.infoHash) {
      setShowSources(false);
      return;
    }
    setSwitchingSource(source.infoHash);
    try {
      const result = await playTorrent(
        source.infoHash, source.name,
        state?.season, state?.episode,
      );
      const newTags = result.tags || source.tags || [];
      setCurrentTags(newTags);
      setShowSources(false);
      const currentPos = effectiveTimeRef.current?.time ?? 0;
      navigate("/", { replace: true });
      startStream(result.infoHash, result.fileIndex, mediaTitle, newTags, result.debridStreamKey);
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
        state: {
          ...state,
          tags: newTags,
          sources,
          debridStreamKey: result.debridStreamKey,
          resumePosition: currentPos > 10 ? currentPos : undefined,
        },
      });
    } catch {
      // If switch fails, stay on current
    } finally {
      setSwitchingSource(null);
    }
  }, [active, startStream, navigate, state, sources, mediaTitle]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSwitchEpisode = useCallback(async (ep: any) => {
    if (String(ep.index) === String(fileIndex)) { setShowEpisodes(false); return; }
    setSwitchingSource(ep.name);
    try {
      const result = await playTorrent(infoHash!, "", state?.season, state?.episode, ep.index);
      const newTags = result.tags || tags || [];
      setCurrentTags(newTags);
      setShowEpisodes(false);
      const currentPos = effectiveTimeRef.current?.time ?? 0;
      navigate("/", { replace: true });
      startStream(result.infoHash, result.fileIndex, mediaTitle, newTags, result.debridStreamKey);
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
        state: { ...state, tags: newTags, sources, debridStreamKey: result.debridStreamKey, resumePosition: currentPos > 10 ? currentPos : undefined },
      });
    } catch { /* stay on current */ }
    finally { setSwitchingSource(null); }
  }, [infoHash, fileIndex, startStream, navigate, state, sources, mediaTitle, tags]);

  const artSeekRef = useRef<(seconds: number) => void>(() => {});

  const {
    dlProgress, dlSpeed, numPeers,
    getEffectiveTime,
    seekTo,
    setPlaying,
  } = useSeek({
    infoHash: infoHash!, fileIndex: fileIndex!,
    effectiveTimeRef, dlProgressRef, dlSpeedRef, dlPeersRef,
    seekRef,
    seekFn: (seconds: number) => { artSeekRef.current(seconds); },
    onTorrentNotFound: () => setTorrentNotFound(true),
  });

  const {
    subs, activeSub, switchSubtitle, reloadActiveSub,
  } = useSubtitles({
    infoHash: infoHash!, fileIndex: fileIndex!, subsRef, activeSubRef,
    preSelectedSub,
  });


  const { audioTracks, activeAudio, switchAudio } = useAudioTracks({
    infoHash: infoHash!, fileIndex: fileIndex!, audioTracksRef, activeAudioRef,
    preSelectedAudio,
  });

  const { introRange, showSkipIntro, handleSkipIntro } = useIntro({
    infoHash: infoHash!, fileIndex: fileIndex!, introRangeRef, getEffectiveTime, seekTo, location, mediaTitle,
  });

  // Sync episode metadata to PlayerContext for RC state broadcast
  useEffect(() => {
    if (state?.type === "tv" && state?.season != null && state?.episode != null) {
      episodeInfoRef.current = {
        mediaType: "tv",
        season: Number(state.season),
        episode: Number(state.episode),
        seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : 0,
        tmdbId: state.tmdbId ?? undefined,
        imdbId: state.imdbId ?? undefined,
        seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
        posterPath: state.posterPath ?? undefined,
      };
    } else {
      episodeInfoRef.current = state?.type ? { mediaType: state.type, season: 0, episode: 0, seasonEpisodeCount: 0, tmdbId: state.tmdbId ?? undefined, imdbId: state.imdbId ?? undefined, posterPath: state.posterPath ?? undefined } : null;
    }
    return () => { episodeInfoRef.current = null; };
  }, [state, episodeInfoRef]);

  // ── Next episode (triggered by phone remote) ──
  const handleNextEpisode = useCallback(async (nextSeason: number, nextEpisode: number) => {
    if (!state?.tmdbId) return;
    beaconProgressRef.current();
    const title = state.baseName || mediaTitle;
    const year = state.year != null ? Number(state.year) : undefined;
    const imdbId = state.imdbId ?? undefined;
    try {
      const [result, seasonData] = await Promise.all([
        autoPlay(title, year, "tv", nextSeason, nextEpisode, imdbId),
        fetchSeason(state.tmdbId, nextSeason).catch(() => null),
      ]);
      const seasonEpisodeCount = seasonData?.episodes?.length ?? undefined;
      const episodeTitle = seasonData?.episodes?.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ep: any) => ep.episode_number === nextEpisode
      )?.name;
      navigate("/", { replace: true });
      startStream(result.infoHash, result.fileIndex, `${title} — S${nextSeason}E${nextEpisode}`, result.tags || [], result.debridStreamKey);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const navState: any = {
        tags: result.tags, title: `${title} — S${nextSeason}E${nextEpisode}`, baseName: title,
        tmdbId: state.tmdbId, year, type: "tv", imdbId, posterPath: state.posterPath ?? null,
        season: nextSeason, episode: nextEpisode,
        episodeTitle, seasonEpisodeCount,
        seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      };
      if (result.debridStreamKey) navState.debridStreamKey = result.debridStreamKey;
      navigate(`/play/${result.infoHash}/${result.fileIndex}`, { state: navState });
    } catch {
      // Failed to auto-play
    }
  }, [state, mediaTitle, navigate, startStream]);

  // Sync PlayerContext.active with URL params
  useEffect(() => {
    if (!infoHash || !fileIndex) return;
    if (active?.infoHash !== infoHash || String(active?.fileIndex) !== String(fileIndex)) {
      startStream(infoHash, fileIndex, mediaTitle, tags, state?.debridStreamKey);
    }
  }, [infoHash, fileIndex]);

  // ── Artplayer setup ──
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const artRef = useRef<Artplayer | null>(null);
  const reportProgressRef = useRef(() => {});
  const goBackRef = useRef(() => {});

  useEffect(() => {
    if (!infoHash || !fileIndex || !playerContainerRef.current) return;
    let cancelled = false;

    const port = window.location.port || "3000";
    const debridStreamKey = state?.debridStreamKey;
    // Cache-bust with timestamp so the browser never sends a 304 conditional request
    // for a stale URL from a previous session
    const ts = Date.now();
    const streamUrl = debridStreamKey
      ? `http://127.0.0.1:${port}/api/debrid-stream?streamKey=${encodeURIComponent(debridStreamKey)}&_t=${ts}`
      : `http://127.0.0.1:${port}/api/stream/${infoHash}/${fileIndex}?_t=${ts}`;

    // Destroy previous instance
    if (artRef.current) {
      artRef.current.destroy();
      artRef.current = null;
    }

    import("artplayer").then(({ default: Artplayer }) => {
      if (cancelled) return;

      const art = new Artplayer({
        container: playerContainerRef.current!,
        url: streamUrl,
        title: mediaTitle || "",
        poster: state?.posterPath ? `https://image.tmdb.org/t/p/w1280${state.posterPath}` : undefined,
        volume: 0.8,
        autoplay: true,
        autoSize: false,
        autoMini: true,
        flip: true,
        playbackRate: true,
        aspectRatio: true,
        setting: true,
        hotkey: true,
        pip: false,
        fullscreen: true,
        fullscreenWeb: false,
        subtitleOffset: true,
        miniProgressBar: false,
        mutex: true,
        backdrop: true,
        playsInline: true,
        autoPlayback: true,
        airplay: true,
        lang: navigator.language.toLowerCase().startsWith("zh") ? "zh-cn" : "en",
        controls: [
          ...(isTV ? [{
            name: "episodes",
            index: 5,
            position: "right",
            html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"/></svg>',
            tooltip: "Episodes",
            style: { color: "#38bdf8", display: "flex", alignItems: "center" },
            click: () => setShowEpisodes(!showEpisodes),
          }] : []),
          {
            name: "quality",
            index: 10,
            position: "right",
            html: "1080p",
            tooltip: "Switch quality",
            style: {
              color: "#38bdf8",
              fontSize: "12px",
              fontWeight: "700",
              letterSpacing: "0.5px",
              textTransform: "uppercase",
            },
            click: () => setShowSources(!showSources),
          },
          {
            name: "subtitle",
            index: 20,
            position: "right",
            html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 14H4V6h16v12zM6 10h2v2H6v-2zm0 4h8v2H6v-2zm10 0h2v2h-2v-2zm-6-4h8v2h-8v-2z"/></svg>',
            tooltip: "Toggle subtitles",
            style: {
              color: "#38bdf8",
              display: "flex",
              alignItems: "center",
            },
            click: () => {
              if (activeSub) {
                setActiveSub("");
                const art = artRef.current;
                if (art) art.subtitle.show = false;
              } else if (subs.length > 0 && subs[0]) {
                setActiveSub(subs[0].value);
              }
            },
          },
        ],
        moreVideoAttr: {
          // @ts-expect-error — playsInline for iOS
          playsInline: true,
          crossOrigin: "anonymous",
        },
        customType: {
          mp4: (video: HTMLVideoElement, url: string) => { video.src = url; },
          mkv: (video: HTMLVideoElement, url: string) => { video.src = url; },
          webm: (video: HTMLVideoElement, url: string) => { video.src = url; },
        },
      });

      artRef.current = art;
      artSeekRef.current = (seconds: number) => { art.seek = seconds; };

      // ── Wire up events ──
      art.on("video:loadedmetadata", () => {
        const d = art.duration;
        effectiveTimeRef.current = { time: art.currentTime, duration: d, ts: Date.now() };
        // Restore saved position
        const sessionPos = parseFloat(sessionStorage.getItem(playbackKey(infoHash!, fileIndex!)) || "0");
        const historyPos = state?.resumePosition ? parseFloat(state.resumePosition) : 0;
        const saved = sessionPos > 0 ? sessionPos : historyPos;
        if (shouldRestorePosition(saved, d)) {
          art.seek = saved;
        }
      });

      art.on("video:timeupdate", () => {
        const t = art.currentTime;
        const d = art.duration;
        if (isFinite(t) && isFinite(d)) {
          effectiveTimeRef.current = { time: t, duration: d, ts: Date.now() };
          setPlaying(!art.playing);
        }
      });

      art.on("video:ended", () => {
        reportProgressRef.current();
        goBackRef.current();
      });

      art.on("ready", () => {
        // Browser autoplay policy: start muted to bypass the restriction,
        // then restore the user's volume after playback begins.
        const savedVolume = art.volume;
        art.muted = true;
        art.play().then(() => {
          // Unmute after a short delay so the browser considers it "user-initiated"
          setTimeout(() => {
            art.muted = false;
            art.volume = savedVolume;
          }, 500);
        }).catch(() => {
          // If autoplay still fails (e.g. strict policies), leave muted
          art.muted = false;
          art.volume = savedVolume;
        });
      });

      // Register command handlers for remote control
      if (commandRef) {
        commandRef.current = {
          seek: (seconds: number) => { art.seek = seconds; },
          seekRelative: (delta: number) => { art.seek = Math.max(0, art.currentTime + delta); },
          switchSubtitle: (val: string) => {
            const idx = subs.findIndex(s => s.value === val);
            if (idx < 0) return;
            const sub = subs[idx];
            if (sub.value.startsWith("file:")) {
              const subUrl = `http://127.0.0.1:${port}/api/subtitle/${infoHash}/${sub.fileIndex}`;
              art.subtitle.load(subUrl, { name: sub.label });
            } else if (sub.value.startsWith("custom:")) {
              const subUrl = `http://127.0.0.1:${port}${sub.value.replace("custom:", "")}`;
              art.subtitle.load(subUrl, { name: sub.label });
            } else {
              // Embedded subtitle — Artplayer doesn't support embedded track switching
              // for native formats; this requires ffmpeg transcoding
            }
            activeSubRef.current = val;
          },
          switchAudio: (_streamIndex: string | number) => {
            // Audio track switching for native formats requires ffmpeg
            // Artplayer only supports external audio tracks
          },
          switchSource: handleSwitchSource,
          nextEpisode: handleNextEpisode,
        };
      }
    }).catch((e) => console.error("[Player] Failed to load Artplayer:", e));

    return () => {
      cancelled = true;
      if (artRef.current) {
        artRef.current.destroy();
        artRef.current = null;
      }
    };
  }, [infoHash, fileIndex]);

  // ── Load/reload subtitle when activeSub changes ──
  useEffect(() => {
    const art = artRef.current;
    if (!art || !activeSub) return;
    const sub = subs.find((s) => s.value === activeSub);
    if (!sub) return;
    const p = window.location.port || "3000";
    if (sub.value.startsWith("file:")) {
      const subUrl = `http://127.0.0.1:${p}/api/subtitle/${infoHash}/${sub.fileIndex}`;
      art.subtitle.load(subUrl, { name: sub.label, escape: false });
    } else if (sub.value.startsWith("custom:")) {
      const subUrl = `http://127.0.0.1:${p}${sub.value.replace("custom:", "")}`;
      art.subtitle.load(subUrl, { name: sub.label, escape: false });
    }
  }, [activeSub]);

  // ── Watch history progress reporting ──
  reportProgressRef.current = () => {
    const time = effectiveTimeRef.current;
    if (!time || !state?.tmdbId) return;
    const tmdbId = Number(state.tmdbId);
    if (isNaN(tmdbId)) return;
    const pos = Math.floor(time.time);
    const dur = Math.floor(time.duration);
    if (pos < 10) return;
    reportWatchProgress({
      tmdbId,
      mediaType: state.type || "movie",
      title: state.baseName || mediaTitle,
      posterPath: state.posterPath ?? null,
      season: state.season != null ? Number(state.season) : undefined,
      episode: state.episode != null ? Number(state.episode) : undefined,
      episodeTitle: state.episodeTitle ?? undefined,
      seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
      seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      position: pos,
      duration: dur,
      imdbId: state.imdbId ?? undefined,
      year: state.year != null ? Number(state.year) : undefined,
    }).catch(() => {});
  };

  // Save progress on unmount
  const savedOnExit = useRef(false);
  const beaconProgressRef = useRef(() => {});
  beaconProgressRef.current = () => {
    if (savedOnExit.current) return;
    const time = effectiveTimeRef.current;
    if (!time || !state?.tmdbId) return;
    const tmdbId = Number(state.tmdbId);
    if (isNaN(tmdbId)) return;
    const pos = Math.floor(time.time);
    if (pos < 10) return;
    const payload = JSON.stringify({
      tmdbId,
      mediaType: state.type || "movie",
      title: state.baseName || mediaTitle,
      posterPath: state.posterPath ?? null,
      season: state.season != null ? Number(state.season) : undefined,
      episode: state.episode != null ? Number(state.episode) : undefined,
      episodeTitle: state.episodeTitle ?? undefined,
      seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
      seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      position: pos,
      duration: Math.floor(time.duration),
      imdbId: state.imdbId ?? undefined,
      year: state.year != null ? Number(state.year) : undefined,
    });
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/watch-history/progress", false);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.send(payload);
    } catch { /* best effort */ }
    savedOnExit.current = true;
  };

  // Save progress, then navigate back
  const goBack = useCallback(() => {
    beaconProgressRef.current();
    navigate(-1);
  }, [navigate]);
  goBackRef.current = goBack;

  // Set window.__lebaWatchState immediately so QML can save progress before bridge.stop()
  useEffect(() => {
    if (!state?.tmdbId) return;
    const tmdbId = Number(state.tmdbId);
    if (isNaN(tmdbId)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__lebaWatchState = {
      tmdbId,
      mediaType: state.type || "movie",
      title: state.baseName || mediaTitle,
      posterPath: state.posterPath ?? null,
      season: state.season != null ? Number(state.season) : undefined,
      episode: state.episode != null ? Number(state.episode) : undefined,
      episodeTitle: state.episodeTitle ?? undefined,
      seasonEpisodeCount: state.seasonEpisodeCount != null ? Number(state.seasonEpisodeCount) : undefined,
      seasonCount: state.seasonCount != null ? Number(state.seasonCount) : undefined,
      position: 0,
      duration: 0,
      imdbId: state.imdbId ?? undefined,
      year: state.year != null ? Number(state.year) : undefined,
    };
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__lebaWatchState = null;
    };
  }, [state, mediaTitle]);

  // Periodic reporting every 30s
  useEffect(() => {
    const interval = setInterval(() => reportProgressRef.current(), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Report on unmount
  useEffect(() => {
    return () => { beaconProgressRef.current(); };
  }, []);

  // Auto-create a new session when remote disconnects during playback
  const hadRemote = useRef(false);
  useEffect(() => {
    if (rcRemoteConnected) {
      hadRemote.current = true;
      return;
    }
    if (!hadRemote.current) return;
    async function ensureSession() {
      if (rcSessionId && rcAuthToken) {
        try {
          const res = await fetch(`/api/rc/session/${rcSessionId}?token=${encodeURIComponent(rcAuthToken)}`);
          if (res.ok) return;
        } catch {}
      }
      try {
        const res = await fetch("/api/rc/session", { method: "POST" });
        const data = await res.json();
        setRcSessionId(data.sessionId);
        setRcAuthToken(data.authToken);
      } catch {}
    }
    ensureSession();
  }, [rcAuthToken, rcRemoteConnected, rcSessionId, setRcAuthToken, setRcSessionId]);

  // Auto-fullscreen when a remote reconnects
  useEffect(() => {
    if (rcRemoteConnected && hadRemote.current) {
      if (!document.fullscreenElement) {
        pageRef.current?.requestFullscreen?.().catch(() => {});
      }
    }
  }, [rcRemoteConnected]);

  // Toast when remote connects/disconnects
  const [remoteToast, setRemoteToast] = useState<string | null>(null);
  const prevRemoteConnected = useRef(rcRemoteConnected);
  useEffect(() => {
    if (rcRemoteConnected && !prevRemoteConnected.current) {
      setRemoteToast("connected");
      const t = setTimeout(() => setRemoteToast(null), 3000);
      return () => clearTimeout(t);
    }
    if (!rcRemoteConnected && prevRemoteConnected.current) {
      setRemoteToast("disconnected");
      const t = setTimeout(() => setRemoteToast(null), 3000);
      return () => clearTimeout(t);
    }
    prevRemoteConnected.current = rcRemoteConnected;
  }, [rcRemoteConnected]);

  // Generate QR code for remote reconnection
  const showReconnectQr = rcSessionId && rcAuthToken && rcQrRequested && !rcRemoteConnected;
  const [reconnectOrigin, setReconnectOrigin] = useState<string | null>(null);
  useEffect(() => {
    if (!showReconnectQr) { setReconnectOrigin(null); return; }
    fetchLanIp()
      .then(({ ip, port }) => setReconnectOrigin(ip ? `http://${ip}:${port}` : window.location.origin))
      .catch(() => setReconnectOrigin(window.location.origin));
  }, [showReconnectQr]);
  const [reconnectQrModules, setReconnectQrModules] = useState<{ total: number; rects: { x: number; y: number }[] } | null>(null);
  useEffect(() => {
    if (!showReconnectQr || !reconnectOrigin) { setReconnectQrModules(null); return; }
    let cancelled = false;
    const url = `${reconnectOrigin}/api/rc/auth?session=${rcSessionId}&token=${rcAuthToken}`;
    import("uqr").then(({ encode }) => {
      if (cancelled) return;
      try {
        const { data, size } = encode(url, { ecc: "L" });
        const mod = 3;
        const margin = 4;
        const total = size * mod + margin * 2;
        const rects: { x: number; y: number }[] = [];
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            if (data[y][x]) {
              rects.push({ x: margin + x * mod, y: margin + y * mod });
            }
          }
        }
        if (!cancelled) setReconnectQrModules({ total, rects });
      } catch { setReconnectQrModules(null); }
    });
    return () => { cancelled = true; };
  }, [showReconnectQr, reconnectOrigin, rcSessionId, rcAuthToken]);

  return (
    <div className="player-page" ref={pageRef}>

      {/* Artplayer container — fills the entire page */}
      {!torrentNotFound && (
        <div
          ref={playerContainerRef}
          className="player-art-container"
        />
      )}

      {/* Torrent not found error */}
      {torrentNotFound && (
        <div className="player-error-overlay">
          <svg viewBox="0 0 24 24" width="64" height="64" fill="var(--red)">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
          </svg>
          <h2>Torrent Not Found</h2>
          <p>This torrent is no longer available on the server. Go back and try a different source.</p>
          <button onClick={() => navigate(-1)}>Go Back</button>
        </div>
      )}

      {remoteToast && (
        <div className={`player-remote-toast ${remoteToast}`} key={remoteToast}>
          <span className="player-remote-toast-dot" />
          {remoteToast === "connected" ? "Remote connected" : "Remote disconnected"}
        </div>
      )}

      {showSkipIntro && introRange && (
        <button
          className="player-skip-intro"
          onClick={(e) => { e.stopPropagation(); handleSkipIntro(); }}
        >
          Skip Intro
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      )}

      {showEpisodes && isTV && (
        <div className="player-sources-overlay" onClick={() => setShowEpisodes(false)}>
          <div className="player-sources-panel" onClick={(e) => e.stopPropagation()}>
            <div className="player-sources-header">
              <h3>Episodes</h3>
              <button className="player-sources-close" onClick={() => setShowEpisodes(false)}>&#10005;</button>
            </div>
            <div className="player-sources-list">
              {loadingEpisodes ? (
                <div className="picker-loading">Loading episodes...</div>
              ) : episodes.length === 0 ? (
                <div className="picker-empty">No episodes found</div>
              ) : (
                episodes.map((ep: any) => {
                  const isCurrent = String(ep.index) === String(fileIndex);
                  const isSwitching = switchingSource === ep.name;
                  // Extract episode number for display
                  const epMatch = ep.name.match(/[Ss](\d{1,2})[Ee](\d{1,3})/i);
                  const epLabel = epMatch ? `S${epMatch[1]}E${epMatch[2]}` : `Ep ${ep.index + 1}`;
                  // Get display name after the episode tag
                  const cleanName = ep.name.replace(/.*[Ss]\d{1,2}[Ee]\d{1,3}[\s._-]*/i, "") || ep.name;
                  return (
                    <button
                      key={ep.index}
                      className={`player-source-item${isCurrent ? " active" : ""}`}
                      onClick={() => handleSwitchEpisode(ep)}
                      disabled={isSwitching}
                    >
                      <div className="player-source-item-main">
                        <span className="player-source-item-name">{epLabel} — {cleanName}</span>
                      </div>
                      <div className="player-source-item-meta">
                        <span className="player-source-size">{formatBytes(ep.length)}</span>
                        {isSwitching && <span className="player-source-switching">Switching...</span>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {showSources && sources.length > 1 && (
        <div className="player-sources-overlay" onClick={() => setShowSources(false)}>
          <div className="player-sources-panel" onClick={(e) => e.stopPropagation()}>
            <div className="player-sources-header">
              <h3>Quality</h3>
              <button className="player-sources-close" onClick={() => setShowSources(false)}>&#10005;</button>
            </div>
            <div className="player-sources-list">
              {Object.entries(qualityGroups).filter(([, group]) => group.length > 0).map(([group, groupSources]) => (
                <div key={group} className="player-sources-group">
                  <div className="player-sources-group-label">{group}</div>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {groupSources.map((s: any) => {
                const isCurrent = s.infoHash === active?.infoHash;
                const isRecommended = sources.length > 0 && s.infoHash === sources[0].infoHash;
                const live = isCurrent ? livePeers[s.infoHash] : null;
                const isSwitching = switchingSource === s.infoHash;
                return (
                  <button
                    key={s.infoHash}
                    className={`player-source-item${isCurrent ? " active" : ""}${isRecommended ? " recommended" : ""}`}
                    onClick={() => handleSwitchSource(s)}
                    disabled={isSwitching}
                  >
                    <div className="player-source-item-main">
                      <span className="player-source-item-name">{s.name}</span>
                      <div className="player-source-item-tags">
                        {isRecommended && !isCurrent && <span className="player-source-tag recommended">Recommended</span>}
                        {isCurrent && <span className="player-source-tag current">Playing</span>}
                        {s.cached && <span className="player-source-tag cached">Cached</span>}
                        {s.seasonPack && <span className="player-source-tag season-pack">Season Pack</span>}
                        {s.tags?.filter((t: string) => t !== "Native").map((t: string) => (
                          <span key={t} className="player-source-tag">{t}</span>
                        ))}
                      </div>
                    </div>
                    <div className="player-source-item-meta">
                      <span className="player-source-provider">{s.source?.toUpperCase()}</span>
                      <span className="player-source-seeds">
                        <span className="player-source-seed-dot" />
                        {live ? live.numPeers : s.seeders}
                        {live && <span className="player-source-seed-label">live</span>}
                      </span>
                      <span className="player-source-size">{formatBytes(s.size)}</span>
                      {isSwitching && <span className="player-source-switching">Switching...</span>}
                    </div>
                  </button>
                );
              })}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showReconnectQr && reconnectQrModules && (
        <div className="player-reconnect-qr-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="player-reconnect-qr-card">
            <div className="player-reconnect-qr-inner">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${reconnectQrModules.total} ${reconnectQrModules.total}`}>
                <rect width={reconnectQrModules.total} height={reconnectQrModules.total} fill="#fff" rx="4" />
                {reconnectQrModules.rects.map((r, i) => (
                  <rect key={i} x={r.x} y={r.y} width="3" height="3" fill="#000" />
                ))}
              </svg>
            </div>
            <span className="player-reconnect-qr-label">Scan to reconnect remote</span>
          </div>
        </div>
      )}


    </div>
  );
}
