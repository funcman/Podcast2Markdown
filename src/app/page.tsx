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
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      setAudioId(data.audioId);
      startTranscribe(data.audioId);
    } catch (err) {
      console.error(err);
      setStatus("上传失败");
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
      setStatus(data.status === "processing" ? "转录中..." : data.status);
      setProgress(data.progress);

      if (data.status === "completed") {
        setResult(data.result);
        setStatus("完成");
        break;
      }
      if (data.status === "failed") {
        setStatus(data.error || "转录失败");
        break;
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
            onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
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
            <p className="font-medium">状态: {status}</p>
            {progress > 0 && (
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
                <pre className="whitespace-pre-wrap text-sm">
                  {result.article?.content}
                </pre>
              </div>
              <button
                onClick={() => window.open(`/api/export/${result.article?.id}`)}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                下载 Markdown
              </button>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
