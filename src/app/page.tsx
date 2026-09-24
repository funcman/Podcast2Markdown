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
}

export default function Home() {
  const [uploading, setUploading] = useState(false);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TaskResult | null>(null);
  // 断点状态：保存用户编辑后的提示词
  const [defaultPrompt, setDefaultPrompt] = useState<string>("");
  const [editedPrompt, setEditedPrompt] = useState<string>("");
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [transcriptLength, setTranscriptLength] = useState<number>(0);
  const [transcriptPreview, setTranscriptPreview] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

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

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Upload failed: ${res.status}`);
      }

      if (!data.audioId) {
        throw new Error("No audioId returned from server");
      }

      setAudioId(data.audioId);
      startTranscribe(data.audioId);
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

  const startTranscribe = async (id: string) => {
    setStatus("转录中...");
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioId: id }),
    });
    const data = await res.json();
    setTaskId(data.taskId);
    pollStatus(data.taskId);
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
            ) : progress > 0 && !isWaitingForPrompt ? (
              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            ) : null}
          </div>

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