# Podcast2Markdown

将播客音频智能转换为结构化 Markdown 文章。

## 功能特性

- 🎙️ **本地音频转录**：使用 whisper.cpp 本地推理，支持 CUDA GPU 加速
- 🤖 **AI 文章生成**：支持火山引擎方舟 Coding Plan / Minimax，自动整理转录内容为结构化 Markdown
- 📄 **Markdown 导出**：一键下载生成的文章为 Markdown 文件
- ⚡ **异步处理**：任务队列管理，支持进度跟踪

## 技术栈

- **前端**: Next.js 14 + Tailwind CSS
- **后端**: Next.js API Routes (Node.js)
- **数据库**: SQLite + Prisma ORM
- **语音转录**: whisper.cpp (本地 CUDA 加速)
- **文章生成**: 火山引擎方舟 Coding Plan（默认）/ Minimax

## 快速开始

### 1. 环境要求

- Node.js 18+
- Git
- C/C++ 编译工具 (CMake)
- **可选**: NVIDIA GPU + CUDA Toolkit (用于 GPU 加速)

### 2. 安装依赖

```bash
npm install
```

### 3. 编译 whisper.cpp

**Windows (PowerShell)**:
```powershell
# 自动构建（推荐）
powershell ./scripts/build-whisper.ps1

# 指定模型大小
powershell ./scripts/build-whisper.ps1 large   # 大模型（3.1GB，高质量）
powershell ./scripts/build-whisper.ps1 small   # 小模型（466MB，快速）

# CPU 版本（无 GPU）
powershell ./scripts/build-whisper.ps1 -CPU
```

构建脚本会自动下载模型文件。

### 4. 配置环境变量

创建 `.env` 文件：

```bash
# Whisper 本地转录配置
WHISPER_MODEL_PATH=whisper.cpp/models/ggml-large-v3.bin
WHISPER_USE_CUDA=1

# 文章生成 Provider（二选一；都配置时用 AI_PROVIDER 指定）
AI_PROVIDER=ark

# 火山引擎方舟 Coding Plan（OpenAI 兼容，推荐）
ARK_PLAN_API_KEY=your_ark_plan_api_key
ARK_API_BASE=https://ark.cn-beijing.volces.com/api/coding/v3
ARK_MODEL=deepseek-v4-1-flash-260910

# MINIMAX API（备选）
MINIMAX_API_KEY=your_minimax_api_key
MINIMAX_API_BASE=https://api.minimaxi.com/v1

# 数据库
DATABASE_URL="file:./dev.db"
```

> **AI Provider 说明**：文章生成支持两个 OpenAI 兼容 provider。
> 设置 `AI_PROVIDER=ark`（方舟 Coding Plan）或 `AI_PROVIDER=minimax` 可显式指定；
> 不设置时自动探测：配置了 `ARK_PLAN_API_KEY`（或 `ARK_API_KEY`）就用方舟，否则用 Minimax。
> 完整示例见 `.env.example`。

### 5. 初始化数据库

```bash
npx prisma generate
npx prisma db push
```

### 6. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

## 使用说明

1. **上传音频**：在首页选择音频文件（支持 MP3、WAV、M4A 等格式）
2. **等待转录**：系统自动调用 whisper.cpp 进行转录，显示进度
3. **查看结果**：转录完成后自动调用 AI（方舟 Coding Plan / Minimax）生成 Markdown 文章
4. **下载文章**：点击"下载 Markdown"按钮导出文件

## 项目结构

```
src/
├── app/
│   ├── api/           # API 路由
│   │   ├── upload/    # 音频上传
│   │   ├── transcribe/# 提交转录任务
│   │   ├── task/      # 查询任务状态
│   │   ├── generate/  # 重新生成文章
│   │   └── export/    # Markdown 导出
│   ├── layout.tsx     # 根布局
│   └── page.tsx       # 首页（上传+结果展示）
├── lib/
│   ├── prisma.ts      # Prisma 客户端
│   ├── whisper.ts     # whisper.cpp 调用封装
│   ├── providers.ts   # AI provider 选择与统一入口
│   ├── ark.ts         # 火山方舟 Coding Plan 调用
│   └── minimax.ts     # Minimax API 调用
└── types/
    └── index.ts       # 类型定义

whisper.cpp/           # whisper.cpp 源码和编译输出
├── build/            # 编译后的二进制
├── models/           # 模型文件
└── samples/          # 测试音频

scripts/               # 构建脚本
├── build-whisper.ps1 # Windows 构建脚本
└── build-whisper.sh  # Unix 构建脚本
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npm run whisper:build` | 构建 whisper.cpp |
| `npm run build:addon` | 编译 Node.js 原生插件 |
| `npx prisma studio` | 打开数据库管理界面 |
| `npx prisma db push` | 同步数据库 schema |

## 文档

- [设计文档](设计.md) - 功能设计和技术架构
- [实现文档](实现.md) - 详细实现说明
- [部署指南](部署.md) - 部署和配置说明

## 许可证

MIT

