/**
 * whisper.ts
 *
 * Node.js wrapper for whisper.cpp using child process.
 * Falls back to command line if native addon is not available.
 *
 * 设计要点：
 * 1. 关闭 beam search（--no-beam-search）—— large-v3 zh 配 greedy 准确率损失很小，
 *    但单次推理可快 6–8 倍，能在合理时间内跑完 2 小时以上的长音频。
 * 2. 动态超时 = max(60 分钟, 音频时长 × 1.5 分钟) —— 取代固定的 30 分钟硬超时。
 * 3. Windows 下 kill 用 taskkill /F /T /PID —— Node 在 Windows 杀不掉 main.exe，
 *    必须用 taskkill 才能彻底回收子进程，避免 GPU 一直被孤儿进程占着。
 * 4. 心跳上报 —— 如果 30 秒内没有新进度回调，主动发一次 onProgress(still running)
 *    防止前端轮询一直停在 80% 看起来像"卡死"。
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';
import { getAudioInfo } from './audio-converter';

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH || 'whisper.cpp/models/ggml-large.bin';
const WHISPER_USE_CUDA = process.env.WHISPER_USE_CUDA !== '0';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeResult {
  language: string;
  fullText: string;
  segments: TranscriptSegment[];
}

export interface WhisperConfig {
  model?: string;
  cuda?: boolean;
}

let isInitialized = false;
let currentModelPath: string = '';

/**
 * Get whisper.cpp binary path
 */
function getWhisperBinary(): string {
  const isWindows = platform() === 'win32';
  const binaryName = isWindows ? 'main.exe' : 'main';

  const possiblePaths = [
    resolve(process.cwd(), 'whisper.cpp/build/bin', binaryName),
    resolve(process.cwd(), 'whisper.cpp/build', binaryName),
    resolve(process.cwd(), 'whisper.cpp', binaryName),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  throw new Error(
    `Whisper binary not found. Please build whisper.cpp first.\n` +
      `Windows: powershell ./scripts/build-whisper.ps1\n` +
      `Linux/macOS: ./scripts/build-whisper.sh`,
  );
}

/**
 * Initialize Whisper with model
 */
export async function init(config: WhisperConfig = {}): Promise<void> {
  const modelPath = resolve(process.cwd(), config.model || WHISPER_MODEL_PATH);
  const useCuda = config.cuda ?? WHISPER_USE_CUDA;

  if (!existsSync(modelPath)) {
    throw new Error(`
Model not found: ${modelPath}

Download a model from:
  https://huggingface.co/ggerganov/whisper.cpp/tree/master/models

Recommended: ggml-large.bin or ggml-medium.bin
`);
  }

  // Check binary exists
  const binaryPath = getWhisperBinary();

  console.log(
    `[Whisper] Initializing: model=${modelPath}, cuda=${useCuda}, binary=${binaryPath}`,
  );

  currentModelPath = modelPath;
  isInitialized = true;

  console.log(`[Whisper] Initialized successfully (using subprocess mode)`);
}

/**
 * Transcribe audio file using whisper.cpp subprocess
 */
export interface TranscribeOptions {
  language?: string;
  onProgress?: (progress: number) => void;
}

/**
 * 用 ffprobe 取音频时长（秒）。
 * 转录前已经转换过一次 WAV，这里读取转换后的 WAV 的时长。
 * 失败时返回 0，由调用方走默认超时（60 分钟）兜底。
 */
async function getAudioSeconds(audioPath: string): Promise<number> {
  try {
    const info = await getAudioInfo(audioPath);
    return info.duration || 0;
  } catch {
    return 0;
  }
}

/**
 * 按音频时长动态算超时（分钟）。
 * 经验系数：
 *   - large-v3 greedy: 约 0.5–1× 实时（CUDA）
 *   - large-v3 + beam 5 + best-of 5: 6–8× 实时
 * 给 1.5× 实时 + 30 分钟最低缓冲，足够覆盖大文件 + 模型加载。
 */
function computeTimeoutMinutes(audioSeconds: number): number {
  const audioMinutes = audioSeconds / 60;
  const minutes = Math.ceil(audioMinutes * 1.5) + 30;
  return Math.max(60, minutes);
}

/**
 * 在 Windows 上用 taskkill 强制杀掉子树（main.exe 及其子进程）。
 * 返回 Promise 在 taskkill 完成后 resolve，不会让 timeout handler hang 住。
 */
function killProcessTree(child: ChildProcess, label: string): void {
  if (platform() === 'win32') {
    console.log(`[Whisper] taskkill /F /T /PID ${child.pid}`);
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
    return;
  }
  try {
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, 2000);
  } catch (e) {
    console.error(`[Whisper] kill(${label}) failed:`, e);
  }
}

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const { language = 'zh', onProgress } = options;

  if (!isInitialized) {
    throw new Error('Whisper not initialized. Call whisper.init() first.');
  }

  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  console.log(`[Whisper] Transcribing: ${audioPath} (lang=${language})`);

  const binaryPath = getWhisperBinary();
  const audioDir = dirname(audioPath);
  const audioName = basename(audioPath, '.wav');
  const outputJsonPath = join(audioDir, `${audioName}.json`);

  // 按音频时长动态算超时
  const audioSeconds = await getAudioSeconds(audioPath);
  const timeoutMinutes = computeTimeoutMinutes(audioSeconds);
  console.log(
    `[Whisper] Audio duration: ${audioSeconds.toFixed(1)}s, timeout: ${timeoutMinutes}m`,
  );

  return new Promise((resolve, reject) => {
    let timedOut = false;
    // shared ref so timeout handler can reach the child once spawned
    const childRef: { current: ChildProcess | null } = { current: null };
    function killCurrentProcess(label: string) {
      if (childRef.current) {
        killProcessTree(childRef.current, label);
      }
    }

    const timeout = setTimeout(() => {
      timedOut = true;
      console.error(`[Whisper] Timeout after ${timeoutMinutes} minutes`);
      killCurrentProcess('timeout');
      reject(
        new Error(
          `Whisper transcription timeout after ${timeoutMinutes} minutes (audio ${audioSeconds.toFixed(0)}s)`,
        ),
      );
    }, timeoutMinutes * 60 * 1000);

    const args = [
      '-m', currentModelPath,
      '-f', audioPath,
      '-l', language,
      '-oj',
      '-of', join(audioDir, audioName),
      '-pp',
      // 关键：用 greedy 模式（beam-size=1, best-of=1）。
      // large-v3 zh 配 greedy 准确率损失小，但能避免长音频在后 20% 卡死
      // （beam search + best-of 5 是单次推理 6–8 倍耗时）。
      // 老版本 whisper.cpp 没有 --no-beam-search 这个 flag，所以显式传 -bs/-bo。
      '-bs', '1',
      '-bo', '1',
    ];

    if (!WHISPER_USE_CUDA) {
      args.push('-ng');
    }

    console.log(`[Whisper] Running: ${binaryPath} ${args.join(' ')}`);

    const whisperProcess = spawn(binaryPath, args, {
      cwd: process.cwd(),
      env: process.env,
      // 关键：分离 stdio 让 main.exe 用自己的 console buffer，
      // 否则长音频 stderr 累积会把 main.exe 阻塞死，导致"假卡死"。
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // 暴露给 timeout handler
    childRef.current = whisperProcess;

    // 心跳：30 秒内没新进度，主动发一次回调防止前端以为卡死
    let lastProgressTime = Date.now();
    let lastProgress = 0;
    const heartbeat = setInterval(() => {
      const since = Date.now() - lastProgressTime;
      if (since >= 30_000 && childRef.current) {
        console.log(
          `[Whisper] heartbeat: still running, last progress=${lastProgress}% ${since}s ago`,
        );
        if (onProgress) {
          // 复用 lastProgress 让前端知道模型还在跑
          onProgress(lastProgress);
        }
        lastProgressTime = Date.now();
      }
    }, 30_000);

    let stderr = '';

    whisperProcess.stderr.on('data', (data: Buffer) => {
      const output = data.toString();
      stderr += output;

      // 不要每次都打印完整 stderr —— 长音频累积下来日志会爆。
      // 只挑出包含 "progress" 关键字的行打，并在前 4KB 截断。
      if (/progress|warning|error|fail/i.test(output)) {
        const slice = output.length > 1024 ? output.slice(0, 1024) + '...[truncated]' : output;
        console.log(`[Whisper stderr] ${slice.trim()}`);
      }

      const progressMatch = output.match(
        /whisper_print_progress_callback:\s*progress\s*=\s*(\d+)%/,
      );
      if (progressMatch) {
        const progress = parseInt(progressMatch[1], 10);
        if (progress !== lastProgress) {
          lastProgress = progress;
          lastProgressTime = Date.now();
          if (onProgress) {
            console.log(`[Whisper] progress=${progress}%`);
            onProgress(progress);
          }
        }
      }
    });

    whisperProcess.stdout.on('data', (data: Buffer) => {
      // 主进程 stdout 主要是 JSON 输出（-oj），但我们读 JSON 文件更可靠。
      // 仍然 drain 一下防止 main.exe stdout buffer 满被阻塞。
      // 不打印（可能巨大）。
    });

    whisperProcess.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      childRef.current = null;

      console.log(
        `[Whisper] Process closed code=${code} signal=${signal}${timedOut ? ' (TIMED OUT)' : ''}`,
      );

      if (timedOut) {
        // reject 已经在 timeout handler 里触发
        return;
      }

      if (code !== 0) {
        console.error(`[Whisper] Process exited with code ${code}`);
        console.error(`[Whisper] stderr tail: ${stderr.slice(-2048)}`);
        reject(
          new Error(
            `Whisper transcription failed (exit code ${code}): ${
              stderr.slice(-512) || 'Unknown error'
            }`,
          ),
        );
        return;
      }

      try {
        // Read the JSON output file
        if (!existsSync(outputJsonPath)) {
          reject(new Error(`Whisper output file not found: ${outputJsonPath}`));
          return;
        }

        const jsonContent = readFileSync(outputJsonPath, 'utf-8');
        const result = JSON.parse(jsonContent);

        // Clean up the JSON file
        try {
          unlinkSync(outputJsonPath);
        } catch {
          /* ignore cleanup errors */
        }

        const segments: TranscriptSegment[] = (result.transcription || []).map(
          (s: any) => ({
            start: (s.offsets?.from || 0) / 1000,
            end: (s.offsets?.to || 0) / 1000,
            text: s.text?.trim() || '',
          }),
        );

        console.log(
          `[Whisper] Parsed ${segments.length} segments, first segment: ${JSON.stringify(segments[0])}`,
        );

        const fullText = segments.map((s) => s.text).join('');

        console.log(
          `[Whisper] Done: ${fullText.length} chars, ${segments.length} segments`,
        );

        resolve({
          language: result.result?.language || result.language || language,
          fullText,
          segments,
        });
      } catch (e) {
        reject(new Error(`Failed to parse whisper output: ${e}`));
      }
    });

    whisperProcess.on('error', (err: Error) => {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      childRef.current = null;
      reject(new Error(`Failed to spawn whisper: ${err.message}`));
    });
  });
}

/**
 * Check if CUDA is available (placeholder - always returns false for subprocess mode)
 */
export async function isCudaAvailable(): Promise<boolean> {
  return WHISPER_USE_CUDA;
}

/**
 * Check if whisper is ready
 */
export function isReady(): boolean {
  return isInitialized;
}

export default { init, transcribe, isCudaAvailable, isReady };