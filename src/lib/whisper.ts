const WHISPER_API_KEY = process.env.WHISPER_API_KEY;
const WHISPER_API_BASE = process.env.WHISPER_API_BASE || "https://api.lingyaai.cn/v1";

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

export async function transcribeAudio(filePath: string, timeoutMs: number = 600000): Promise<TranscribeResult> {
  const fs = await import("fs");
  const fileBuffer = await fs.promises.readFile(filePath);

  // 获取文件扩展名来决定 MIME 类型
  const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3';
  const mimeType = ext === 'm4a' ? 'audio/mp4' : ext === 'mp3' ? 'audio/mpeg' : `audio/${ext}`;

  console.log(`[Whisper] Starting transcription for ${filePath}, size: ${fileBuffer.length} bytes, mime: ${mimeType}`);

  const url = `${WHISPER_API_BASE}/audio/transcriptions`;
  console.log(`[Whisper] URL: ${url}`);

  // 创建一个简单的 Promise.race 实现超时
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`Whisper API timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  const fetchPromise = (async () => {
    const formData = new FormData();
    const blob = new Blob([fileBuffer], { type: mimeType });
    formData.append('file', blob, `audio.${ext}`);
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WHISPER_API_KEY}`,
      },
      body: formData,
    });

    return response;
  })();

  const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Whisper] API error: ${response.status} - ${errorText}`);
    throw new Error(`Whisper API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  console.log(`[Whisper] Transcription completed, text length: ${data.text?.length || 0}`);

  const segments: TranscriptSegment[] = (data.segments || []).map((seg: any) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
  }));

  return {
    language: data.language || 'zh',
    fullText: data.text?.trim() || '',
    segments,
  };
}
