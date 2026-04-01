# Podcast2Markdown

将播客音频智能转换为结构化 Markdown 文章。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```bash
# 灵芽 Whisper API
WHISPER_API_KEY=your_whisper_api_key
WHISPER_API_BASE=https://api.lingyaai.cn/v1

# MINIMAX API
MINIMAX_API_KEY=your_minimax_api_key
MINIMAX_API_BASE=https://api.minimaxi.com/v1

# 数据库
DATABASE_URL="file:./dev.db"
```

### 3. 初始化数据库

```bash
npx prisma generate
npx prisma db push
```

### 4. 启动开发服务器

```bash
npm run dev
```

访问 http://localhost:3000

---

## 重新进入 Session

如果需要在新的 Claude Code session 中继续开发：

```bash
cd D:\Projects\Podcast2Markdown
claude --resume 2a3ea8d3-cc7e-4522-88a8-744d1be5987b
```

Claude Code 会自动读取当前目录的配置和上下文。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 构建生产版本 |
| `npx prisma studio` | 打开数据库管理界面 |
| `npx prisma db push` | 同步数据库 schema |

---

## 项目结构

```
src/
├── app/
│   ├── api/           # API 路由
│   │   ├── upload/    # 音频上传
│   │   ├── transcribe/# 转录任务
│   │   ├── task/      # 任务状态
│   │   ├── generate/  # 文章生成
│   │   └── export/    # Markdown 导出
│   └── page.tsx       # 首页
└── lib/
    ├── prisma.ts      # 数据库客户端
    ├── whisper.ts     # 灵芽 Whisper
    └── minimax.ts     # Minimax API
```

