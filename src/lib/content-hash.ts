/**
 * content-hash.ts
 *
 * 计算音频文件的 SHA-256 内容哈希，用于跨任务复用 Transcript。
 *
 * 设计要点：
 * 1. 对 **原始上传文件** 做哈希（不是转换后的 WAV）。不同设备/不同参数
 *    转出的 WAV 会不同，但用户传上来的原始音频二进制是稳定的。
 * 2. 用 1 MB 流式分块读取，137 MB 音频在现代 CPU 上 200-500 ms 算完，
 *    不会因为一次性 readFileSync 把 1 GB 音频塞进内存导致 OOM。
 * 3. 用 Node 内置 crypto，无需额外依赖。
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';

/**
 * 流式计算 SHA-256，返回 64 字符小写 hex 字符串。
 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}