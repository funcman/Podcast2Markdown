import ffmpeg from 'fluent-ffmpeg';
import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

let ffprobePath: string = 'ffprobe';

function initFfprobePath(): void {
  if (ffprobePath !== 'ffprobe') return;
  
  try {
    const ffprobe = require('@ffprobe-installer/ffprobe');
    ffprobePath = ffprobe.path;
  } catch {
    ffprobePath = 'ffprobe';
  }
}

/**
 * FFMPEG_NOT_INSTALLED 错误类
 * 当系统未安装 ffmpeg 或 ffmpeg 不在 PATH 中时抛出
 */
export class FfmpegNotInstalledError extends Error {
  constructor(message = 'FFmpeg is not installed or not found in PATH') {
    super(message);
    this.name = 'FFMPEG_NOT_INSTALLED';
  }
}

/**
 * 音频信息接口
 */
export interface AudioInfo {
  duration: number;  // 时长（秒）
  format: string;    // 格式
}

/**
 * 检测 ffmpeg 是否已安装
 * @returns Promise<boolean> - ffmpeg 是否可用
 */
export async function isFfmpegInstalled(): Promise<boolean> {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取音频文件信息
 * @param path - 音频文件路径
 * @returns Promise<AudioInfo> - 包含时长和格式的音频信息
 * @throws FfmpegNotInstalledError - 当 ffmpeg 未安装时
 */
export async function getAudioInfo(path: string): Promise<AudioInfo> {
  initFfprobePath();
  ffmpeg.setFfprobePath(ffprobePath);
  
  const ffmpegInstalled = await isFfmpegInstalled();
  if (!ffmpegInstalled) {
    throw new FfmpegNotInstalledError();
  }

  return new Promise((resolve, reject) => {
    ffmpeg(path).ffprobe((err: Error | null, metadata: ffmpeg.FfprobeData) => {
      if (err) {
        reject(err);
        return;
      }
      if (!metadata.format) {
        reject(new Error('Failed to get audio format information'));
        return;
      }
      resolve({
        duration: parseFloat(String(metadata.format.duration || '0')),
        format: metadata.format.format_name || 'unknown'
      });
    });
  });
}

/**
 * 将音频文件转换为 WAV 格式（16kHz, 16-bit, 单声道）
 * @param inputPath - 输入文件路径
 * @param outputPath - 输出文件路径
 * @returns Promise<void>
 * @throws FfmpegNotInstalledError - 当 ffmpeg 未安装时
 */
export async function convertToWav(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const ffmpegInstalled = await isFfmpegInstalled();
  if (!ffmpegInstalled) {
    throw new FfmpegNotInstalledError();
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec('pcm_s16le')           // 16-bit PCM
      .audioChannels(1)                    // 单声道
      .audioFrequency(16000)               // 16kHz 采样率
      .format('wav')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}
