import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { poster as posterUrl, skipItem } from "../lib/api";
import "./Rate.css";

interface Movie {
  id: number;
  media_type: string;
  title: string;
  poster_path: string | null;
  release_date?: string;
  first_air_date?: string;
  genres: { id: number; name: string }[];
  vote_average?: number;
}

const LABELS = ["Awful", "Meh", "Good", "Great", "Perfect"];

function genreSimilarity(a: { id: number }[], b: { id: number }[]): number {
  if (!a.length || !b.length) return 0;
  const idsA = new Set(a.map((g) => g.id));
  const intersection = b.filter((g) => idsA.has(g.id)).length;
  const union = new Set([...idsA, ...b.map((g) => g.id)]).size;
  return intersection / union;
}

function reorderByLiked(queue: Movie[], likedMovie: Movie): Movie[] {
  return [...queue].sort((a, b) => {
    const simA = genreSimilarity(a.genres, likedMovie.genres);
    const simB = genreSimilarity(b.genres, likedMovie.genres);
    return simB - simA;
  });
}

function reorderByDisliked(queue: Movie[], dislikedMovie: Movie): Movie[] {
  return [...queue].sort((a, b) => {
    const simA = genreSimilarity(a.genres, dislikedMovie.genres);
    const simB = genreSimilarity(b.genres, dislikedMovie.genres);
    return simA - simB;
  });
}

export default function Rate() {
  const navigate = useNavigate();

  const [items, setItems] = useState<Movie[]>([]);
  const [idx, setIdx] = useState(0);
  const [ratingsCount, setRatingsCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hoveredStar, setHoveredStar] = useState(0);
  const [ratedThisSession, setRatedThisSession] = useState(0);

  const liked = useRef<Movie[]>([]);
  const disliked = useRef<Movie[]>([]);
  const seen = useRef<Set<number>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const ratings = await fetch("/api/ratings").then((r) => r.json()) as any[];
      setRatingsCount(ratings.length);
      for (const r of ratings) seen.current.add(r.tmdbId);

      const data = await fetch(`/api/ratings/queue`).then((r) => r.json()) as any[];
      const movies: Movie[] = [];
      for (const m of data) {
        if (seen.current.has(m.id)) continue;
        seen.current.add(m.id);
        movies.push({
          id: m.id,
          media_type: m.media_type || "movie",
          title: m.title || m.name,
          poster_path: m.poster_path,
          release_date: m.release_date,
          first_air_date: m.first_air_date,
          genres: m.genres ?? [],
          vote_average: m.vote_average,
        });
      }
      setItems(movies);
      setIdx(0);
      liked.current = [];
      disliked.current = [];
      setRatedThisSession(0);
    } catch {
      if (p === 1) setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const advance = (movie: Movie | null, stars: number | null) => {
    if (movie && stars !== null) {
      if (stars >= 4) liked.current.push(movie);
      else if (stars <= 2) disliked.current.push(movie);
    }

    if ((liked.current.length > 0 || disliked.current.length > 0) && items.length > idx + 2) {
      const rest = items.slice(idx + 1);
      let reordered = [...rest];
      for (const d of disliked.current) reordered = reorderByDisliked(reordered, d);
      for (const l of liked.current) reordered = reorderByLiked(reordered, l);
      setItems((prev) => [...prev.slice(0, idx + 1), ...reordered]);
    }

    setIdx((i) => i + 1);
  };

  const handleRate = async (movieId: number, stars: number) => {
    const movie = items[idx];
    await fetch("/api/ratings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdbId: movieId, mediaType: movie.media_type, title: movie.title, posterPath: movie.poster_path, value: stars }),
    });
    setRatingsCount((c) => c + 1);
    setRatedThisSession((c) => c + 1);
    advance(movie, stars);
  };

  const handleSkip = async () => {
    const movie = items[idx];
    await skipItem(movie.id, movie.media_type);
    seen.current.add(movie.id);
    advance(null, null);
  };

  const handleLoadMore = () => {
    load();
  };

  if (loading && items.length === 0) {
    return (
      <div className="rate-page">
        <div className="rate-loading"><div className="rate-spinner" /></div>
      </div>
    );
  }

  if (idx >= items.length) {
    const remaining = 5 - ratedThisSession;
    return (
      <div className="rate-page">
        <div className="rate-done">
          <div className="rate-done-icon"><span className="rate-star-icon">&#11088;</span></div>
          <h2 className="rate-done-title">
            {ratingsCount >= 5 ? "Great start!" : "All caught up!"}
          </h2>
          <p className="rate-done-subtitle">
            {ratingsCount >= 5
              ? "Your taste profile is ready. Check your recommendations."
              : remaining > 0
                ? `Rate ${remaining} more to unlock personalized recommendations.`
                : "Rate more titles to refine your recommendations."}
          </p>
          <div className="rate-done-actions">
            {ratingsCount >= 5 && (
              <>
                <button onClick={() => navigate("/taste")} className="rate-btn rate-btn-primary">View Your Taste</button>
                <button onClick={() => navigate("/")} className="rate-btn rate-btn-secondary">See Recommendations</button>
              </>
            )}
            <button onClick={handleLoadMore} disabled={loading} className="rate-btn rate-btn-outline">
              {loading ? "Loading..." : "Load More"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const movie = items[idx];

  return (
    <div className="rate-page">
      <div className="rate-container">
        <div className="rate-progress">
          <div className="rate-progress-header">
            <span className="rate-progress-label">Rate titles you've seen</span>
            <span className="rate-progress-count">{ratingsCount} rated</span>
          </div>
          <div className="rate-progress-bar">
            <div className="rate-progress-fill" style={{ width: `${Math.min((ratedThisSession / 5) * 100, 100)}%` }} />
          </div>
          {ratedThisSession < 5 && (
            <p className="rate-progress-hint">Rate {5 - ratedThisSession} more to unlock insights</p>
          )}
        </div>

        <div className="rate-card">
          <div className="rate-card-poster">
            {movie.poster_path ? (
              <img src={posterUrl(movie.poster_path)} alt={movie.title} className="rate-card-img" />
            ) : (
              <div className="rate-card-placeholder">{movie.title}</div>
            )}
          </div>
          <div className="rate-card-body">
            <h2 className="rate-card-title">{movie.title}</h2>
            <p className="rate-card-meta">
              {(movie.release_date || movie.first_air_date || "").slice(0, 4)}
              {movie.vote_average ? ` \u00b7 ${movie.vote_average.toFixed(1)}` : ""}
            </p>
            <div className="rate-card-genres">
              {movie.genres.slice(0, 4).map((g) => (
                <span key={g.id} className="rate-genre-tag">{g.name}</span>
              ))}
            </div>
          </div>
          <div className="rate-card-stars">
            <p className="rate-stars-label">Rate this {movie.media_type === "tv" ? "show" : "movie"}</p>
            <div className="rate-stars">
              {[1, 2, 3, 4, 5].map((star) => (
                <button
                  key={star}
                  onClick={() => handleRate(movie.id, star)}
                  onMouseEnter={() => setHoveredStar(star)}
                  onMouseLeave={() => setHoveredStar(0)}
                  className={`rate-star-btn ${star <= hoveredStar ? "rate-star-active" : ""}`}
                >
                  &#9733;
                </button>
              ))}
              <span className="rate-star-label">{hoveredStar > 0 ? LABELS[hoveredStar - 1] : ""}</span>
            </div>
          </div>
          <div className="rate-card-actions">
            <button onClick={handleSkip} className="rate-btn rate-btn-ghost">Haven't Seen</button>
            <button onClick={() => navigate(`/${movie.media_type}/${movie.id}`)} className="rate-btn rate-btn-details">Details</button>
          </div>
        </div>
      </div>
    </div>
  );
}
