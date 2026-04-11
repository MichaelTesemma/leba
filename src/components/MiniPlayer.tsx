import { useRef, useEffect, useCallback, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { usePlayer } from "../lib/PlayerContext";
import { formatTime } from "../lib/utils";
import "./MiniPlayer.css";

export default function MiniPlayer() {
  const { active, currentTime, duration, stopStream } = usePlayer();
  const navigate = useNavigate();
  const location = useLocation();

  // Track previous active identity — only re-render when it changes
  const prevActiveRef = useRef(active);
  const [stableActive, setStableActive] = useState(active);
  const timeRef = useRef({ currentTime, duration });
  timeRef.current = { currentTime, duration };

  // Sync stableActive only when active identity changes
  if (active !== prevActiveRef.current) {
    prevActiveRef.current = active;
    setStableActive(active);
  }

  const isOnPlayerPage = location.pathname.startsWith("/play/");

  const activeForRender = stableActive;
  if (!activeForRender || isOnPlayerPage) return null;

  function resume() {
    navigate(`/play/${activeForRender.infoHash}/${activeForRender.fileIndex}`, {
      state: { tags: activeForRender.tags, title: activeForRender.title, debridStreamKey: activeForRender.debridStreamKey },
    });
  }

  // Throttled time display — update progress bar directly via DOM to avoid re-renders
  const progressRef = useRef<HTMLDivElement>(null);
  const timeDisplayRef = useRef<HTMLSpanElement>(null);

  const updateDisplay = useCallback(() => {
    const { currentTime: ct, duration: dur } = timeRef.current;
    const pct = dur > 0 ? (ct / dur) * 100 : 0;
    if (progressRef.current) {
      progressRef.current.style.width = `${pct}%`;
    }
    if (timeDisplayRef.current) {
      timeDisplayRef.current.textContent = `${formatTime(ct)} / ${formatTime(dur)}`;
    }
  }, []);

  useEffect(() => {
    const id = setInterval(updateDisplay, 1000);
    updateDisplay(); // initial
    return () => clearInterval(id);
  }, [updateDisplay]);

  return (
    <div className="mini-player">
      <div className="mini-player-info">
        <span className="mini-player-title">{activeForRender.title || "Playing"}</span>
        <span className="mini-player-time" ref={timeDisplayRef}>
          {formatTime(timeRef.current.currentTime)} / {formatTime(timeRef.current.duration)}
        </span>
        <div className="mini-player-progress">
          <div ref={progressRef} className="mini-player-progress-bar" style={{ width: "0%" }} />
        </div>
      </div>
      <div className="mini-player-controls">
        <button onClick={resume} className="mini-player-btn" title="Resume">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </button>
        <button onClick={stopStream} className="mini-player-btn" title="Close">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
