import { useState, useEffect } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { usePlayer, useRemoteMode } from "../lib/PlayerContext";
import { getVpnStatus, toggleVpn, playTorrent } from "../lib/api";
import { parseMagnet } from "../lib/magnet";
import "./Navbar.css";

export default function Navbar() {
  const [query, setQuery] = useState("");
  const [scrolled, setScrolled] = useState(false);
  const [vpn, setVpn] = useState<{ active: boolean; configured: boolean } | null>(null);
  const [vpnToggling, setVpnToggling] = useState(false);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { isRemote } = useRemoteMode();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (location.pathname === "/search") setQuery(params.get("q") || "");
  }, [location]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // VPN status polling — only poll continuously when configured, otherwise check once
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    const poll = () => getVpnStatus().then((s) => {
      if (!mounted) return;
      setVpn(s);
      if (!s.configured && timer) {
        clearInterval(timer);
        timer = null;
      }
    }).catch(() => {});

    poll();
    timer = setInterval(poll, 10000);
    return () => { mounted = false; if (timer) clearInterval(timer); };
  }, []);

  async function handleVpnToggle() {
    if (!vpn?.configured || vpnToggling) return;
    setVpnToggling(true);
    try {
      await toggleVpn(vpn.active ? "off" : "on");
      const start = Date.now();
      const check = async () => {
        if (Date.now() - start > 15000) { setVpnToggling(false); return; }
        try {
          const s = await getVpnStatus();
          setVpn(s);
          setVpnToggling(false);
        } catch {
          setTimeout(check, 1000);
        }
      };
      setTimeout(check, 2000);
    } catch {
      setVpnToggling(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    const trimmed = query.trim();
    if (!trimmed) return;

    const magnet = parseMagnet(trimmed);
    if (magnet) {
      setLoading(true);
      try {
        const result = await playTorrent(magnet.infoHash, magnet.name);
        navigate(`/play/${result.infoHash}/${result.fileIndex}`, {
          state: {
            title: magnet.name,
            posterPath: null,
            sources: [],
            tags: result.tags ?? [],
          },
        });
      } catch {
        // silently ignore — magnet play is best-effort
      } finally {
        setLoading(false);
      }
      return;
    }

    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
  }

  return (
    <nav className={`navbar ${scrolled ? "scrolled" : ""} ${isRemote ? "navbar-remote" : ""}`}>
      <Link to="/" className="navbar-brand">
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect x="2" y="2" width="28" height="28" rx="6" stroke="var(--accent)" strokeWidth="1.5" />
          <text x="16" y="16" textAnchor="middle" dominantBaseline="central" fontFamily="Georgia,serif" fontSize="18" fontWeight="700" fill="var(--accent-bright)">L</text>
        </svg>
        <span>leba</span>
      </Link>
      {location.pathname !== "/rate" && location.pathname !== "/taste" && (
        <form className="navbar-search" onSubmit={handleSubmit}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--text-muted)">
            <path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            type="text"
            placeholder="Search movies & shows..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={loading}
          />
        </form>
      )}
      {!isRemote && (
        <>
          {vpn?.configured && (
            <button
              className={`navbar-vpn-pill ${vpn.active ? "active" : ""} ${vpnToggling ? "toggling" : ""}`}
              onClick={handleVpnToggle}
              disabled={vpnToggling}
              title={vpnToggling ? "Connecting..." : vpn.active ? "VPN Protected" : "VPN Off"}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
              </svg>
              <span>{vpnToggling ? "..." : vpn.active ? "On" : "Off"}</span>
            </button>
          )}
          <div className="navbar-actions">
            <Link to="/taste" className={`navbar-list-btn${location.pathname === "/taste" ? " active" : ""}`} title="My Taste">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
              </svg>
              <span>Taste</span>
            </Link>
            <Link to="/rate" className={`navbar-list-btn${location.pathname === "/rate" ? " active" : ""}`} title="Rate Movies">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
              </svg>
              <span>Rate</span>
            </Link>
            <Link to="/my-list" className={`navbar-list-btn${location.pathname === "/my-list" ? " active" : ""}`} title="My List">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
              </svg>
              <span>My List</span>
            </Link>
          </div>
        </>
      )}
    </nav>
  );
}
