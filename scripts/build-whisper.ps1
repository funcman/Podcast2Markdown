# build-whisper.ps1
#
# Build whisper.cpp with CUDA support on Windows
# Requires: CMake, MSVC, CUDA Toolkit
#
# Usage:
#   .\scripts\build-whisper.ps1                    # Default: large model + CUDA
#   .\scripts\build-whisper.ps1 small              # Small model
#   .\scripts\build-whisper.ps1 -CPU               # CPU only
#   .\scripts\build-whisper.ps1 large -GPUArch 86  # Specify GPU arch (RTX 3060 = 86)

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
    # Check if nvcc is available
    $hasCUDA = Test-Command "nvcc"
    if (-not $hasCUDA) {
        Write-Host "CUDA requested but nvcc not found, disabling CUDA" -ForegroundColor Yellow
        $UseCUDA = $false
    }
}

# Clone whisper.cpp (skip if already exists and complete)
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
# Setting env var to suppress the error since /Zc:preprocessor doesn't propagate correctly
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
$ModelFile = "ggml-${ModelSize}.bin"
$ModelPath = Join-Path $WhisperDir "models\$ModelFile"

if (-not (Test-Path $ModelPath)) {
    Write-Host "[2/3] Downloading ${ModelSize} model..." -ForegroundColor Green
    New-Item -ItemType Directory -Force -Path (Join-Path $WhisperDir "models") | Out-Null

    $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$ModelFile"
    Write-Host "  From: $url" -ForegroundColor Gray

    try {
        Invoke-WebRequest -Uri $url -OutFile $ModelPath -UseBasicParsing
        if ($LASTEXITCODE -ne 0) { throw "Download failed" }
    } catch {
        Write-Host "Invoke-WebRequest failed, trying BITS..." -ForegroundColor Yellow
        try {
            Import-Module BitsTransfer -ErrorAction Stop
            Start-BitsTransfer -Source $url -Destination $ModelPath -ErrorAction Stop
        } catch {
            Write-Host "BITS failed, trying curl.exe..." -ForegroundColor Yellow
            & curl.exe -L $url -o $ModelPath
            if ($LASTEXITCODE -ne 0) {
                Write-Host "Model download failed - you can manually download later" -ForegroundColor Yellow
                Write-Host "  URL: $url" -ForegroundColor Gray
            }
        }
    }
} else {
    Write-Host "[2/3] Model already exists, skipping download" -ForegroundColor Gray
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
    # CUDA 13.2+ requires /Zc:preprocessor and C++17 for CCCL/CUB compatibility
    $CMakeFlags += "-DCMAKE_CUDA_FLAGS=-Xcompiler=/Zc:preprocessor"
    $CMakeFlags += "-DCMAKE_CUDA_STANDARD=17"
    $CMakeFlags += "-DCMAKE_CUDA_STANDARD_REQUIRED=ON"
    if ($GPUArch) {
        $CMakeFlags += "-DCMAKE_CUDA_ARCHITECTURES=$GPUArch"
        Write-Host "  CUDA support enabled (GGML_CUDA, arch=$GPUArch, C++17)" -ForegroundColor Cyan
    } else {
        Write-Host "  CUDA support enabled (GGML_CUDA, C++17)" -ForegroundColor Cyan
    }
} else {
    Write-Host "  CPU only (CUDA disabled)" -ForegroundColor Gray
}

# Configure with CMake
Write-Host "  Running CMake..." -ForegroundColor Gray
# CCCL in CUDA 13.2+ requires multiple flags for compatibility
$CommonFlags = @(
    "-DCMAKE_C_FLAGS=/utf-8 /Zc:preprocessor"
    "-DCMAKE_CXX_FLAGS=/utf-8 /Zc:preprocessor /DCCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING=1 /DCCCL_IGNORE_DEPRECATED_CPP_DIALECT=1"
)

if ($UseNinja) {
    Write-Host "  Using Ninja generator" -ForegroundColor Gray
    cmake .. @CMakeFlags @CommonFlags -G Ninja
} else {
    Write-Host "  Using Visual Studio 2022 generator" -ForegroundColor Gray
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
