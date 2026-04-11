# Leba

Stream movies and TV shows via torrents.

## Features

- 🎬 Stream movies and TV shows via torrents
- 📺 Built-in video player
- 🔍 Search with TMDB integration
- 🖥️ Cross-platform desktop app (macOS, Windows)

## Tech Stack

- **Frontend:** React, Vite, TypeScript
- **Backend:** Node.js, Express
- **Desktop:** Electron
- **Streaming:** WebTorrent

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Installation

```bash
npm install
```

### Configuration

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Get a free TMDB API key from [themoviedb.org](https://www.themoviedb.org/settings/api) and add it to `.env`:

```
TMDB_API_KEY=your_api_key_here
```

### Development

```bash
# Start dev server
npm run dev

# Start with Electron
npm run electron:dev
```

### Build

```bash
# Build for production
npm run build

# Package as desktop app
npm run electron:build

# macOS only
npm run electron:build:mac

# Windows only
npm run electron:build:win
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TMDB_API_KEY` | The Movie Database API key |

## License

GPL-3.0-only
