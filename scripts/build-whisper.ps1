# build-whisper.ps1
#
# Build whisper.cpp with CUDA support on Windows
# Requires: CMake, MSVC, CUDA Toolkit
#
# Usage:
#   .\scripts\build-whisper.ps1          # Default: large model + CUDA
#   .\scripts\build-whisper.ps1 small    # Small model
#   .\scripts\build-whisper.ps1 -CPU     # CPU only

param(
    [string]$ModelSize = "large",
    [switch]$CPU
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
if (-not (Test-Command "ninja")) {
    Write-Host "Ninja not found, will use MSBuild" -ForegroundColor Yellow
}

if ($missing.Count -gt 0) {
    Write-Host "Missing dependencies: $($missing -join ', ')" -ForegroundColor Red
    Write-Host "Install them before running this script" -ForegroundColor Yellow
    exit 1
}

$UseNinja = Test-Command "ninja"

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

    $url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/models/$ModelFile"
    Write-Host "  From: $url" -ForegroundColor Gray

    try {
        Invoke-WebRequest -Uri $url -OutFile $ModelPath -UseBasicParsing
        if ($LASTEXITCODE -ne 0) { throw "Download failed" }
    } catch {
        Write-Host "Invoke-WebRequest failed, trying curl.exe..." -ForegroundColor Yellow
        & curl.exe -L $url -o $ModelPath
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Model download failed - you can manually download later" -ForegroundColor Yellow
            Write-Host "  URL: $url" -ForegroundColor Gray
        }
    }
} else {
    Write-Host "[2/3] Model already exists, skipping download" -ForegroundColor Gray
}

# Create build directory
if (-not (Test-Path $BuildDir)) {
    New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null
}
Set-Location $BuildDir

# Configure
Write-Host "[3/3] Building..." -ForegroundColor Green

$CMakeFlags = @("-DCMAKE_BUILD_TYPE=Release")

if ($UseCUDA) {
    $CMakeFlags += "-DGGML_CUDA=ON"
    Write-Host "  CUDA support enabled (GGML_CUDA)" -ForegroundColor Cyan
} else {
    Write-Host "  CPU only (CUDA disabled)" -ForegroundColor Gray
}

# Configure with CMake
Write-Host "  Running CMake..." -ForegroundColor Gray
if ($UseNinja) {
    cmake .. @CMakeFlags -G Ninja -DCMAKE_C_FLAGS="/utf-8" -DCMAKE_CXX_FLAGS="/utf-8"
} else {
    cmake .. @CMakeFlags -G "Visual Studio 17 2022" -A x64 -DCMAKE_C_FLAGS="/utf-8" -DCMAKE_CXX_FLAGS="/utf-8"
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
Write-Host "  .\bin\main.exe -m models\$ModelFile -f samples\jfk.wav"
Write-Host "============================================" -ForegroundColor Cyan
