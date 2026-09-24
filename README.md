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
- CMake
- **可选**: NVIDIA GPU + CUDA Toolkit (用于 GPU 加速)

### 2. 安装 & 构建

```bash
# 安装依赖（无需 C++ 编译工具）
npm install

# 构建 whisper.cpp（自动检测 GPU 架构，下载模型）
npm run whisper:build
```

> whisper.cpp 构建参数：
> - 指定模型：`npm run whisper:build -- small`（small / large）
> - CPU 版本：`npm run whisper:build -- -CPU`
> - 手动指定架构：`npm run whisper:build -- large -GPUArch 86`

### 3. 配置环境变量

复制 `.env.example` 为 `.env`，填入 AI Provider 的 API Key：

```bash
cp .env.example .env
```

必需配置：

```bash
# 文章生成 Provider（二选一）
AI_PROVIDER=ark   # 火山引擎方舟 Coding Plan
# AI_PROVIDER=minimax   # Minimax

# 方舟（任选一个 Key）
ARK_PLAN_API_KEY=your_ark_plan_api_key
# 或者
MINIMAX_API_KEY=your_minimax_api_key
```

可选配置：

```bash
WHISPER_MODEL_PATH=whisper.cpp/models/ggml-large.bin
WHISPER_USE_CUDA=1   # 0 = CPU only
DATABASE_URL="file:./dev.db"
```

### 4. 初始化数据库

```bash
npx prisma generate
npx prisma db push
```

### 5. 启动

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
| `npm run whisper:build` | 构建 whisper.cpp + 下载模型 |
| `npm run db:generate` | 生成 Prisma Client |
| `npm run db:push` | 同步数据库 schema |
| `npm run db:studio` | 打开 Prisma 数据库管理界面 |

## 文档

- [设计文档](设计.md) - 功能设计和技术架构
- [实现文档](实现.md) - 详细实现说明
- [部署指南](部署.md) - 部署和配置说明

## 许可证

MIT

