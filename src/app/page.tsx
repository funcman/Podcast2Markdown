"use client";

import { useState } from "react";

export default function Home() {
  const [uploading, setUploading] = useState(false);
  const [audioId, setAudioId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<any>(null);

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
      
      console.log("Upload response status:", res.status);
      const data = await res.json();
      console.log("Upload response data:", data);
      
      if (!res.ok) {
        throw new Error(data.error || `Upload failed: ${res.status}`);
      }
      
      if (!data.audioId) {
        throw new Error("No audioId returned from server");
      }
      
      setAudioId(data.audioId);
      startTranscribe(data.audioId);
    } catch (err) {
      console.error("Upload error:", err);
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

  const pollStatus = async (id: string) => {
    while (true) {
      const res = await fetch(`/api/task/${id}`);
      const data = await res.json();
      
      console.log("Poll status:", data);
      
      if (data.audioStatus === "converting") {
        setStatus("转换音频格式中...");
        setProgress(data.progress > 0 ? data.progress : 5);
      } else if (data.audioStatus === "transcribing" || data.status === "processing") {
        setStatus("转录中...");
        setProgress(data.progress);
      } else if (data.status === "generating") {
        setStatus("生成文章中...");
        setProgress(data.progress);
      } else if (data.status === "completed") {
        setResult(data.result);
        setStatus("完成");
        setProgress(100);
        break;
      } else if (data.status === "failed") {
        const errorMsg = data.error || "转录失败";
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

  return (
    <main className="min-h-screen p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Podcast2Markdown</h1>

      {!audioId ? (
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center">
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => {
              console.log("File selected:", e.target.files);
              if (e.target.files?.[0]) {
                console.log("Starting upload for file:", e.target.files[0].name);
                handleUpload(e.target.files[0]);
              }
            }}
            disabled={uploading}
            className="hidden"
            id="audio-upload"
          />
          <label
            htmlFor="audio-upload"
            className="cursor-pointer text-blue-600 hover:text-blue-800"
          >
            {uploading ? "上传中..." : "点击选择音频文件 或 拖拽到此处"}
          </label>
          <p className="text-gray-500 text-sm mt-2">支持 MP3, WAV, M4A 等格式</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-gray-100 rounded-lg p-4">
            <p className="font-medium">状态: {status === "ffmpeg_missing" ? "FFmpeg 未安装" : status}</p>
            {status === "ffmpeg_missing" ? (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
                <h3 className="text-red-800 font-bold mb-2">系统未安装 FFmpeg</h3>
                <p className="text-red-600 mb-3">请安装 FFmpeg 后重试：</p>
                <ul className="text-sm text-red-700 space-y-1 mb-3">
                  <li><code className="bg-red-100 px-2 py-1 rounded">Windows:</code> winget install Gyan.FFmpeg</li>
                  <li><code className="bg-red-100 px-2 py-1 rounded">macOS:</code> brew install ffmpeg</li>
                  <li><code className="bg-red-100 px-2 py-1 rounded">Ubuntu:</code> sudo apt install ffmpeg</li>
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
            ) : progress > 0 && (
              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>

          {result && (
            <div className="bg-white border rounded-lg p-4">
              <h2 className="text-xl font-bold mb-2">{result.article?.title}</h2>
              <div className="text-sm text-gray-500 mb-4">
                标签: {result.extracted?.tags?.join(", ")}
              </div>
              <div className="bg-gray-50 rounded p-4 overflow-auto max-h-96">
                <pre className="whitespace-pre-wrap text-sm" id="markdown-content">
                  {result.article?.content}
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
