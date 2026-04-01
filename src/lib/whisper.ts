/**
 * whisper.ts
 *
 * Node.js wrapper for whisper.cpp with CUDA support.
 * Uses the native whisper_addon module.
 *
 * Build order:
 *   1. ./scripts/build-whisper.sh    # Build whisper.cpp with CUDA
 *   2. npm run build:addon            # Build this native addon
 *
 * Usage:
 *   import { init, transcribe } from './lib/whisper';
 *   await init({ model: 'path/to/model.bin', cuda: true });
 *   const result = await transcribe('/path/to/audio.wav');
 */

import { existsSync } from 'fs';
import { resolve } from 'path';

// Environment configuration
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || 'whisper.cpp/models/ggml-large.bin';
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

// Global addon instance
let addon: any = null;
let isInitialized = false;

/**
 * Load the native addon
 */
function getAddon() {
  if (addon) return addon;

  const tryLoad = (paths: string[]) => {
    for (const p of paths) {
      try {
        addon = require(p);
        return true;
      } catch {
        continue;
      }
    }
    return false;
  };

  if (tryLoad([
    resolve(__dirname, '../addon/whisper_addon'),
    resolve(__dirname, '../../build/Release/whisper_addon'),
    resolve(__dirname, '../../build/Debug/whisper_addon'),
  ])) {
    return addon;
  }

  throw new Error(`
================================================================================
Failed to load whisper_addon.native

Build steps:
  1. Build whisper.cpp with CUDA:
     ./scripts/build-whisper.sh

  2. Build this native addon:
     npm run build:addon

Or for manual build:
  npm install node-addon-api node-gyp
  npx node-gyp configure
  npx node-gyp build --debug
================================================================================
`);
}

/**
 * Initialize Whisper with model
 */
export async function init(config: WhisperConfig = {}): Promise<void> {
  const whisper = getAddon();

  // Default model path from env or config
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

  console.log(`[Whisper] Initializing: model=${modelPath}, cuda=${useCuda}`);

  // Call init on the addon - returns object with success, modelPath, cudaEnabled
  const result = whisper.WhisperAddon.init(modelPath, useCuda);

  if (!result || !result.success) {
    throw new Error(`Failed to initialize whisper: ${JSON.stringify(result)}`);
  }

  console.log(`[Whisper] Initialized successfully`);
  isInitialized = true;
}

/**
 * Transcribe audio file
 */
export async function transcribe(
  audioPath: string,
  language: string = 'zh'
): Promise<TranscribeResult> {
  if (!isInitialized) {
    throw new Error('Whisper not initialized. Call whisper.init() first.');
  }

  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  console.log(`[Whisper] Transcribing: ${audioPath} (lang=${language})`);

  const whisper = getAddon();
  const result = whisper.WhisperAddon.transcribe(audioPath, language);

  if (!result) {
    throw new Error('Transcription returned null');
  }

  console.log(`[Whisper] Done: ${result.fullText.length} chars, ${result.segments?.length || 0} segments`);

  return {
    language: result.language || language,
    fullText: result.fullText || '',
    segments: (result.segments || []).map((s: any) => ({
      start: s.start,
      end: s.end,
      text: s.text,
    })),
  };
}

/**
 * Check if CUDA is available
 */
export async function isCudaAvailable(): Promise<boolean> {
  try {
    const whisper = getAddon();
    const helpers = whisper.helpers;
    if (helpers && typeof helpers.isCudaAvailable === 'function') {
      return helpers.isCudaAvailable();
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if whisper is ready
 */
export function isReady(): boolean {
  return isInitialized;
}

/**
 * Find default model path
 */
function findDefaultModelPath(): string {
  const candidates = [
    resolve(process.cwd(), 'whisper.cpp/models/ggml-large.bin'),
    resolve(process.cwd(), 'whisper.cpp/models/ggml-medium.bin'),
    resolve(process.cwd(), 'models/ggml-large.bin'),
    resolve(process.cwd(), 'models/ggml-medium.bin'),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      return p;
    }
  }

  // Return first candidate as default (will fail if not exists)
  return candidates[0];
}

export default { init, transcribe, isCudaAvailable, isReady };
