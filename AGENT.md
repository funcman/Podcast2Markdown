# AGENT.md

This file provides guidance to AI agents (Claude, Sisyphus, etc.) when working with code in this repository.

## Project Overview

Podcast2Markdown is a Next.js application that converts podcast audio files into structured Markdown articles. It uses whisper.cpp for local audio transcription with CUDA acceleration and Minimax for AI-powered article generation.

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Runtime**: Node.js (uses Node.js runtime for file system operations)
- **Database**: Prisma with SQLite (dev) / PostgreSQL (production ready)
- **Styling**: Tailwind CSS
- **Audio Processing**: fluent-ffmpeg (system ffmpeg required)
- **Audio Transcription**: whisper.cpp (local, CUDA-accelerated, via spawn subprocess)
- **AI Generation**: Minimax API (MiniMax-M2.7)

## Project Structure

```
src/
├── app/
│   ├── api/              # API Routes
│   │   ├── upload/       # POST /api/upload - Audio file upload
│   │   ├── transcribe/   # POST /api/transcribe - Start transcription task
│   │   ├── task/[taskId]/# GET /api/task/[taskId] - Poll task status
│   │   ├── audio/[audioId]/  # GET /api/audio/[audioId] - Get audio info
│   │   ├── generate/     # POST /api/generate - Regenerate article
│   │   └── export/[id]/ # GET /api/export/[id] - Download Markdown
│   ├── layout.tsx        # Root layout
│   └── page.tsx          # Home page (upload + result display)
├── lib/
│   ├── prisma.ts         # Prisma client singleton
│   ├── whisper.ts        # whisper.cpp wrapper (subprocess spawn)
│   ├── minimax.ts        # Minimax API client
│   ├── audio-converter.ts # FFmpeg audio conversion utilities
│   └── utils.ts          # Utility functions
└── types/
    └── index.ts          # TypeScript type definitions

whisper.cpp/              # whisper.cpp source (git submodule or manual clone)
├── build/bin/           # Compiled binaries (main.exe / main)
├── models/              # Model files (*.bin)
└── samples/             # Test audio files

scripts/                  # Build scripts
├── build-whisper.ps1    # Windows build script
└── build-whisper.sh     # Unix build script

uploads/                  # Audio file storage (generated at runtime)
└── {audioId}/
    ├── original.{ext}   # Original uploaded file
    └── converted.wav    # Converted WAV format for whisper
```

## Data Model

Prisma schema (`prisma/schema.prisma`):

```prisma
model AudioFile {
  id            String      @id @default(cuid())
  fileName      String      // Original filename
  fileSize      Int         // Bytes
  duration      Int?        // Seconds (accurate, from ffprobe)
  format        String      // Original format (mp3, m4a, etc.)
  originalPath  String      // Path to original file
  filePath      String      // Path to converted WAV file
  status        String      @default("pending")
                // pending -> converting -> ready -> transcribing -> completed/failed
  transcript    Transcript?
  tasks         Task[]
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt
}

model Transcript {
  id          String   @id @default(cuid())
  audioFileId String   @unique
  language    String
  fullText    String   // Complete transcript text
  segments    String   // JSON: TranscriptSegment[]
  article     Article?
  createdAt   DateTime @default(now())
}

model Article {
  id           String     @id @default(cuid())
  transcriptId String     @unique
  title        String
  content      String     // Markdown content
  summary      String?    // Brief summary
  tags         String?    // JSON: string[]
  highlights   String?    // JSON: Highlight[]
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
}

model Task {
  id        String    @id @default(cuid())
  type      String    // "transcribe"
  status    String    @default("pending")
            // pending, processing, completed, failed
  progress  Int       @default(0)  // 0-100
  audioId   String?
  audioFile AudioFile? @relation(fields: [audioId], references: [id])
  result    String?   // JSON: { article, extracted }
  error     String?   // Error message if failed
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

## Processing Flow

```
User uploads audio (MP3/M4A/OGG/FLAC/WAV)
    │
    ▼
POST /api/upload
    - Save file to uploads/{audioId}/original.{ext}
    - Create AudioFile record (status: pending)
    - Return audioId
    │
    ▼
POST /api/transcribe
    - Create Task record
    - Start async processing
    │
    ▼ (async processing)
┌─────────────────┐
│  FFmpeg Convert │  (if not WAV)
│  MP3/M4A → WAV  │  status: converting → ready
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  whisper.cpp    │  status: transcribing
│  Transcribe     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Save Transcript │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Minimax API     │  status: processing (60%-80%)
│ Generate Article│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Save Article   │  status: completed (100%)
│  Update Task    │
└─────────────────┘
    │
    ▼
GET /api/task/[taskId] (polling every 2s)
    - Return status, progress, result
    │
    ▼
Display result / Download Markdown
```

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/api/upload` | POST | Upload audio file (multipart/form-data), returns audioId |
| `/api/transcribe` | POST | Start transcription task (body: { audioId }), returns taskId |
| `/api/task/[taskId]` | GET | Poll task status, progress, and result |
| `/api/audio/[audioId]` | GET | Get audio file info and status |
| `/api/generate` | POST | Regenerate article from existing transcript |
| `/api/export/[id]` | GET | Download article as Markdown file |

## Key Files

### src/lib/audio-converter.ts
- FFmpeg wrapper for audio format conversion
- Exports: `convertToWav()`, `getAudioInfo()`, `isFfmpegInstalled()`
- Converts various formats (MP3, M4A, OGG, FLAC) to WAV (16kHz, 16-bit, mono)
- Uses fluent-ffmpeg to call system ffmpeg

### src/lib/whisper.ts
- Wraps whisper.cpp via subprocess spawn (not native addon)
- Exports: `init()`, `transcribe()`, `isCudaAvailable()`, `isReady()`
- Spawns whisper.cpp binary with args: `-m model -f audio.wav -l zh -oj -of output`
- Parses JSON output from whisper.cpp (field: `transcription`, not `segments`)
- Uses environment: `WHISPER_MODEL_PATH`, `WHISPER_USE_CUDA`
- JSON output structure:
  ```json
  {
    "transcription": [
      {
        "timestamps": { "from": "00:00:00,020", "to": "00:00:08,880" },
        "offsets": { "from": 20, "to": 8880 },
        "text": "大家好"
      }
    ]
  }
  ```

### src/lib/minimax.ts
- Minimax API client for article generation
- Exports: `generateArticle(transcript)`
- Returns: `{ title, content, tags, highlights, summary }`
- Uses environment: `MINIMAX_API_KEY`, `MINIMAX_API_BASE`

### src/app/api/transcribe/route.ts
- Async task processing with progress tracking
- Progress stages: 10% (start) → 30% (converting) → 60% (transcribing) → 80% (generating) → 100% (completed)
- Error handling via try/catch + Task.error update

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
npm run dev                   # Start dev server on http://localhost:3000
npm run build                 # Build production version

# Database
npx prisma generate           # Generate Prisma client
npx prisma db push            # Sync schema with database
npx prisma studio             # Open database GUI

# whisper.cpp
npm run whisper:build         # Build whisper.cpp (Windows PowerShell)
powershell ./scripts/build-whisper.ps1  # Direct execution with model download

# FFmpeg (required for audio conversion)
# Windows: winget install Gyan.FFmpeg
# macOS: brew install ffmpeg
# Ubuntu: sudo apt install ffmpeg
```

## Important Notes

1. **File System Access**: API routes use `export const runtime = "nodejs"` for file system operations

2. **Prisma Singleton**: Client is globally singleton'd in `src/lib/prisma.ts` to prevent connection issues during development

3. **Audio Storage**: Files stored in `uploads/{audioId}/` directory (not in database blob)

4. **Async Processing**: Task handling is fire-and-forget with error handling:
   ```typescript
   processTranscribe(task.id, audioId).catch(err => {
     // Update task status to failed
   });
   ```

5. **whisper.cpp Build**: Requires CMake + MSVC (Windows) or GCC (Linux). CUDA optional but recommended for speed.

6. **Model Files**: First run downloads 1-3GB model. Verify file size if loading fails:
   - large-v3: ~3.1GB
   - medium: ~1.5GB
   - small: ~466MB
   - base: ~142MB

7. **Audio Format**: Non-WAV formats are automatically converted using FFmpeg before transcription

8. **Whisper JSON Format**: Code expects `result.transcription` array with `offsets.from/to` (milliseconds) and `text` fields, not `result.segments`

## Troubleshooting

### Whisper returns 0 segments
- Check JSON field name: should be `transcription`, not `segments`
- Check time format: `offsets.from/to` are in milliseconds, divide by 1000 for seconds
- See `src/lib/whisper.ts` for correct parsing logic

### FFmpeg not found
- Install FFmpeg: `winget install Gyan.FFmpeg` (Windows)
- Verify: `ffmpeg -version`

### Upload returns 400
- Check body size limit in `next.config.mjs` (default increased to 50mb)
- Check if file field name is "file" in multipart form

## References

- [README.md](./README.md) - Project overview and quick start
- [设计.md](./设计.md) - Chinese design documentation
- [实现.md](./实现.md) - Chinese implementation details
- [部署.md](./部署.md) - Chinese deployment guide
- [调研.md](./docs/archive/调研.md) - Archived research notes (if moved)
