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
 *
 * 历史：
 *   - v1.7.x 及之前：二进制叫 main.exe / main
 *   - v1.8.0+：重命名为 whisper-cli.exe / whisper-cli，原 main.exe 变成
 *     打 deprecation warning 的 stub wrapper。这里优先找新名字，找不到再回退。
 */
function getWhisperBinary(): string {
  const isWindows = platform() === 'win32';
  // 优先尝试 v1.8.x 的二进制名
  const candidates = isWindows
    ? ['whisper-cli.exe', 'main.exe']
    : ['whisper-cli', 'main'];

  const searchDirs = [
    resolve(process.cwd(), 'whisper.cpp/build/bin'),
    resolve(process.cwd(), 'whisper.cpp/build'),
    resolve(process.cwd(), 'whisper.cpp'),
  ];

  for (const dir of searchDirs) {
    for (const name of candidates) {
      const p = join(dir, name);
      if (existsSync(p)) {
        return p;
      }
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
      // 防 token 循环。whisper 大模型在低置信度+重复语音片段（如主播说
      // "点赞、订阅、转发"）下会产生 self-reinforcing 循环：
      //   上一个 segment 文本被作为 prompt 喂回去 → model 强化这个模式 →
      //   整个文件输出都是同一句话重复几百遍。
      // -mc 0 强制每个 segment 独立，不带跨段 context，从根上断循环。
      // 副作用：段间过渡略生硬（"那个那个" 之类填充词不会从上一段带过来），
      // 对准确率影响可忽略。
      '-mc', '0',
      // 防 fallback hallucination。低置信度时温度 fallback 会用 0.2/0.4/0.8
      // 多次重试，重试结果经常是任意乱码。-nf 关掉这个 fallback，
      // 让模型坚持 greedy 解码，错误概率反而降低。
      '-nf',
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
        // 0xC0000005 = 3221226505：CUDA access violation（驱动层或显存问题）
        // 通常是 NVIDIA WDDM 驱动有僵尸 CUDA context，调用方可以重置驱动后重试
        const oomRecoverable =
          code === 3221226505 ||
          /out of memory|ggml_backend_cuda_buffer_type_alloc_buffer/i.test(stderr);
        const err = new Error(
          `Whisper transcription failed (exit code ${code}): ${
            stderr.slice(-512) || 'Unknown error'
          }`,
        ) as Error & { oomRecoverable?: boolean; exitCode?: number | null };
        err.exitCode = code;
        err.oomRecoverable = oomRecoverable;
        reject(err);
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

// =============================================================================
// 断点续转（chunk-based checkpoint）
// =============================================================================

const CHUNK_DURATION_MS_DEFAULT = 300_000; // 5 分钟
const CHUNK_OVERLAP_MS_DEFAULT = 30_000; // 30 秒（whisper encoder 的 30s 窗口）
const CHUNK_CHECKPOINT_FILENAME = "checkpoint.json";

export interface CheckpointOptions {
  language?: string;
  chunkDurationMs?: number;
  chunkOverlapMs?: number;
  onChunkStart?: (info: { index: number; total: number; startMs: number; durationMs: number }) => void;
  onChunkDone?: (info: { index: number; total: number; startMs: number; durationMs: number; segmentCount: number }) => void;
  shouldAbort?: () => boolean;
  /**
   * 提前已完成的 chunk 索引（用于重启时跳过）。
   * 注意：这个列表由调用方管理（来自数据库），不再读 checkpoint.json。
   */
  alreadyCompletedChunks?: number[];
  onProgress?: (info: { completedChunks: number; totalChunks: number; currentChunk: number }) => void;
  /**
   * 尝试从外部存储加载已缓存的 chunk segments。
   * 返回 null 表示"没缓存"，whisper.ts 会重新跑这个 chunk。
   * 返回 segments 数组表示"已持久化"，whisper.ts 直接用，不会重跑。
   *
   * 这个机制让"继续"按钮能真正续传而不丢内容：
   *   1. 每次 chunk 完成时，调用方通过 onChunkSegmentsPersist 把 segments 落盘
   *   2. 重启时 transcribeHere 调 loadChunkSegments 把缓存读回
   *   3. whisper.ts 跳过对应 chunk 的实际重跑
   */
  loadChunkSegments?: (chunkIndex: number) => Promise<TranscriptSegment[] | null>;
  /**
   * 每次 chunk 完成（无论是不是新跑的还是从缓存读的）触发一次，
   * 调用方负责把 segments 写到自己的存储里（典型：uploads/<id>/chunks/segments/<i>.json）。
   * 如果报错应该 swallow——这只是缓存，不应该让转录整体失败。
   */
  onChunkSegmentsPersist?: (chunkIndex: number, segments: TranscriptSegment[]) => Promise<void>;
}

export interface ChunkCheckpoint {
  version: 1;
  audioPath: string;
  totalChunks: number;
  completedChunks: number[]; // 已完成的 chunk index 列表
  chunkDurationMs: number;
  chunkOverlapMs: number;
  language: string;
}

/**
 * 一次跑完一个 chunk。不支持断点续跑，但每个 chunk 内部仍带超时。
 */
async function transcribeChunk(
  audioPath: string,
  startMs: number,
  durationMs: number,
  language: string,
  modelPath: string,
): Promise<TranscriptSegment[]> {
  const binaryPath = getWhisperBinary();
  const outputDir = dirname(audioPath);
  const audioName = basename(audioPath, '.wav');
  // 每个 chunk 单独写到独立 JSON 文件，避免覆盖
  const chunkSuffix = `_t${startMs}_d${durationMs}`;
  const outputJsonPath = join(outputDir, `${audioName}${chunkSuffix}.json`);

  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-l', language,
      '-oj',
      '-of', join(outputDir, `${audioName}${chunkSuffix}`),
      '-bs', '1',
      '-bo', '1',
      // 与 transcribe() 保持一致：防 token 循环 + 防 fallback hallucination
      '-mc', '0',
      '-nf',
      '-ot', String(startMs),
      '-d', String(durationMs),
    ];

    if (!WHISPER_USE_CUDA) {
      args.push('-ng');
    }

    const child = spawn(binaryPath, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`chunk transcription failed (exit ${code}): ${stderr.slice(-512)}`));
        return;
      }
      try {
        if (!existsSync(outputJsonPath)) {
          reject(new Error(`chunk output not found: ${outputJsonPath}`));
          return;
        }
        const raw = readFileSync(outputJsonPath, 'utf-8');
        try { unlinkSync(outputJsonPath); } catch { /* ignore */ }
        const parsed = JSON.parse(raw);
        const segs: TranscriptSegment[] = (parsed.transcription || []).map((s: any) => ({
          start: (s.offsets?.from || 0) / 1000,
          end: (s.offsets?.to || 0) / 1000,
          text: s.text?.trim() || '',
        }));
        resolve(segs);
      } catch (e) {
        reject(new Error(`parse chunk json: ${e}`));
      }
    });

    child.on('error', (err: Error) => {
      reject(new Error(`spawn whisper: ${err.message}`));
    });
  });
}

/**
 * 合并多个 chunk 的 segments，去掉重叠区（重叠区取时间戳更新的，即索引更大的 chunk）。
 * 简单做法：按 start 时间排序，重叠窗口内后到的 segment 覆盖先到的。
 *
 * 注意：相邻 chunk 的重叠是固定 30 秒；segments 在重叠窗口内可能错位几秒，
 * 实际去重按"时间区间最大重叠"处理。
 */
function mergeChunkSegments(
  chunkSegmentsList: { startMs: number; segments: TranscriptSegment[] }[],
  overlapMs: number,
): TranscriptSegment[] {
  if (chunkSegmentsList.length === 0) return [];
  if (chunkSegmentsList.length === 1) return chunkSegmentsList[0].segments;

  // 拍平 + 加 metadata
  type Item = TranscriptSegment & { _chunkStartMs: number };
  const flat: Item[] = [];
  for (const { startMs, segments } of chunkSegmentsList) {
    for (const s of segments) {
      flat.push({ ...s, _chunkStartMs: startMs });
    }
  }

  // 按 segment.start 升序
  flat.sort((a, b) => a.start - b.start);

  // 去重：当前段和已接受的最后一段时间区间重叠时，保留"更新鲜"的（_chunkStartMs 更大）。
  // 因为 chunk 顺序固定，_chunkStartMs 大的就是更晚跑的。
  const accepted: Item[] = [];
  for (const seg of flat) {
    const last = accepted[accepted.length - 1];
    if (last && seg.start < last.end) {
      // 时间区间重叠了 → 比较新鲜度
      if (seg._chunkStartMs > last._chunkStartMs) {
        // 用更新的覆盖旧的；如果新段部分延伸到旧段之外，保留延伸部分
        if (seg.end > last.end) {
          // 创建一个延伸版的 segment
          accepted[accepted.length - 1] = { ...seg, start: last.end };
        }
        // 否则完全被旧段覆盖，跳过
      } else {
        // 旧段更新鲜，新段被完全覆盖，跳过
        continue;
      }
    } else {
      accepted.push(seg);
    }
  }

  // 去掉 _chunkStartMs metadata
  return accepted.map(({ _chunkStartMs, ...rest }) => rest);
}

/**
 * 按 chunk 切分音频的转录入口。支持断点续转。
 *
 * 调用方负责：
 *   1. 计算 totalChunks（基于音频时长 + chunkDurationMs + chunkOverlapMs）
 *   2. 跟踪已完成 chunk 索引列表（持久化在 DB）
 *   3. 启动时把 alreadyCompletedChunks 传进来
 *
 * 工作流程：
 *   - 对每个未完成的 chunk 调用 transcribeChunk
 *   - 每个 chunk 跑完立刻合并到 partial segments 数组
 *   - 全跑完后返回最终合并结果
 */
export async function transcribeWithCheckpoint(
  audioPath: string,
  totalChunks: number,
  options: CheckpointOptions = {},
): Promise<TranscribeResult> {
  if (!isInitialized) {
    throw new Error('Whisper not initialized. Call whisper.init() first.');
  }
  const {
    language = 'zh',
    chunkDurationMs = CHUNK_DURATION_MS_DEFAULT,
    chunkOverlapMs = CHUNK_OVERLAP_MS_DEFAULT,
    onChunkStart,
    onChunkDone,
    shouldAbort,
    alreadyCompletedChunks = [],
    onProgress,
    loadChunkSegments,
    onChunkSegmentsPersist,
  } = options;

  // 总音频时长（毫秒）
  const audioSeconds = (await getAudioSeconds(audioPath)) || 0;
  const totalMs = Math.round(audioSeconds * 1000);
  // 每个 chunk 的"有效时长"（不含重叠）
  const chunkStepMs = chunkDurationMs - chunkOverlapMs;

  console.log(
    `[Whisper] transcribeWithCheckpoint: totalChunks=${totalChunks}, totalMs=${totalMs}, chunkDurationMs=${chunkDurationMs}, overlapMs=${chunkOverlapMs}, alreadyDone=[${alreadyCompletedChunks.join(',')}]`,
  );

  // 各 chunk 的 segments 缓存（按 chunk index 索引）
  const chunkSegmentsCache = new Map<number, TranscriptSegment[]>();

  // 重新跑已完成的 chunk（从 alreadyCompleted 列表里获取 segments）
  // 注意：调用方如果没保存 segments，需要把 alreadyCompletedChunks 清空，全重跑。
  // 这里我们假设 alreadyCompletedChunks 仅用于跳过——segments 在最后一并 merge。
  // 实际生产中，segments 也应该按 chunk index 持久化。这里简化：直接重跑。
  // （如果想真"复用旧 segments"，调用方传入 cache 然后填入 chunkSegmentsCache）

  for (let i = 0; i < totalChunks; i++) {
    if (shouldAbort && shouldAbort()) {
      throw new Error('transcription aborted by caller');
    }

    const startMs = i * chunkStepMs;
    // 最后一个 chunk 的实际时长 = 剩余音频（可能 < chunkDurationMs）
    const actualDurationMs = Math.min(chunkDurationMs, totalMs - startMs);
    if (actualDurationMs <= 0) {
      console.log(`[Whisper] chunk ${i} has 0 duration (past end of audio), skipping`);
      continue;
    }

    onChunkStart?.({ index: i, total: totalChunks, startMs, durationMs: actualDurationMs });

    // 优先级 1：调用方传了 alreadyCompletedChunks + loadChunkSegments() 返回非 null
    //   → 直接用缓存的 segments，跳过实际转录
    // 优先级 2：调用方只传了 alreadyCompletedChunks 但没缓存
    //   → 重新跑（whisper.cpp 的 -ot/-d 是幂等的，结果一致）
    // 优先级 3：不在 alreadyCompletedChunks 里
    //   → 重新跑
    let segs: TranscriptSegment[];
    if (alreadyCompletedChunks.includes(i) && loadChunkSegments) {
      const cached = await loadChunkSegments(i);
      if (cached && cached.length > 0) {
        console.log(
          `[Whisper] chunk ${i}/${totalChunks} loaded from cache (${cached.length} segments)`,
        );
        segs = cached;
      } else {
        console.log(
          `[Whisper] chunk ${i}/${totalChunks} marked done but no cached segments, re-running`,
        );
        console.log(
          `[Whisper] running chunk ${i + 1}/${totalChunks}: startMs=${startMs}, durationMs=${actualDurationMs}`,
        );
        segs = await transcribeChunk(audioPath, startMs, actualDurationMs, language, currentModelPath);
      }
    } else {
      console.log(
        `[Whisper] running chunk ${i + 1}/${totalChunks}: startMs=${startMs}, durationMs=${actualDurationMs}`,
      );
      segs = await transcribeChunk(audioPath, startMs, actualDurationMs, language, currentModelPath);
    }

    chunkSegmentsCache.set(i, segs);
    // 让调用方把 segments 持久化（fire-and-forget，不阻塞）
    if (onChunkSegmentsPersist) {
      try {
        await onChunkSegmentsPersist(i, segs);
      } catch (e) {
        console.error(`[Whisper] failed to persist segments for chunk ${i}:`, e);
      }
    }
    onChunkDone?.({ index: i, total: totalChunks, startMs, durationMs: actualDurationMs, segmentCount: segs.length });
    onProgress?.({ completedChunks: i + 1, totalChunks, currentChunk: i });
  }

  // 收集所有 chunk 的 segments
  const chunkList: { startMs: number; segments: TranscriptSegment[] }[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const segs = chunkSegmentsCache.get(i);
    if (segs && segs.length > 0) {
      const startMs = i * chunkStepMs;
      chunkList.push({ startMs, segments: segs });
    }
  }

  const merged = mergeChunkSegments(chunkList, chunkOverlapMs);
  const fullText = merged.map((s) => s.text).join('');

  console.log(
    `[Whisper] done: ${merged.length} segments (from ${chunkList.length} chunks), ${fullText.length} chars`,
  );

  return {
    language,
    fullText,
    segments: merged,
  };
}

/**
 * 给定音频时长（秒）和 chunk 参数，计算总块数。
 * 与 transcribeWithCheckpoint 内部算法保持一致。
 */
export function computeTotalChunks(
  audioSeconds: number,
  chunkDurationMs: number = CHUNK_DURATION_MS_DEFAULT,
  chunkOverlapMs: number = CHUNK_OVERLAP_MS_DEFAULT,
): number {
  const totalMs = audioSeconds * 1000;
  const chunkStepMs = chunkDurationMs - chunkOverlapMs;
  if (chunkStepMs <= 0) {
    throw new Error('chunkDurationMs must be greater than chunkOverlapMs');
  }
  if (totalMs <= 0) return 0;
  // 最后一个 chunk 可以是部分长度，所以用 ceil(total / step) + 1 ... 不对，重新算：
  // 第 i 个 chunk 覆盖 [i*step, i*step + chunkDurationMs]
  // 当 i*step + chunkDurationMs >= totalMs 时结束
  // i_max = ceil((totalMs - chunkDurationMs) / step) + 1（如果 total >= chunkDurationMs）
  //       = 0                                            （如果 total < chunkDurationMs）
  if (totalMs <= chunkDurationMs) return 1;
  return Math.ceil((totalMs - chunkDurationMs) / chunkStepMs) + 1;
}

export default {
  init,
  transcribe,
  transcribeWithCheckpoint,
  computeTotalChunks,
  isCudaAvailable,
  isReady,
};