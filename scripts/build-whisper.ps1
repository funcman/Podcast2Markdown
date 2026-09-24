# build-whisper.ps1
#
# Build whisper.cpp with CUDA support on Windows
# Requires: CMake, MSVC, CUDA Toolkit
#
# Usage:
#   .\scripts\build-whisper.ps1                          # Default: large-v3 model + CUDA
#   .\scripts\build-whisper.ps1 small                    # Small model
#   .\scripts\build-whisper.ps1 large-v3-turbo           # Turbo (faster, slightly less accurate than v3)
#   .\scripts\build-whisper.ps1 medium-q5_0              # Quantized medium (smaller, faster)
#   .\scripts\build-whisper.ps1 ggml-large-v3-q5_0.bin   # Full filename form also accepted
#   .\scripts\build-whisper.ps1 -CPU                     # CPU only
#   .\scripts\build-whisper.ps1 large -GPUArch 86        # Specify GPU arch manually
#
# Aliases: tiny | base | small | medium | large (large => large-v3)
# All models listed at https://huggingface.co/ggerganov/whisper.cpp are supported.

param(
    [string]$ModelSize = "large",
    [switch]$CPU,
    [string]$GPUArch = ""
)

$ErrorActionPreference = "Continue"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$WhisperDir = Join-Path $ProjectRoot "whisper.cpp"
$BuildDir = Join-Path $WhisperDir "build"

$UseCUDA = -not $CPU
if ($ModelSize -eq "-CPU") {
    $UseCUDA = $false
    $ModelSize = "large"
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Building whisper.cpp"
Write-Host "  Model size: $ModelSize"
Write-Host "  CUDA: $(if ($UseCUDA) { 'enabled' } else { 'disabled' })"
Write-Host "  Build dir: $BuildDir"
Write-Host "============================================"

# Check prerequisites
function Test-Command($cmd) {
    try { Get-Command $cmd -ErrorAction Stop } catch { return $false }
    return $true
}

$missing = @()
if (-not (Test-Command "cmake")) { $missing += "CMake" }
if (-not (Test-Command "git")) { $missing += "Git" }

if ($missing.Count -gt 0) {
    Write-Host "Missing dependencies: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Install them before running this script" -ForegroundColor Yellow
    exit 1
}

$UseNinja = Test-Command "ninja"
if (-not $UseNinja) {
    Write-Host "Ninja not found, will use MSBuild" -ForegroundColor Yellow
}

if ($UseCUDA) {
    $hasCUDA = Test-Command "nvcc"
    if (-not $hasCUDA) {
        Write-Host "CUDA requested but nvcc not found, disabling CUDA" -ForegroundColor Yellow
        $UseCUDA = $false
    }
}

# ---------------------------------------------------------------------------
# Auto-detect GPU architecture from nvidia-smi
# ---------------------------------------------------------------------------
function Get-DetectedGPUArch() {
    if (-not (Test-Command "nvidia-smi")) {
        return $null
    }

    try {
        $smiOutput = & nvidia-smi --query-gpu=name --format=csv,noheader 2>$null
        if ($null -eq $smiOutput -or $smiOutput.Trim() -eq "") {
            return $null
        }
        $gpuName = $smiOutput.Trim()
        Write-Host "  Detected GPU: $gpuName" -ForegroundColor Gray

        # Map GPU name -> compute architecture, using hashtable for correctness
        $gpuMap = @{
            "RTX 5090" = "100";  "RTX 5080" = "100";  "RTX 5070" = "100"  # Blackwell
            "RTX 4090" = "89";   "RTX 4080" = "89";   "RTX 4070" = "89";   "RTX 4060" = "89"  # Ada Lovelace
            "RTX 3090" = "86";   "RTX 3080" = "86";   "RTX 3070" = "86";   "RTX 3060" = "86";   "RTX 3050" = "86"  # Ampere
            "RTX A6000" = "86";  "RTX A5000" = "86";  "RTX A4000" = "86";  "RTX A3000" = "86"  # Ampere
            "GTX 1660"  = "75";  "GTX 1650"  = "75"   # Turing
            "GTX 1080"  = "61";  "GTX 1070"  = "61";  "GTX 1060"  = "61";  "GTX 1050"  = "61"  # Pascal
            "GTX 980"   = "52";  "GTX 970"   = "52";  "GTX 960"   = "52";  "GTX 750"   = "52";  "GTX 650"   = "52"  # Maxwell
            "TITAN V"   = "70";  "V100"      = "70"   # Volta
            "A100"      = "80"                       # Ampere
            "H100"      = "90";  "H200"      = "90"   # Hopper
            "RTX 5000"  = "75";  "RTX 4000"  = "75";  "RTX 3000"  = "75"  # Turing
        }

        foreach ($gpuKey in $gpuMap.Keys) {
            if ($gpuName -like "*$gpuKey*") {
                $arch = $gpuMap[$gpuKey]
                Write-Host "  Matched GPU arch: $arch" -ForegroundColor Gray
                return $arch
            }
        }

        Write-Host "  Unknown GPU, could not auto-detect arch. Using default." -ForegroundColor Yellow
        return $null
    } catch {
        Write-Host "  nvidia-smi query failed: $_" -ForegroundColor Yellow
        return $null
    }
}

# Auto-detect if not specified
if ($UseCUDA -and $GPUArch -eq "") {
    $detected = Get-DetectedGPUArch
    if ($null -ne $detected) {
        $GPUArch = $detected
    } else {
        Write-Host "  Could not auto-detect GPU arch. Will let CMake auto-select." -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# Clone whisper.cpp (skip if already exists and complete)
# ---------------------------------------------------------------------------
Write-Host "[1/3] Cloning whisper.cpp..." -ForegroundColor Green
$needClone = $true
if (Test-Path $WhisperDir) {
    $cmakeLists = Join-Path $WhisperDir "CMakeLists.txt"
    if (Test-Path $cmakeLists) {
        Write-Host "  whisper.cpp already exists, skipping clone" -ForegroundColor Gray
        $needClone = $false
    } else {
        Remove-Item -Recurse -Force $WhisperDir
    }
}

# Required for CCCL/CUDA 13.2+ with MSVC to avoid preprocessor error
$env:CCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING = "1"
Write-Host "  CCCL preprocessor warning suppressed via environment variable" -ForegroundColor Gray
if ($needClone) {
    git clone --depth 1 --branch v1.7.1 https://github.com/ggerganov/whisper.cpp.git $WhisperDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Git clone failed, trying again..." -ForegroundColor Yellow
        git clone --branch v1.7.1 https://github.com/ggerganov/whisper.cpp.git $WhisperDir
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Git clone failed permanently" -ForegroundColor Red
            exit 1
        }
    }
}

# Remove old build directory if exists
$OldBuildDir = Join-Path $WhisperDir "build"
if (Test-Path $OldBuildDir) {
    Remove-Item -Recurse -Force $OldBuildDir
}

Set-Location $WhisperDir

# Download model
# Accept any model name from the upstream list (https://huggingface.co/ggerganov/whisper.cpp):
#   tiny, tiny.en, tiny-q5_1, tiny.en-q5_1, tiny-q8_0,
#   base, base.en, base-q5_1, base.en-q5_1, base-q8_0,
#   small, small.en, small.en-tdrz, small-q5_1, small.en-q5_1, small-q8_0,
#   medium, medium.en, medium-q5_0, medium.en-q5_0, medium-q8_0,
#   large-v1, large-v2, large-v2-q5_0, large-v2-q8_0,
#   large-v3, large-v3-q5_0, large-v3-turbo, large-v3-turbo-q5_0, large-v3-turbo-q8_0
# The tdrz variant lives in a separate repo (akashmjn/tinydiarize-whisper.cpp).
# Convenience size aliases: tiny|base|small|medium|large (large => large-v3).
$ValidModels = @(
    "tiny", "tiny.en", "tiny-q5_1", "tiny.en-q5_1", "tiny-q8_0",
    "base", "base.en", "base-q5_1", "base.en-q5_1", "base-q8_0",
    "small", "small.en", "small.en-tdrz", "small-q5_1", "small.en-q5_1", "small-q8_0",
    "medium", "medium.en", "medium-q5_0", "medium.en-q5_0", "medium-q8_0",
    "large-v1", "large-v2", "large-v2-q5_0", "large-v2-q8_0",
    "large-v3", "large-v3-q5_0", "large-v3-turbo", "large-v3-turbo-q5_0", "large-v3-turbo-q8_0"
)
$SizeAliasMap = @{
    "tiny"   = "tiny"
    "base"   = "base"
    "small"  = "small"
    "medium" = "medium"
    "large"  = "large-v3"   # canonical large for highest accuracy; use large-v3-turbo explicitly for speed
}

# tdrz (tinydiarize) variants live in a separate HuggingFace repo
$UseTdrz = $false

# Strip an optional leading `ggml-` and trailing `.bin` so users can pass either form
$Normalized = $ModelSize -replace '^ggml-', '' -replace '\.bin$', ''

if ($SizeAliasMap.ContainsKey($Normalized)) {
    $ModelName = $SizeAliasMap[$Normalized]
} elseif ($ValidModels -contains $Normalized) {
    $ModelName = $Normalized
} else {
    Write-Host "Unknown model '$ModelSize'." -ForegroundColor Red
    Write-Host "Available sizes: $($ValidModels -join ', ')" -ForegroundColor Yellow
    Write-Host "Aliases: tiny, base, small, medium, large" -ForegroundColor Yellow
    exit 1
}

if ($ModelName -like "*-tdrz*") {
    $UseTdrz = $true
}

$ModelFile = "ggml-${ModelName}.bin"
$ModelPath = Join-Path $WhisperDir "models\$ModelFile"

# Minimum size threshold: well below any real model (smallest is ggml-tiny.bin ~75 MB).
# Real check is the magic number; size threshold is a backstop.
if ($ModelFile -match '^ggml-(tiny|base)\.') {
    $MinSizeBytes = 30MB
} elseif ($ModelFile -match '^ggml-small') {
    $MinSizeBytes = 100MB
} elseif ($ModelFile -match '^ggml-medium') {
    $MinSizeBytes = 100MB   # also covers q5_1/q8_0 quantized variants (~500MB+)
} elseif ($ModelFile -match '^ggml-large') {
    $MinSizeBytes = 500MB   # covers full (~3.1 GB) and q5_1 quantized (~1.1 GB)
} else {
    $MinSizeBytes = 30MB
}

# Validate existing model file
function Test-ModelValid($path, $minBytes) {
    if (-not (Test-Path $path)) { return $false }
    $size = (Get-Item $path).Length
    if ($size -lt $minBytes) { return $false }

    # Check ggml magic: "ggml" = 0x67676d6c (little-endian) at offset 0
    try {
        $stream = [System.IO.File]::OpenRead($path)
        try {
            $reader = New-Object System.IO.BinaryReader($stream)
            $magic = $reader.ReadUInt32()
            return ($magic -eq 0x67676d6c)
        } finally { $stream.Close() }
    } catch {
        return $false
    }
}

$ModelValid = Test-ModelValid $ModelPath $MinSizeBytes
if ($ModelValid) {
    Write-Host "[2/3] Model already exists, skipping download" -ForegroundColor Gray
} else {
    if (Test-Path $ModelPath) {
        $existingSize = (Get-Item $ModelPath).Length
        Write-Host "[2/3] Existing model file is invalid (size=$existingSize bytes), re-downloading..." -ForegroundColor Yellow
        Remove-Item -Force $ModelPath
    }
    Write-Host "[2/3] Downloading ${ModelSize} model..." -ForegroundColor Green
    New-Item -ItemType Directory -Force -Path (Join-Path $WhisperDir "models") | Out-Null

    if ($UseTdrz) {
        $url = "https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/$ModelFile"
    } else {
        $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$ModelFile"
    }
    Write-Host "  From: $url" -ForegroundColor Gray

    # Download with progress display. Prefers curl.exe (Windows 10+ ships it; shows a
    # nice progress bar natively). Falls back to Invoke-WebRequest with manual polling.
    $downloaded = $false
    $curlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue)
    if ($curlExe) {
        # curl's native progress bar
        & curl.exe -L --fail --retry 5 --retry-delay 5 --retry-all-errors --retry-connrefused `
            --connect-timeout 30 -o "$ModelPath" "$url"
        if ($LASTEXITCODE -eq 0) { $downloaded = $true }
    } else {
        # Manual progress polling via Invoke-WebRequest. We kick off the download in the
        # background (Start-Job) and watch the destination file's size.
        Write-Host "  curl.exe not found, falling back to Invoke-WebRequest with manual progress" -ForegroundColor Yellow
        $job = Start-Job -ScriptBlock {
            param($u, $p)
            try {
                Invoke-WebRequest -Uri $u -OutFile $p -UseBasicParsing
                exit 0
            } catch { exit 1 }
        } -ArgumentList $url, $ModelPath

        $lastSize = -1
        $stuckCount = 0
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        while ($job.State -eq 'Running') {
            Start-Sleep -Seconds 1
            if (Test-Path $ModelPath) {
                $size = (Get-Item $ModelPath).Length
                if ($size -gt 0) {
                    $mb = [math]::Round($size / 1MB, 1)
                    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 0)
                    Write-Host "`r  Downloaded: $mb MB  ($elapsed s)" -NoNewline -ForegroundColor Cyan
                    if ($size -eq $lastSize) { $stuckCount++ } else { $stuckCount = 0 }
                    $lastSize = $size
                    if ($stuckCount -gt 5) {
                        Write-Host "`n  No progress for 5s, aborting..." -ForegroundColor Yellow
                        Stop-Job $job
                        break
                    }
                }
            }
        }
        Write-Host ""
        $exitCode = (Receive-Job $job -Keep) | Out-Null
        Remove-Job $job -Force
        if ($LASTEXITCODE -eq 0) { $downloaded = $true }
    }

    if ($downloaded -and -not (Test-ModelValid $ModelPath $MinSizeBytes)) {
        Write-Host "  Downloaded file is still invalid. Try a different model size or network." -ForegroundColor Red
        Write-Host "  URL: $url" -ForegroundColor Gray
    } elseif (-not $downloaded) {
        Write-Host "Model download failed - you can manually download later" -ForegroundColor Yellow
        Write-Host "  URL: $url" -ForegroundColor Gray
    }
}

# Create build directory (clean if exists)
if (Test-Path $BuildDir) {
    Write-Host "  Cleaning build directory..." -ForegroundColor Gray
    Remove-Item -Recurse -Force $BuildDir
}
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
Set-Location $BuildDir

# Configure
Write-Host "[3/3] Building..." -ForegroundColor Green

$CMakeFlags = @("-DCMAKE_BUILD_TYPE=Release")

if ($UseCUDA) {
    $CMakeFlags += "-DGGML_CUDA=ON"
    $CMakeFlags += "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor"
    $CMakeFlags += "-DCMAKE_CUDA_STANDARD=17"
    $CMakeFlags += "-DCMAKE_CUDA_STANDARD_REQUIRED=ON"
    if ($GPUArch) {
        $CMakeFlags += "-DCMAKE_CUDA_ARCHITECTURES=$GPUArch"
        Write-Host "  CUDA support enabled (GGML_CUDA, arch=$GPUArch, C++17)" -ForegroundColor Cyan
    } else {
        Write-Host "  CUDA support enabled (GGML_CUDA, auto-arch, C++17)" -ForegroundColor Cyan
    }
} else {
    Write-Host "  CPU only (CUDA disabled)" -ForegroundColor Gray
}

# Configure with CMake
Write-Host "  Running CMake..." -ForegroundColor Gray
$CommonFlags = @(
    "-DCMAKE_C_FLAGS=/utf-8 /Zc:preprocessor"
    "-DCMAKE_CXX_FLAGS=/utf-8 /Zc:preprocessor /DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING=1 /DCCCL_IGNORE_DEPRECATED_CPP_DIALECT=1"
)

if ($UseNinja) {
    Write-Host "  Using Ninja generator" -ForegroundColor Gray
    cmake .. @CMakeFlags @CommonFlags -G Ninja
} else {
    Write-Host "  Using Visual Studio generator" -ForegroundColor Gray
    cmake .. @CMakeFlags @CommonFlags -G "Visual Studio 17 2022" -A x64
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "CMake configure failed" -ForegroundColor Red
    exit 1
}

# Build
Write-Host "  Building..." -ForegroundColor Gray
if ($UseNinja) {
    cmake --build . --config Release
} else {
    cmake --build . --config Release -- /p:Platform=x64 /m
}
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "Build complete!"
Write-Host ""
Write-Host "Model: $ModelPath"
Write-Host "Binary: $BuildDir\bin\main.exe"
Write-Host ""
Write-Host "Test with:"
Write-Host "  whisper.cpp\build\bin\main.exe -m whisper.cpp\models\$ModelFile -f whisper.cpp\samples\jfk.wav"
Write-Host "============================================" -ForegroundColor Cyan
