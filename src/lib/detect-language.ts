/**
 * detect-language.ts
 *
 * 短采样检测音频的语言。
 *
 * 工作原理：
 *  - 用 whisper-cli 跑指定起止时间的音频（默认 30 秒）
 *  - 加 -l auto，让 whisper 自动检测
 *  - 从 stderr 抓 `auto-detected language: <code> (p = ...)` 那一行
 *  - 返回语言代码（zh / en / ja 等）
 *
 * 用途：
 *  - transcribeWithCheckpoint 在转录每个 chunk 之前调用，确认该 chunk 的真实语言
 *  - 解决 whisper.cpp 的 -l auto 不能逐段切换的限制
 */

import { spawn } from 'child_process';
import { resolve, dirname, basename, join } from 'path';
import { platform } from 'os';
import { existsSync } from 'fs';

const DEFAULT_DETECT_DURATION_MS = 30_000; // 30 秒采样

/**
 * 从 whisper.cpp 的 stderr 里抽取 auto-detected language。
 * 匹配模式：`whisper_full_with_state: auto-detected language: <code> (p = ...)`
 */
function parseDetectedLanguage(stderr: string): string | null {
  const m = stderr.match(/auto-detected language:\s*([a-z]+)/i);
  return m ? m[1] : null;
}

function getWhisperBinary(): string {
  const isWindows = platform() === 'win32';
  const binaryName = isWindows ? 'whisper-cli.exe' : 'whisper-cli';
  const searchDirs = [
    resolve(process.cwd(), 'whisper.cpp/build/bin'),
    resolve(process.cwd(), 'whisper.cpp/build'),
    resolve(process.cwd(), 'whisper.cpp'),
  ];
  for (const dir of searchDirs) {
    const candidate = join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  // 兼容老版本 whisper.cpp 还叫 main
  for (const dir of searchDirs) {
    const candidate = join(dir, isWindows ? 'main.exe' : 'main');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('whisper-cli / main binary not found');
}

export interface DetectLanguageOptions {
  startMs?: number;          // 起始毫秒，默认 0
  durationMs?: number;        // 采样时长，默认 30 秒
  modelPath?: string;
  cuda?: boolean;
}

/**
 * 短采样检测指定时间窗口的语言。
 *
 * @returns 语言代码（如 'zh' / 'en'），如果检测失败返回 null
 */
export async function detectLanguage(
  audioPath: string,
  options: DetectLanguageOptions = {},
): Promise<string | null> {
  const startMs = options.startMs ?? 0;
  const durationMs = options.durationMs ?? DEFAULT_DETECT_DURATION_MS;
  const modelPath =
    options.modelPath ?? resolve(process.cwd(), 'whisper.cpp/models/ggml-large-v3.bin');
  const useCuda = options.cuda ?? process.env.WHISPER_USE_CUDA !== '0';

  const binaryPath = getWhisperBinary();
  const outputDir = dirname(audioPath);
  const audioName = basename(audioPath, '.wav');
  // 输出到独立临时文件，不污染正式 chunks 目录
  const tmpSuffix = `_detect_${startMs}_${durationMs}`;
  const outputJsonPath = join(outputDir, `${audioName}${tmpSuffix}.json`);

  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '-l', 'auto',                 // 关键：让 whisper 自己检测
    '-oj',
    '-of', join(outputDir, `${audioName}${tmpSuffix}`),
    '-bs', '1',
    '-bo', '1',
    '-mc', '0',
    '-nf',
    '-ot', String(startMs),
    '-d', String(durationMs),
    // 不打印转录进度（要 stderr 抓 auto-detected 那一行）
    '-np',
  ];

  if (!useCuda) {
    args.push('-ng');
  }

  return new Promise((resolveResult) => {
    let stderr = '';
    const child = spawn(binaryPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      // 一旦检测到语言就杀掉进程，节省时间
      const detected = parseDetectedLanguage(stderr);
      if (detected) {
        child.kill('SIGTERM');
      }
    });

    child.on('close', (code: number | null) => {
      // 不管 exit code，只要能解析出语言就返回
      const detected = parseDetectedLanguage(stderr);
      if (detected) {
        // 清理临时 json（如果写了的话）
        try {
          const fs = require('fs');
          if (fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath);
        } catch {
          /* ignore */
        }
        resolveResult(detected);
        return;
      }
      // 检测失败回退
      console.warn(`[DetectLanguage] failed to parse language from stderr (exit=${code})`);
      resolveResult(null);
    });

    child.on('error', (err: Error) => {
      console.error(`[DetectLanguage] spawn error:`, err.message);
      resolveResult(null);
    });
  });
}