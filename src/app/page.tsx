"use client";

import { useState } from "react";

interface TaskResult {
  article?: { id: string; title: string; content: string };
  extracted?: {
    tags: string[];
    highlights: { text: string; context: string }[];
    summary: string;
  };
  transcript?: { fullText: string };
}

interface PollData {
  status: string;
  progress: number;
  audioStatus: string | null;
  transcriptId?: string | null;
  transcriptLength?: number;
  transcriptPreview?: string | null;
  defaultPrompt?: string;
  customPrompt?: string | null;
  result?: TaskResult | null;
  error?: string | null;
  // 断点续转进度（短音频为 null）
  totalChunks?: number | null;
  completedChunks?: number | null;
  chunkDurationMs?: number | null;
  chunkOverlapMs?: number | null;
}

interface IncompleteTaskInfo {
  audioId: string;
  taskId: string;
  status: string;
  progress: number;
  completedChunks: number | null;
  totalChunks: number | null;
}

interface CompletedTranscriptRef {
  audioId: string;
  taskId: string;
}

interface UploadResponse {
  audioId: string;
  fileName: string;
  duration: number | null;
  status: string;
  contentHash?: string;
  hasIncompleteTask: boolean;
  incompleteTask: IncompleteTaskInfo | null;
  hasCompletedTranscript: boolean;
  completedTranscriptRef: CompletedTranscriptRef | null;
}

export default function Home() {
  const [uploading, setUploading] = useState(false);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TaskResult | null>(null);
  // 上传时选择的转录语言。'auto-detect-per-chunk' 每 chunk 自动检测（中英混杂最优）
  // 'mixed' = 前 5 分钟 zh + 之后 en（固定模式，适合开头中文导语+主体英文）
  const [language, setLanguage] = useState<string>("auto-detect-per-chunk");
  // 断点状态：保存用户编辑后的提示词
  const [defaultPrompt, setDefaultPrompt] = useState<string>("");
  const [editedPrompt, setEditedPrompt] = useState<string>("");
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [transcriptLength, setTranscriptLength] = useState<number>(0);
  const [transcriptPreview, setTranscriptPreview] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  // 上传后但未开始处理：等待用户决定"复用/重跑"
  const [pendingDecision, setPendingDecision] = useState<{
    audioId: string;
    incompleteTask: IncompleteTaskInfo;
  } | null>(null);

  const handleUpload = async (file: File) => {
    setUploading(true);
    setStatus("上传中...");
    const formData = new FormData();
    formData.append("file", file);

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const data: UploadResponse = await res.json();

      if (!res.ok) {
        throw new Error((data as unknown as { error?: string }).error || `Upload failed: ${res.status}`);
      }

      if (!data.audioId) {
        throw new Error("No audioId returned from server");
      }

      setAudioId(data.audioId);

      // 决策分支
      if (data.hasIncompleteTask && data.incompleteTask) {
        // 找到未完成任务，弹按钮让用户决定
        console.log(
          `[Frontend] Found incomplete task ${data.incompleteTask.taskId} at progress ${data.incompleteTask.progress}%`,
        );
        setPendingDecision({
          audioId: data.audioId,
          incompleteTask: data.incompleteTask,
        });
        setStatus("发现未完成的任务");
      } else if (data.hasCompletedTranscript && data.completedTranscriptRef) {
        // 已有完整转录，直接走复用分支
        console.log(
          `[Frontend] Found completed transcript for task ${data.completedTranscriptRef.taskId}`,
        );
        setTaskId(data.completedTranscriptRef.taskId);
        pollStatus(data.completedTranscriptRef.taskId);
      } else {
        // 全新音频，正常开始
        startTranscribe(data.audioId);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setStatus("上传超时: 文件太大或网络太慢");
      } else {
        setStatus("上传失败: " + (err instanceof Error ? err.message : String(err)));
      }
    } finally {
      setUploading(false);
    }
  };

  const startTranscribe = async (id: string, force = false) => {
    setStatus("转录中...");
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioId: id, forceTranscribe: force, language }),
    });
    const data = await res.json();
    setTaskId(data.taskId);
    pollStatus(data.taskId);
  };

  const handleResume = () => {
    if (!pendingDecision) return;
    const { incompleteTask } = pendingDecision;
    console.log(`[Frontend] Resuming task ${incompleteTask.taskId} from progress ${incompleteTask.progress}%`);
    setPendingDecision(null);
    setTaskId(incompleteTask.taskId);
    setStatus("恢复转录...");
    setProgress(incompleteTask.progress);
    // 直接轮询已有 task，不需要重新调用 transcribe API
    pollStatus(incompleteTask.taskId);
  };

  const handleRestart = () => {
    if (!pendingDecision) return;
    const { audioId } = pendingDecision;
    console.log(`[Frontend] Restarting transcription for ${audioId} (force)`);
    setPendingDecision(null);
    startTranscribe(audioId, true);
  };

  const handlePromptConfirm = async () => {
    if (!taskId || !transcriptId) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcriptId,
          taskId,
          customPrompt: editedPrompt.trim() ? editedPrompt : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "生成失败");

      setStatus("完成");
      setProgress(100);
      setResult({
        article: data.article,
        extracted: data.extracted,
        transcript: { fullText: "" },
      });
    } catch (err) {
      setStatus("生成失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  };

  const pollStatus = async (id: string) => {
    while (true) {
      const res = await fetch(`/api/task/${id}`);
      const data: PollData = await res.json();

      if (data.audioStatus === "converting") {
        setStatus("转换音频格式中...");
        setProgress(data.progress > 0 ? data.progress : 5);
      } else if (data.audioStatus === "transcribing" || data.status === "processing") {
        setStatus("转录中...");
        setProgress(data.progress);
      } else if (data.status === "waiting_for_prompt") {
        // 断点：把提示词暴露给用户，停下来等确认
        setStatus("转录完成，请审阅提示词");
        setProgress(data.progress);
        if (data.transcriptId) setTranscriptId(data.transcriptId);
        if (typeof data.transcriptLength === "number") setTranscriptLength(data.transcriptLength);
        if (data.transcriptPreview) setTranscriptPreview(data.transcriptPreview);
        if (data.defaultPrompt) {
          setDefaultPrompt(data.defaultPrompt);
          // 仅首次进入断点时预填 editedPrompt（避免每次轮询覆盖用户输入）
          setEditedPrompt((prev) => prev || data.customPrompt || data.defaultPrompt || "");
        }
        break;
      } else if (data.status === "generating") {
        setStatus("生成文章中...");
        setProgress(data.progress);
      } else if (data.status === "completed") {
        setResult(data.result || null);
        setStatus("完成");
        setProgress(100);
        break;
      } else if (data.status === "failed") {
        const errorMsg = data.error || "处理失败";
        if (errorMsg.toLowerCase().includes("ffmpeg")) {
          setStatus("ffmpeg_missing");
        } else {
          setStatus(errorMsg);
        }
        break;
      } else {
        setStatus(data.status);
        setProgress(data.progress);
      }

      await new Promise((r) => setTimeout(r, 2000));
    }
  };

  const isWaitingForPrompt = status === "转录完成，请审阅提示词";

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Podcast2Markdown</h1>

      {!audioId ? (
        <div className="space-y-4">
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
            <input
              type="file"
              accept="audio/*"
              onChange={(e) => {
                if (e.target.files?.[0]) handleUpload(e.target.files[0]);
              }}
              disabled={uploading}
              className="hidden"
              id="audio-upload"
            />
            <label htmlFor="audio-upload" className="cursor-pointer text-blue-600 hover:text-blue-800">
              {uploading ? "上传中..." : "点击选择音频文件 或 拖拽到此处"}
            </label>
            <p className="text-gray-500 text-sm mt-2">支持 MP3, WAV, M4A 等格式</p>
          </div>

          {/* 转录语言选择 */}
          <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
            <label
              htmlFor="language-select"
              className="block text-sm font-medium text-gray-700 mb-2"
            >
              转录语言
            </label>
            <select
              id="language-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={uploading}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="auto-detect-per-chunk">每 chunk 自动检测（中英混杂最优，推荐）</option>
              <option value="mixed">中英混杂固定模式（前 5 分钟中文 + 之后英文）</option>
              <option value="zh">中文（仅）</option>
              <option value="en">English</option>
              <option value="auto">整体自动检测（不可靠：whisper.cpp 只检测一次然后锁死，保留兼容）</option>
              <option value="ja">日本語</option>
              <option value="ko">한국어</option>
              <option value="fr">Français</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
              <option value="ru">Русский</option>
            </select>
            <p className="text-gray-500 text-xs mt-2">
              中英混杂音频推荐 "每 chunk 自动检测"（每 5 分钟单独检测语言）。
              每个 chunk 多 ~30 秒采样，全长 17 个 chunk 多 ~9 分钟。
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-gray-100 rounded-lg p-4">
            <p className="font-medium">
              状态:{" "}
              {status === "ffmpeg_missing"
                ? "FFmpeg 未安装"
                : status}
            </p>
            {status === "ffmpeg_missing" ? (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <h3 className="text-red-800 font-bold mb-2">系统未安装 FFmpeg</h3>
                <p className="text-red-600 mb-3">请安装 FFmpeg 后重试：</p>
                <ul className="text-sm text-red-700 space-y-1 mb-3">
                  <li>
                    <code className="bg-red-100 px-2 py-1 rounded">Windows:</code> winget install Gyan.FFmpeg
                  </li>
                  <li>
                    <code className="bg-red-100 px-2 py-1 rounded">macOS:</code> brew install ffmpeg
                  </li>
                  <li>
                    <code className="bg-red-100 px-2 py-1 rounded">Ubuntu:</code> sudo apt install ffmpeg
                  </li>
                </ul>
                <a
                  href="https://ffmpeg.org/download.html"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:text-blue-800 text-sm underline"
                >
                  安装指南: https://ffmpeg.org/download.html
                </a>
              </div>
            ) : pendingDecision ? null : progress > 0 && !isWaitingForPrompt ? (
              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            ) : null}
          </div>

          {/* 决策弹窗：发现未完成任务时 */}
          {pendingDecision && (
            <div className="bg-white border-2 border-amber-300 rounded-lg p-4 space-y-3">
              <h2 className="text-lg font-bold mb-1">发现未完成的任务</h2>
              <p className="text-sm text-gray-600">
                这个文件（SHA-256 匹配）之前有过一次转录，已完成
                {" "}
                <span className="font-semibold">
                  {pendingDecision.incompleteTask.completedChunks !== null &&
                  pendingDecision.incompleteTask.totalChunks
                    ? `${pendingDecision.incompleteTask.completedChunks}/${pendingDecision.incompleteTask.totalChunks} 个分块`
                    : `${pendingDecision.incompleteTask.progress}%`}
                </span>
                。
              </p>
              <p className="text-sm text-gray-600">选择要怎么处理：</p>
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={handleResume}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  直接处理（继续）
                </button>
                <button
                  type="button"
                  onClick={handleRestart}
                  className="flex-1 px-4 py-2 bg-white text-gray-700 border border-gray-300 rounded hover:bg-gray-50"
                >
                  重新处理
                </button>
              </div>
            </div>
          )}

          {isWaitingForPrompt && (
            <div className="bg-white border-2 border-blue-300 rounded-lg p-4 space-y-4">
              <div>
                <h2 className="text-lg font-bold mb-1">转录完成</h2>
                <p className="text-sm text-gray-600">
                  转录文本共 <span className="font-semibold">{transcriptLength.toLocaleString()}</span> 字。
                  下面是默认的 system prompt，你可以编辑后点击按钮生成文章。
                </p>
                <details className="mt-2 bg-gray-50 rounded">
                  <summary className="px-3 py-2 cursor-pointer text-sm text-gray-700 hover:bg-gray-100">
                    查看转录文本预览（前 200 字）
                  </summary>
                  <div className="p-3 text-xs text-gray-600 whitespace-pre-wrap">
                    {transcriptPreview}
                    {transcriptLength > 200 ? "..." : ""}
                  </div>
                </details>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  System Prompt（可编辑）
                </label>
                <textarea
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  rows={16}
                  className="w-full font-mono text-xs border border-gray-300 rounded p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  spellCheck={false}
                />
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => setEditedPrompt(defaultPrompt)}
                    className="text-xs px-3 py-1 border border-gray-300 rounded text-gray-600 hover:bg-gray-100"
                    disabled={submitting}
                  >
                    重置为默认
                  </button>
                  <button
                    type="button"
                    onClick={handlePromptConfirm}
                    disabled={submitting || !transcriptId}
                    className="ml-auto px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
                  >
                    {submitting ? "生成中..." : "使用此提示词生成文章"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {result && result.article && (
            <div className="bg-white border rounded-lg p-4">
              <h2 className="text-xl font-bold mb-2">{result.article.title}</h2>
              <div className="text-sm text-gray-500 mb-4">
                标签: {result.extracted?.tags?.join(", ")}
              </div>

              {result.transcript?.fullText && (
                <div className="mb-4">
                  <details className="bg-gray-100 rounded">
                    <summary className="px-4 py-2 cursor-pointer font-medium text-gray-700 hover:bg-gray-200 rounded">
                      原始转录文字
                    </summary>
                    <div className="p-4 bg-gray-50 overflow-auto max-h-64">
                      <pre className="whitespace-pre-wrap text-sm text-gray-600">
                        {result.transcript.fullText}
                      </pre>
                    </div>
                  </details>
                </div>
              )}

              <div className="bg-gray-50 rounded p-4 overflow-auto max-h-96">
                <pre className="whitespace-pre-wrap text-sm" id="markdown-content">
                  {result.article.content}
                </pre>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => {
                    const content = result.article?.content;
                    if (content) {
                      navigator.clipboard.writeText(content).then(() => {
                        alert("内容已复制到剪贴板");
                      }).catch(() => {
                        alert("复制失败，请手动复制");
                      });
                    }
                  }}
                  className="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
                >
                  复制内容
                </button>
                <button
                  onClick={() => window.open(`/api/export/${result.article?.id}`)}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  下载 Markdown
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}