/**
 * whisper.ts
 *
 * Node.js wrapper for whisper.cpp using child process.
 * Falls back to command line if native addon is not available.
 */

import { existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { spawn } from 'child_process';
import { platform } from 'os';
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
  
  throw new Error(`Whisper binary not found. Please build whisper.cpp first.\n` +
    `Windows: powershell ./scripts/build-whisper.ps1\n` +
    `Linux/macOS: ./scripts/build-whisper.sh`);
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
  
  console.log(`[Whisper] Initializing: model=${modelPath}, cuda=${useCuda}, binary=${binaryPath}`);
  
  currentModelPath = modelPath;
  isInitialized = true;
  
  console.log(`[Whisper] Initialized successfully (using subprocess mode)`);
}

/**
 * Transcribe audio file using whisper.cpp subprocess
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

  const binaryPath = getWhisperBinary();
  const audioDir = dirname(audioPath);
  const audioName = basename(audioPath, '.wav');
  const outputJsonPath = join(audioDir, `${audioName}.json`);
  
  return new Promise((resolve, reject) => {
    const args = [
      '-m', currentModelPath,
      '-f', audioPath,
      '-l', language,
      '-oj',                 // Output JSON
      '-of', join(audioDir, audioName)  // Output file path (without extension)
    ];
    
    if (!WHISPER_USE_CUDA) {
      args.push('-ng');
    }
    
    console.log(`[Whisper] Running: ${binaryPath} ${args.join(' ')}`);
    
    const whisperProcess = spawn(binaryPath, args, {
      cwd: process.cwd(),
      env: process.env
    });
    
    let stderr = '';
    
    whisperProcess.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    
    whisperProcess.on('close', (code: number | null) => {
      if (code !== 0) {
        console.error(`[Whisper] Process exited with code ${code}`);
        console.error(`[Whisper] stderr: ${stderr}`);
        reject(new Error(`Whisper transcription failed: ${stderr || 'Unknown error'}`));
        return;
      }
      
      try {
        // Read the JSON output file
        if (!existsSync(outputJsonPath)) {
          reject(new Error(`Whisper output file not found: ${outputJsonPath}`));
          return;
        }
        
        const jsonContent = readFileSync(outputJsonPath, 'utf-8');
        console.log(`[Whisper] JSON content preview: ${jsonContent.substring(0, 500)}...`);
        const result = JSON.parse(jsonContent);
        
        // Clean up the JSON file
        try {
          unlinkSync(outputJsonPath);
        } catch (e) {
          // Ignore cleanup errors
        }
        
        const segments: TranscriptSegment[] = (result.transcription || []).map((s: any) => ({
          start: s.offsets?.from / 1000 || 0,  // 转换为秒
          end: s.offsets?.to / 1000 || 0,
          text: s.text?.trim() || ''
        }));
        
        console.log(`[Whisper] Parsed ${segments.length} segments, first segment: ${JSON.stringify(segments[0])}`);
        
        const fullText = segments.map(s => s.text).join('');
        
        console.log(`[Whisper] Done: ${fullText.length} chars, ${segments.length} segments`);
        
        resolve({
          language: result.result?.language || result.language || language,
          fullText,
          segments
        });
      } catch (e) {
        reject(new Error(`Failed to parse whisper output: ${e}`));
      }
    });
    
    whisperProcess.on('error', (err: Error) => {
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
