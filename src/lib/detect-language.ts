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
const DEFAULT_SAMPLE_DURATION_MS = 15_000; // 每个采样点 15 秒（更短 → 更准）

/**
 * 在一个 chunk 内部采几个点判断语言。
 *
 * 设计动机：
 *  - 单采样（开头 30 秒）易被主持人切换语言的瞬间误导
 *  - 你的 70 分钟访谈实际是"英文主体 + 偶发中文提问"，开头 30 秒采样总是 zh
 *  - 多采样+投票：英文主体里 3 个采样点都应该是 en
 *
 * 返回值是投票结果（出现最多的语言），不是单点结果。
 */
export interface DetectLanguageOptions {
  startMs?: number;          // chunk 起始毫秒
  durationMs?: number;        // chunk 总时长毫秒
  modelPath?: string;
  cuda?: boolean;
  /**
   * 多采样策略：传了则忽略 startMs/durationMs。
   * 用例：[0.1, 0.5, 0.8] 表示在 chunk 的 10%/50%/80% 处各采一段。
   */
  samplePoints?: number[];   // 0-1 之间的比例数组
  sampleDurationMs?: number; // 每个采样点的长度（默认 15 秒）
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
  const modelPath =
    options.modelPath ?? resolve(process.cwd(), 'whisper.cpp/models/ggml-large-v3.bin');
  const useCuda = options.cuda ?? process.env.WHISPER_USE_CUDA !== '0';

  const binaryPath = getWhisperBinary();
  const outputDir = dirname(audioPath);
  const audioName = basename(audioPath, '.wav');

  // 决定采样点
  const sampleDuration = options.sampleDurationMs ?? DEFAULT_SAMPLE_DURATION_MS;
  const samplePoints = options.samplePoints ?? [0.1]; // 默认采样开头 10%
  const chunkDuration = options.durationMs ?? sampleDuration * 3;

  // 并发跑所有采样点
  const tasks = samplePoints.map(async (frac) => {
    const startMs = Math.floor((options.startMs ?? 0) + chunkDuration * frac);
    return runSingleSample(
      audioPath,
      modelPath,
      useCuda,
      binaryPath,
      outputDir,
      audioName,
      startMs,
      sampleDuration,
    );
  });
  const results = await Promise.all(tasks);

  // 投票：出现最多的语言胜出
  const counts = new Map<string, number>();
  for (const r of results) {
    if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  if (counts.size === 0) {
    console.warn(`[DetectLanguage] all samples failed`);
    return null;
  }

  // 排序找最高票
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0];
  console.log(
    `[DetectLanguage] votes: ${sorted.map(([k, v]) => `${k}=${v}`).join(', ')} → ${winner[0]}`,
  );
  return winner[0];
}

/**
 * 跑单次 30 秒采样并解析检测到的语言。
 */
async function runSingleSample(
  audioPath: string,
  modelPath: string,
  useCuda: boolean,
  binaryPath: string,
  outputDir: string,
  audioName: string,
  startMs: number,
  durationMs: number,
): Promise<string | null> {
  const tmpSuffix = `_detect_${startMs}_${durationMs}`;
  const outputJsonPath = join(outputDir, `${audioName}${tmpSuffix}.json`);

  const args = [
    '-m', modelPath,
    '-f', audioPath,
    '-l', 'auto',
    '-oj',
    '-of', join(outputDir, `${audioName}${tmpSuffix}`),
    '-bs', '1',
    '-bo', '1',
    '-mc', '0',
    '-nf',
    '-ot', String(startMs),
    '-d', String(durationMs),
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
      const detected = parseDetectedLanguage(stderr);
      if (detected) {
        child.kill('SIGTERM');
      }
    });

    child.on('close', () => {
      const detected = parseDetectedLanguage(stderr);
      // 清理临时 json
      try {
        const fs = require('fs');
        if (fs.existsSync(outputJsonPath)) fs.unlinkSync(outputJsonPath);
      } catch {
        /* ignore */
      }
      resolveResult(detected);
    });

    child.on('error', () => resolveResult(null));
  });
}

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

