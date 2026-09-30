# Patches for whisper.cpp v1.8.3

**当前状态：空。**

当前不需要修改 whisper.cpp 源码——Node 侧通过 ffmpeg 切片 + `-ot`/`-d` 参数
实现断点续转能力。

如果未来需要打补丁（例如 dump encoder KV cache、扩展 CLI 参数），
按 `patches/README.md` 里的规范添加 `NNNN-*.patch` 文件即可。