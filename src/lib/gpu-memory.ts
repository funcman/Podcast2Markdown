/**
 * gpu-memory.ts
 *
 * GPU 显存清理工具。专门应对 Windows + NVIDIA WDDM 驱动层的"僵尸 CUDA context"问题。
 *
 * 问题：
 *  - whisper-cli / main.exe 异常退出时（被 SIGKILL/taskkill /F、CUDA OOM、driver crash），
 *    NVIDIA WDDM 驱动有时不立即回收它持有的 CUDA context
 *  - 结果：nvidia-smi 看不到任何进程在用，但 memory.used 仍显示几百 MB 到几 GB
 *  - 下次调 whisper-cli 时 cudaMalloc 失败 → 0xC0000005 (3221226505) 崩溃
 *
 * 修复：
 *  - 强制重置 GPU 驱动：Disable-PnpDevice → Enable-PnpDevice（闪屏 1-2 秒，显存 100% 释放）
 *  - 或者更稳的：cmd /c taskkill 所有相关进程
 *
 * 跨平台：
 *  - Windows: 用 PowerShell 重置 NVIDIA PnP 设备
 *  - 其他平台: 不需要（Linux/Mac 不会有这个问题）
 */

import { spawn } from 'child_process';
import { platform } from 'os';

/**
 * 检查是否有其他 GPU 进程在跑（main.exe / whisper-cli）。
 * 如果有，调用者应该先决定要不要杀（可能影响其他任务）。
 */
export async function listGpuProcesses(): Promise<number[]> {
  if (platform() !== 'win32') return [];
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process | Where-Object { $_.ProcessName -in @("main","whisper-cli","whisper-cli.exe","main.exe") } | Select-Object -ExpandProperty Id',
      ],
      { windowsHide: true },
    );
    let out = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    ps.on('close', () => {
      const ids = out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      resolve(ids);
    });
    ps.on('error', () => resolve([]));
  });
}

/**
 * 强杀残留 whisper 进程（自己跑过的）。
 * 注意：只杀 main / whisper-cli，不杀其他 GPU 程序（Premiere、Blender 等）。
 */
export async function killWhisperProcesses(): Promise<number> {
  if (platform() !== 'win32') return 0;
  return new Promise((resolve) => {
    const ps = spawn(
      'taskkill',
      ['/F', '/T', '/IM', 'main.exe', '/IM', 'whisper-cli.exe'],
      { windowsHide: true },
    );
    let killed = 0;
    ps.stdout.on('data', (d) => {
      const m = d.toString().match(/SUCCESS:\s*(\d+)/g);
      if (m) killed += m.length;
    });
    ps.on('close', () => resolve(killed));
    ps.on('error', () => resolve(0));
  });
}

/**
 * 重置 NVIDIA GPU 驱动。
 * 流程：
 *   1. 找 NVIDIA Display adapter（NVIDIA\VEN_10DE）
 *   2. Disable-PnpDevice（驱动卸载，闪屏）
 *   3. 等 2 秒
 *   4. Enable-PnpDevice（驱动加载回来）
 *   5. 等 3 秒让驱动初始化完成
 *
 * ⚠️ 会闪屏 1-2 秒
 * ⚠️ 会杀掉所有用 GPU 的进程（包括其他应用的）
 * ⚠️ 非 Windows 直接返回 false
 */
export async function resetNvidiaDriver(): Promise<boolean> {
  if (platform() !== 'win32') return false;
  return new Promise((resolve) => {
    const script = `
      $device = Get-PnpDevice -Class Display -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VEN_10DE' } | Select-Object -First 1
      if (-not $device) { Write-Host 'NO_DEVICE'; exit 1 }
      Write-Host "RESET $($device.InstanceId)"
      Disable-PnpDevice -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 2
      Enable-PnpDevice  -InstanceId $device.InstanceId -Confirm:$false -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3
      Write-Host 'DONE'
    `;
    const ps = spawn(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    );
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    ps.stderr.on('data', (d) => (err += d.toString()));
    ps.on('close', (code) => {
      const ok = out.includes('DONE') || out.includes('RESET');
      resolve(ok);
    });
    ps.on('error', () => resolve(false));
  });
}

/**
 * 完整流程：杀残留 + 重置驱动。
 * 大约 5-6 秒完成（杀 0.1s + 驱动重置 5s）。
 */
export async function recoverGpuMemory(): Promise<{
  killed: number;
  reset: boolean;
}> {
  const killed = await killWhisperProcesses();
  const reset = await resetNvidiaDriver();
  return { killed, reset };
}