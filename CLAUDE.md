# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Podcast2Markdown is a Next.js application that converts podcast audio files into structured Markdown articles. It uses Whisper for audio transcription and Minimax for AI-powered article generation.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Database**: Prisma with SQLite
- **Styling**: Tailwind CSS
- **APIs**: Whisper (transcription), Minimax (article generation)

## Common Commands

```bash
npm install          # Install dependencies
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Build production version
npm run lint         # Run ESLint

npx prisma generate  # Generate Prisma client
npx prisma db push   # Sync database schema
npx prisma studio    # Open database GUI
```

## Data Model

The core entities are `AudioFile` → `Transcript` → `Article`, connected via 1:1 relations. A `Task` entity tracks async operations (transcription/generation).

```
AudioFile ──1:1── Transcript ──1:1── Article
   │                                   │
   └── Task (async processing) ───────┘
```

## Processing Flow

1. **Upload** (`POST /api/upload`) - Accepts audio file, saves to `uploads/{audioId}/`, creates AudioFile record
2. **Transcribe** (`POST /api/transcribe`) - Creates a Task, then asynchronously:
   - Calls Whisper API to transcribe audio
   - Saves Transcript record
   - Calls Minimax API to generate article
   - Saves Article record
3. **Task Status** (`GET /api/task/[taskId]`) - Poll for task progress and result
4. **Generate** (`POST /api/generate`) - Regenerates article from existing transcript
5. **Export** (`GET /api/export/[id]`) - Downloads article as Markdown file

## Environment Variables

```bash
WHISPER_API_KEY=       # Lingya Whisper API key
WHISPER_API_BASE=      # Whisper API base URL
MINIMAX_API_KEY=       # Minimax API key
MINIMAX_API_BASE=      # Minimax API base URL
DATABASE_URL=          # SQLite path (e.g., "file:./dev.db")
```

## Architecture Notes

- API routes use `export const runtime = "nodejs"` for file system access
- Prisma client is globally singleton'd to prevent connection issues in dev
- Uploaded audio files are stored locally in `uploads/` directory (not in DB)
- Task processing is fire-and-forget with error handling via `.catch()`
