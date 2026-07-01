import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchProfile, poster } from "../lib/api";
import "./Taste.css";

interface GenreStat {
  id: number; name: string; weight: number;
}

interface KeywordStat {
  id: number; name: string; weight: number;
}

interface CastStat {
  tmdbId: number; name: string; weight: number;
}

interface DecadeStat {
  decade: number; count: number;
}

interface RatedMovie {
  id: number; title: string; posterPath: string | null;
  year: number | null; mediaType: string; value: number;
}

interface ProfileData {
  totalRatings: number;
  genres: GenreStat[];
  keywords: KeywordStat[];
  directors: CastStat[];
  actors: CastStat[];
  decades: DecadeStat[];
  distribution: number[];
  ratings: RatedMovie[];
}

export default function Taste() {
  const navigate = useNavigate();
  const [data, setData] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProfile()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="taste-page">
        <div className="taste-loading">
          <div className="taste-spinner" />
        </div>
      </div>
    );
  }

  if (!data || data.totalRatings === 0) {
    return (
      <div className="taste-page">
        <div className="taste-empty">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="var(--text-muted)" strokeWidth="1.5">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
          </svg>
          <p>No ratings yet.</p>
          <p className="taste-empty-sub">Rate some movies to build your taste profile.</p>
          <button onClick={() => navigate("/rate")} className="taste-rate-btn">Rate Movies</button>
        </div>
      </div>
    );
  }

  const maxGenreWeight = Math.max(...data.genres.map((g) => g.weight), 1);
  const maxKeywordWeight = Math.max(...data.keywords.map((k) => k.weight), 1);
  const maxDirectorWeight = Math.max(...data.directors.map((d) => d.weight), 1);
  const maxActorWeight = Math.max(...data.actors.map((a) => a.weight), 1);
  const maxDecadeCount = Math.max(...data.decades.map((d) => d.count), 1);

  const topGenre = data.genres[0]?.name ?? "";
  const topDecade = [...data.decades].sort((a, b) => b.count - a.count)[0]?.decade ?? 0;
  const avgRating = data.distribution.reduce((sum, c, i) => sum + c * (i + 1), 0) / data.totalRatings;
  const likesDistribution = data.distribution.slice(3).reduce((a, b) => a + b, 0);
  const likesPct = Math.round((likesDistribution / data.totalRatings) * 100);

  return (
    <div className="taste-page">
      <div className="taste-container">
        <div className="taste-header">
          <h1>Your Taste Profile</h1>
          <p>Based on {data.totalRatings} rating{data.totalRatings !== 1 ? "s" : ""}</p>
        </div>

        <div className="taste-stats">
          <div className="taste-stat">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--star-color, #f5c518)" stroke="none">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
            </svg>
            <span className="taste-stat-label">Avg Rating</span>
            <span className="taste-stat-value">{avgRating.toFixed(1)}</span>
          </div>
          <div className="taste-stat">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="var(--green, #4ade80)" stroke="none">
              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" stroke="var(--green, #4ade80)" strokeWidth="2" fill="none" />
              <polyline points="17 6 23 6 23 12" stroke="var(--green, #4ade80)" strokeWidth="2" fill="none" />
            </svg>
            <span className="taste-stat-label">Like Rate</span>
            <span className="taste-stat-value">{likesPct}%</span>
          </div>
          <div className="taste-stat">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--accent)" strokeWidth="2">
              <rect x="2" y="2" width="20" height="20" rx="2.18" />
              <path d="M7 8h10M7 12h10M7 16h6" />
            </svg>
            <span className="taste-stat-label">Top Genre</span>
            <span className="taste-stat-value taste-stat-value-sm">{topGenre || "\u2014"}</span>
          </div>
          <div className="taste-stat">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--blue, #60a5fa)" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M3 10h18M8 2v4M16 2v4" />
            </svg>
            <span className="taste-stat-label">Favorite Era</span>
            <span className="taste-stat-value">{topDecade}s</span>
          </div>
        </div>

        <section className="taste-section">
          <h2>Genre Preferences</h2>
          <div className="taste-bars">
            {data.genres.slice(0, 8).map((g) => (
              <div key={g.id} className="taste-bar-row">
                <span className="taste-bar-label">{g.name}</span>
                <div className="taste-bar-track">
                  <div className="taste-bar-fill" style={{ width: `${(g.weight / maxGenreWeight) * 100}%` }} />
                </div>
                <span className="taste-bar-value">{g.weight.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </section>

        {data.keywords.length > 0 && (
          <section className="taste-section">
            <h2>Favorite Keywords</h2>
            <div className="taste-tags">
              {data.keywords.slice(0, 15).map((kw) => (
                <span key={kw.id} className="taste-tag">{kw.name}</span>
              ))}
            </div>
          </section>
        )}

        {data.directors.length > 0 && (
          <section className="taste-section">
            <h2>Favorite Directors</h2>
            <div className="taste-bars">
              {data.directors.map((p) => (
                <div key={p.tmdbId} className="taste-bar-row">
                  <span className="taste-bar-label">{p.name}</span>
                  <div className="taste-bar-track">
                    <div className="taste-bar-fill taste-bar-fill-green" style={{ width: `${(p.weight / maxDirectorWeight) * 100}%` }} />
                  </div>
                  <span className="taste-bar-value">{p.weight.toFixed(0)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {data.actors.length > 0 && (
          <section className="taste-section">
            <h2>Favorite Actors</h2>
            <div className="taste-bars">
              {data.actors.map((p) => (
                <div key={p.tmdbId} className="taste-bar-row">
                  <span className="taste-bar-label">{p.name}</span>
                  <div className="taste-bar-track">
                    <div className="taste-bar-fill taste-bar-fill-green" style={{ width: `${(p.weight / maxActorWeight) * 100}%` }} />
                  </div>
                  <span className="taste-bar-value">{p.weight.toFixed(0)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="taste-section">
          <h2>Decade Distribution</h2>
          <div className="taste-decade-chart">
            {data.decades.map((d) => (
              <div key={d.decade} className="taste-decade-col">
                <div className="taste-decade-bar" style={{ height: `${(d.count / maxDecadeCount) * 100}%`, minHeight: 4 }} />
                <span className="taste-decade-label">{d.decade}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="taste-section">
          <h2>Rating Distribution</h2>
          <div className="taste-decade-chart">
            {data.distribution.map((count, i) => {
              const max = Math.max(...data.distribution, 1);
              return (
                <div key={i} className="taste-decade-col">
                  <div
                    className={`taste-decade-bar ${i >= 3 ? "taste-bar-fill" : ""}`}
                    style={{ height: `${(count / max) * 100}%`, minHeight: 4 }}
                  />
                  <span className="taste-decade-label">{i + 1}★</span>
                  <span className="taste-decade-count">{count}</span>
                </div>
              );
            })}
          </div>
        </section>

        <section className="taste-section">
          <h2>Your Ratings</h2>
          <div className="taste-ratings-list">
            {data.ratings.map((r) => (
              <div key={r.id} className="taste-rating-row" onClick={() => navigate(`/${r.mediaType}/${r.id}`)}>
                <div className="taste-rating-poster">
                  {r.posterPath ? (
                    <img src={poster(r.posterPath)} alt={r.title} />
                  ) : (
                    <div className="taste-rating-placeholder" />
                  )}
                </div>
                <div className="taste-rating-info">
                  <p className="taste-rating-title">{r.title}</p>
                  <p className="taste-rating-meta">{r.year}{r.mediaType === "tv" ? " \u00b7 TV" : ""}</p>
                </div>
                <div className="taste-rating-stars">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <svg key={s} viewBox="0 0 24 24" width="12" height="12" className={s <= r.value ? "taste-star-filled" : "taste-star-empty"}>
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26" />
                    </svg>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
