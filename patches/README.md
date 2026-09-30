# Patches for whisper.cpp

这个目录用于存放针对**特定版本** whisper.cpp 的源码补丁。

## 用途

whisper.cpp 是用 git clone 拉取的，每次构建脚本会克隆指定 tag（如 v1.8.3）。
如果你需要给 whisper.cpp 加自定义功能（断点续转的 KV cache、参数扩展等），
可以写 .patch 文件，按版本放在子目录里，构建脚本会自动应用。

## 目录结构

```
patches/
  README.md          # 本文件
  v1.8.3/            # 针对 whisper.cpp v1.8.3 的补丁（当前空）
    0001-foo.patch
    0002-bar.patch
    ...
  v1.9.0/            # 未来升级到 v1.9.0 时新建
    ...
```

## 命名规范

- 子目录名必须**精确等于** `scripts/build-whisper.{ps1,sh}` 里 clone 命令的 `--branch` 参数
  （例如 `v1.8.3`，不能写成 `v1.8` 或 `release-v1.8.3`）
- 文件名推荐 `NNNN-short-description.patch`，按字典序排序后依次应用
- 推荐使用 `git format-patch` 生成（不是 `git diff`），这样能保留 commit message

## 构建脚本行为

- `scripts/build-whisper.ps1` 和 `scripts/build-whisper.sh` 在 git clone 完成后会查找
  `patches/<version>/` 目录
- **找到** → 按文件名顺序 `git apply` 所有 .patch 文件，并打印每个补丁的标题
- **找不到** → 打印一行 info 信息（如 `[patches] v1.8.3 not found, building vanilla`），
  **不阻断构建**

## 当前状态

- **v1.8.3**：**无补丁**。使用 vanilla whisper.cpp。
  当前的"断点续转"能力由 Node 侧（whisper.ts）通过 ffmpeg 切片 + 多进程调度实现，
  不需要修改 whisper.cpp 源码。`whisper-cli.exe` 已支持的 `-ot` / `-d` 参数
  提供"任意时间窗口转录"基础。
- **未来**：如果 vanilla whisper.cpp 不能满足需求（如想要 dump 完整 KV cache 跳过 encoder），
  在对应版本目录下新建 .patch 文件即可。

## 写补丁的工作流

1. 在临时 workspace 里 clone 目标版本的 whisper.cpp
2. 修改、commit 你的改动（多个 commit，逻辑分块）
3. 用 `git format-patch <base-commit>..HEAD --output-directory patches/<version>/` 生成 patch
4. 测试 `git apply patches/<version>/*.patch` 在干净 clone 上能用
5. 重新跑 `npm run whisper:build` 验证