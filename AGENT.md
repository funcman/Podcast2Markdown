# AGENT.md

本文件为 AI 助手（Claude、Sisyphus 等）在处理本项目代码时提供指导。

## 项目概述

Podcast2Markdown 是一个将播客音频转换为结构化 Markdown 文章的 Next.js 应用。使用 whisper.cpp 进行本地音频转录（CUDA 加速），并通过 OpenAI 兼容的 LLM API（火山引擎方舟 Coding Plan 或 Minimax）生成文章。

## 技术栈

- **框架**: Next.js 14 (App Router)
- **运行时**: Node.js（API 路由使用 Node.js runtime 以访问文件系统）
- **数据库**: Prisma + SQLite（开发）/ PostgreSQL（生产可用）
- **样式**: Tailwind CSS
- **音频处理**: fluent-ffmpeg（需系统安装 ffmpeg）
- **音频转录**: whisper.cpp（本地运行，CUDA 加速，通过 subprocess spawn 调用）
- **文章生成**: 火山引擎方舟 Coding Plan（配置 `ARK_PLAN_API_KEY` 时默认使用）或 Minimax，均通过 OpenAI 兼容的 `POST {baseURL}/chat/completions` 调用

## 项目结构

```
src/
├── app/
│   ├── api/              # API 路由
│   │   ├── upload/       # POST /api/upload - 上传音频文件
│   │   ├── transcribe/   # POST /api/transcribe - 提交转录任务
│   │   ├── task/[taskId]/# GET /api/task/[taskId] - 轮询任务状态
│   │   ├── audio/[audioId]/  # GET /api/audio/[audioId] - 获取音频信息
│   │   ├── generate/     # POST /api/generate - 重新生成文章
│   │   └── export/[id]/ # GET /api/export/[id] - 下载 Markdown
│   ├── layout.tsx        # 根布局
│   └── page.tsx          # 首页（上传 + 结果展示）
├── lib/
│   ├── prisma.ts         # Prisma 客户端单例
│   ├── whisper.ts        # whisper.cpp 封装（subprocess spawn）
│   ├── openai-compatible.ts # 共享的 OpenAI 兼容流式调用引擎
│   ├── providers.ts      # Provider 选择 + 统一的 generateArticle()
│   ├── ark.ts            # 火山引擎方舟 Coding Plan 客户端
│   ├── minimax.ts        # Minimax API 客户端
│   ├── audio-converter.ts # FFmpeg 音频转换工具
│   └── utils.ts          # 工具函数
└── types/
    └── index.ts          # TypeScript 类型定义

whisper.cpp/              # whisper.cpp 源码
├── build/bin/           # 编译后的二进制（main.exe / main）
├── models/              # 模型文件（*.bin）
└── samples/             # 测试音频文件

scripts/                  # 构建脚本
├── build-whisper.ps1    # Windows 构建脚本
└── build-whisper.sh     # Unix 构建脚本

uploads/                  # 音频文件存储（运行时生成）
└── {audioId}/
    ├── original.{ext}   # 原始上传文件
    └── converted.wav    # 转换为 whisper 需要的 WAV 格式
```

## 数据模型

Prisma schema（`prisma/schema.prisma`）：

```prisma
model AudioFile {
  id            String      @id @default(cuid())
  fileName      String      // 原始文件名
  fileSize      Int         // 字节数
  duration      Int?        // 时长（秒，ffprobe 获取的精确值）
  format        String      // 原始格式（mp3、m4a 等）
  originalPath  String      // 原始文件路径
  filePath      String      // 转换后 WAV 文件路径
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
  fullText    String   // 完整转录文本
  segments    String   // JSON: TranscriptSegment[]
  article     Article?
  createdAt   DateTime @default(now())
}

model Article {
  id           String     @id @default(cuid())
  transcriptId String     @unique
  title        String
  content      String     // Markdown 内容
  summary      String?    // 摘要
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
  error     String?   // 失败时的错误信息
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}
```

## 处理流程

```
用户上传音频（MP3/M4A/OGG/FLAC/WAV）
    │
    ▼
POST /api/upload
    - 保存文件到 uploads/{audioId}/original.{ext}
    - 创建 AudioFile 记录（status: pending）
    - 返回 audioId
    │
    ▼
POST /api/transcribe
    - 创建 Task 记录
    - 启动异步处理
    │
    ▼（异步处理）
┌─────────────────┐
│  FFmpeg 转换    │（非 WAV 时）
│  MP3/M4A → WAV │  status: converting → ready
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  whisper.cpp    │  status: transcribing
│  转录           │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 保存 Transcript  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ AI Provider      │  status: generating (80%-100%)
│ 方舟/Minimax    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 保存 Article     │  status: completed (100%)
│ 更新 Task        │
└─────────────────┘
    │
    ▼
GET /api/task/[taskId]（每 2s 轮询）
    - 返回 status、progress、result
    │
    ▼
展示结果 / 下载 Markdown
```

## API 路由

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/upload` | POST | 上传音频文件（multipart/form-data），返回 audioId |
| `/api/transcribe` | POST | 启动转录任务（body: { audioId }），返回 taskId |
| `/api/task/[taskId]` | GET | 轮询任务状态、进度、结果 |
| `/api/audio/[audioId]` | GET | 获取音频文件信息和状态 |
| `/api/generate` | POST | 从已有转录重新生成文章 |
| `/api/export/[id]` | GET | 下载文章为 Markdown 文件 |

## 关键文件

### src/lib/audio-converter.ts
- FFmpeg 封装，用于音频格式转换
- 导出: `convertToWav()`、`getAudioInfo()`、`isFfmpegInstalled()`
- 将各种格式（MP3、M4A、OGG、FLAC）转换为 WAV（16kHz、16-bit、单声道）
- 使用 fluent-ffmpeg 调用系统 ffmpeg

### src/lib/whisper.ts
- 通过 subprocess spawn 调用 whisper.cpp（非原生 addon）
- 导出: `init()`、`transcribe()`、`isCudaAvailable()`、`isReady()`
- 启动 whisper.cpp 二进制，参数: `-m model -f audio.wav -l zh -oj -of output`
- 解析 whisper.cpp 的 JSON 输出（字段名: `transcription`，不是 `segments`）
- 使用环境变量: `WHISPER_MODEL_PATH`、`WHISPER_USE_CUDA`
- JSON 输出结构:
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

### src/lib/openai-compatible.ts
- 所有 OpenAI 兼容 provider 的共享引擎：SSE 流式输出、进度上报、JSON 提取/规范化
- 导出: `generateArticleWithProvider(provider, transcript, options)`、`ARTICLE_SYSTEM_PROMPT`、类型 `GenerateResult` / `Highlight` / `GenerateOptions` / `ChatProvider`

### src/lib/providers.ts
- Provider 选择 + API 路由调用的统一入口
- 导出: `generateArticle(transcript, options)`、`resolveProvider()`、`resolveProviderId()`
- 选择逻辑: `AI_PROVIDER`（`ark` | `minimax`，也接受别名如 `volcengine` / `coding-plan`）→ 否则自动探测（配置了 Ark Key 则用 `ark`，否则 Minimax）
- 未配置任何 provider Key 时抛出描述性错误

### src/lib/ark.ts
- 火山引擎方舟 Coding Plan 客户端，OpenAI 兼容
- 导出: `generateArticle(transcript, options)`、`getArkProvider()`
- 使用环境变量: `ARK_PLAN_API_KEY`（优先）或 `ARK_API_KEY`、`ARK_API_BASE`、`ARK_MODEL`
- 默认值: `https://ark.cn-beijing.volces.com/api/coding/v3`，模型 `deepseek-v4-1-flash-260910`

### src/lib/minimax.ts
- Minimax API 客户端，用于文章生成
- 导出: `generateArticle(transcript)`、`getMinimaxProvider()`
- 返回: `{ title, outline, content, tags, highlights, summary }`
- 使用环境变量: `MINIMAX_API_KEY`、`MINIMAX_API_BASE`、`MINIMAX_MODEL`

### src/app/api/transcribe/route.ts
- 异步任务处理，支持进度跟踪
- 进度阶段: 10%（开始）→ 30%（转换中）→ 60%（转录中）→ 80%（生成中）→ 100%（完成）
- 通过 try/catch + Task.error 更新做错误处理

## 环境变量

```bash
# 必需（至少配置一个文章生成 provider）
AI_PROVIDER=                  # 可选: "ark" | "minimax"；不设置则自动探测
ARK_PLAN_API_KEY=             # 火山引擎方舟 Coding Plan API Key（优先）
MINIMAX_API_KEY=              # Minimax API Key
DATABASE_URL=                 # SQLite: "file:./dev.db"

# 可选（有默认值）
WHISPER_MODEL_PATH=           # 默认: whisper.cpp/models/ggml-large-v3.bin
WHISPER_USE_CUDA=             # 默认: 1（设为 0 则使用 CPU）
ARK_API_KEY=                  # Ark 备用 Key（ARK_PLAN_API_KEY 未设置时使用）
ARK_API_BASE=                 # 默认: https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=                    # 默认: deepseek-v4-1-flash-260910
MINIMAX_API_BASE=             # 默认: https://api.minimaxi.com/v1
MINIMAX_MODEL=                # 默认: MiniMax-M2.7
```

## Git 操作约束

**除非用户明确要求，不要执行任何 git 写操作。** 具体规则：

- **commit（提交）**：只在用户说"提交"、"git 提交"、"做个 commit"等明确要求时才执行。完成代码改动后不要主动提交。
- **push（推送）**：用户必须显式说"push"、"推送"、"推到远程"等字样才执行。**绝不要在 commit 之后自动 push**，哪怕工作流看起来"自然"该推。
- **其它写操作**（rebase、reset、merge、cherry-pick、amend 等）：同样需要用户显式指令。
- **只读操作**（log、diff、status、show、reflog 等）可自由使用，做完任务汇报时也常引用。
- **stash、branch -D、clean -fd 等可能丢数据的操作**：必须显式确认，不要猜测意图。

如果不确定某步是否该做（例如用户只说了"提交"但没说"推送"），做之前先用简短一句话确认。

## Git Commit 规范

格式：
```
<type>: <中文简短描述>

- 改动的具体内容（中文）
```

**type 前缀**（英文）：
- `feat:` — 新功能
- `refactor:` — 重构（不修 bug，不加功能）
- `fix:` — Bug 修复
- `docs:` — 仅文档改动
- `chore:` — 依赖更新、工具、CI 等

**规则**：
- 每条 commit 只做一件逻辑事
- 第一行 72 字以内，主体中文
- bullet 点说清楚改了什么
- 参考项目历史风格：`git log --oneline`

示例：
```
feat: 添加 Minimax 流式输出支持

- 在 minimax.ts 中实现 SSE 流式调用，透传进度回调
- 更新 providers.ts，无 ARK Key 时自动路由到 Minimax
```

```
refactor: 移除原生 Node.js addon

- 删除 binding.gyp、whisper-addon.cc/h，subprocess 模式已覆盖全部场景
- 移除 node-gyp 和 node-addon-api 依赖
```

## 常用命令

```bash
# 开发
npm run dev                   # 启动开发服务器 http://localhost:3000
npm run build                 # 构建生产版本

# 数据库
npm run db:generate            # 生成 Prisma Client
npm run db:push               # 同步数据库 schema
npm run db:studio             # 打开 Prisma Studio GUI

# whisper.cpp
npm run whisper:build         # 构建 whisper.cpp + 下载模型（Windows PowerShell）
powershell ./scripts/build-whisper.ps1  # 直接运行脚本，支持参数
# 参数: small/large 模型, -CPU 仅用 CPU, -GPUArch N 手动指定架构

# FFmpeg（音频转换必需）
# Windows: winget install Gyan.FFmpeg
# macOS: brew install ffmpeg
# Ubuntu: sudo apt install ffmpeg
```

## 重要注意事项

1. **文件系统访问**: API 路由使用 `export const runtime = "nodejs"` 以支持文件系统操作

2. **Prisma 单例**: 客户端在 `src/lib/prisma.ts` 中全局单例化，避免开发时连接问题

3. **音频存储**: 文件存储在 `uploads/{audioId}/` 目录（不入库）

4. **异步处理**: 任务处理为 fire-and-forget 模式，错误通过 try/catch 捕获：
   ```typescript
   processTranscribe(task.id, audioId).catch(err => {
     // 更新任务状态为 failed
   });
   ```

5. **whisper.cpp 构建**: 需要 CMake + MSVC（Windows）或 GCC（Linux）。CUDA 可选，但推荐开启以提升速度。

6. **模型文件**: 首次运行会下载 1-3GB 模型。加载失败时先验证文件大小：
   - large-v3: ~3.1GB
   - medium: ~1.5GB
   - small: ~466MB
   - base: ~142MB

7. **音频格式**: 非 WAV 格式会在转录前自动用 FFmpeg 转换为 WAV

8. **Whisper JSON 格式**: 代码期望 `result.transcription` 数组，包含 `offsets.from/to`（毫秒）和 `text` 字段，不是 `result.segments`

## 故障排查

### Whisper 返回 0 个 segments
- 检查 JSON 字段名：应为 `transcription`，不是 `segments`
- 检查时间格式：`offsets.from/to` 单位为毫秒，需除以 1000 转为秒
- 参考 `src/lib/whisper.ts` 中的解析逻辑

### FFmpeg 找不到
- 安装 FFmpeg：`winget install Gyan.FFmpeg`（Windows）
- 验证安装：`ffmpeg -version`

### 上传返回 400
- 检查 `next.config.mjs` 中的 body 大小限制（已默认提升至 50mb）
- 检查 multipart form 中的文件字段名是否为 "file"

## 相关文档

- [README.md](./README.md) - 项目概述和快速开始
- [设计.md](./设计.md) - 功能设计和技术架构
- [实现.md](./实现.md) - 详细实现说明
- [部署.md](./部署.md) - 部署和配置说明
- [调研.md](./docs/archive/调研.md) - 归档的调研笔记
