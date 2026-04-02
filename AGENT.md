# AGENT.md

This file provides guidance to AI agents (Claude, Sisyphus, etc.) when working with code in this repository.

## Project Overview

Podcast2Markdown is a Next.js application that converts podcast audio files into structured Markdown articles. It uses whisper.cpp for local audio transcription with CUDA acceleration and Minimax for AI-powered article generation.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Node.js (Edge-compatible but uses Node.js for file system)
- **Database**: Prisma with SQLite (dev) / PostgreSQL (production ready)
- **Styling**: Tailwind CSS
- **Audio Transcription**: whisper.cpp (local, CUDA-accelerated)
- **AI Generation**: Minimax API (MiniMax-M2.7)

## Project Structure

```
src/
├── app/
│   ├── api/              # API Routes
│   │   ├── upload/       # POST /api/upload - Audio file upload
│   │   ├── transcribe/   # POST /api/transcribe - Start transcription task
│   │   ├── task/[taskId]/# GET /api/task/[taskId] - Poll task status
│   │   ├── generate/     # POST /api/generate - Regenerate article
│   │   └── export/[id]/ # GET /api/export/[id] - Download Markdown
│   ├── layout.tsx        # Root layout
│   └── page.tsx          # Home page (upload + result display)
├── lib/
│   ├── prisma.ts         # Prisma client singleton
│   ├── whisper.ts        # whisper.cpp wrapper (Node native addon)
│   ├── minimax.ts        # Minimax API client
│   └── utils.ts          # Utility functions
└── types/
    └── index.ts          # TypeScript type definitions

whisper.cpp/              # whisper.cpp source (git submodule)
├── build/               # Compiled binaries
├── models/              # Model files (*.bin)
└── samples/             # Test audio files

scripts/                  # Build scripts
├── build-whisper.ps1    # Windows build script
└── build-whisper.sh     # Unix build script
```

## Data Model

Prisma schema (`prisma/schema.prisma`):

```prisma
model AudioFile {
  id         String      @id @default(cuid())
  fileName   String
  fileSize   Int
  duration   Int         // Estimated from file size
  format     String
  filePath   String      // Path in uploads/{audioId}/
  status     String      @default("pending")
  transcript Transcript?
}

model Transcript {
  id          String   @id @default(cuid())
  audioFileId String   @unique
  language    String
  fullText    String
  segments    String    // JSON: TranscriptSegment[]
  article     Article?
}

model Article {
  id           String     @id @default(cuid())
  transcriptId String     @unique
  title        String
  content      String     // Markdown content
  summary      String?
  tags         String?    // JSON: string[]
  highlights   String?    // JSON: Highlight[]
}

model Task {
  id        String   @id @default(cuid())
  type      String   // "transcribe"
  status    String   @default("pending") // pending, processing, completed, failed
  progress  Int      @default(0)        // 0-100
  audioId   String?
  result    String?  // JSON: { article, extracted }
  error     String?
}
```

## Processing Flow

```
User uploads audio
    │
    ▼
POST /api/upload
    - Save file to uploads/{audioId}/
    - Create AudioFile record
    │
    ▼
POST /api/transcribe
    - Create Task record
    - Start async processing
    │
    ▼ (async)
whisper.cpp transcribe ──▶ Save Transcript ──▶ Minimax generate ──▶ Save Article
    │                                                              │
    ▼                                                              ▼
Update Task progress                                          Update Task completed
    │
    ▼
GET /api/task/[taskId] (polling)
    - Return status, progress, result
    │
    ▼
Display result / Download Markdown
```

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/upload` | POST | Upload audio file, returns audioId |
| `/api/transcribe` | POST | Start transcription task, returns taskId |
| `/api/task/[taskId]` | GET | Poll task status and progress |
| `/api/generate` | POST | Regenerate article from existing transcript |
| `/api/export/[id]` | GET | Download article as Markdown file |

## Key Files

### src/lib/whisper.ts
- Wraps whisper.cpp via Node.js native addon
- Exports: `init()`, `transcribe()`, `isCudaAvailable()`, `isReady()`
- Uses environment: `WHISPER_MODEL_PATH`, `WHISPER_USE_CUDA`

### src/lib/minimax.ts
- Minimax API client for article generation
- Exports: `generateArticle(transcript)`
- Returns: `{ title, outline, content, tags, highlights, summary }`
- Uses environment: `MINIMAX_API_KEY`, `MINIMAX_API_BASE`

### src/app/api/transcribe/route.ts
- Async task processing
- Progress: 10% → 30% → 60% → 100%
- Error handling via try/catch + Task.error

## Environment Variables

```bash
# Required
MINIMAX_API_KEY=              # Minimax API key
DATABASE_URL=                 # SQLite: "file:./dev.db"

# Optional (with defaults)
WHISPER_MODEL_PATH=           # Default: whisper.cpp/models/ggml-large-v3.bin
WHISPER_USE_CUDA=             # Default: 1 (set to 0 for CPU only)
MINIMAX_API_BASE=             # Default: https://api.minimaxi.com/v1
```

## Common Commands

```bash
# Development
npm run dev                   # Start dev server
npm run build                 # Build production

# Database
npx prisma generate           # Generate Prisma client
npx prisma db push            # Sync schema
npx prisma studio             # Open database GUI

# whisper.cpp
npm run whisper:build         # Build whisper.cpp (Windows)
powershell ./scripts/build-whisper.ps1  # Direct execution

# Native addon (optional, not fully implemented)
npm run build:addon           # Build Node.js native addon
```

## Important Notes

1. **File System Access**: API routes use `export const runtime = "nodejs"` for file system operations

2. **Prisma Singleton**: Client is globally singleton'd in `src/lib/prisma.ts` to prevent connection issues during development

3. **Audio Storage**: Uploaded files stored in `uploads/{audioId}/` directory (not in database)

4. **Async Processing**: Task handling is fire-and-forget with error handling via `.catch()`:
   ```typescript
   processTranscribe(task.id, audioId).catch(err => {
     // Update task status to failed
   });
   ```

5. **whisper.cpp Build**: Requires CMake + MSVC (Windows) or GCC (Linux). CUDA optional but recommended.

6. **Model Files**: First run downloads 1-3GB model. Check file size if loading fails.

7. **Audio Format**: Currently passes raw file to whisper.cpp. Non-WAV formats may need conversion (planned feature).

## Known Issues

- Node.js native addon (`whisper_addon`) is not fully implemented
- Audio format conversion (M4A/MP3 → WAV) not yet implemented
- Duration estimation is file-size based (inaccurate)

## References

- [设计文档](./设计.md) - Chinese design documentation
- [实现文档](./实现.md) - Chinese implementation details  
- [部署指南](./部署.md) - Chinese deployment guide
