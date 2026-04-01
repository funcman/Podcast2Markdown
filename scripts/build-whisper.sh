#!/bin/bash
#
# build-whisper.sh
#
# Build whisper.cpp with CUDA support
# Requires: CMake, GCC/G++, CUDA Toolkit
#
# Usage:
#   ./scripts/build-whisper.sh          # Default: large model + CUDA
#   ./scripts/build-whisper.sh small    # Small model
#   ./scripts/build-whisper.sh --cpu    # CPU only (no CUDA)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WHISPER_DIR="$PROJECT_ROOT/whisper.cpp"
BUILD_DIR="$WHISPER_DIR/build"

# Parse arguments
MODEL_SIZE="${1:-large}"
USE_CUDA="${WHISPER_USE_CUDA:-1}"

if [[ "$1" == "--cpu" ]]; then
    USE_CUDA=0
    MODEL_SIZE="${2:-large}"
fi

echo "============================================"
echo "Building whisper.cpp"
echo "  Model size: $MODEL_SIZE"
echo "  CUDA: $([ $USE_CUDA -eq 1 ] && echo "enabled" || echo "disabled")"
echo "  Build dir: $BUILD_DIR"
echo "============================================"

# Clone whisper.cpp if not exists
if [ ! -d "$WHISPER_DIR" ]; then
    echo "[1/4] Cloning whisper.cpp..."
    git clone https://github.com/ggerganov/whisper.cpp.git "$WHISPER_DIR"
fi

cd "$WHISPER_DIR"

# Checkout stable version
echo "[2/4] Checking out stable version..."
git fetch origin
git checkout v1.7.1 2>/dev/null || git checkout master

# Download model
MODEL_FILE="ggml-${MODEL_SIZE}.bin"
MODEL_PATH="$WHISPER_DIR/models/${MODEL_FILE}"

if [ ! -f "$MODEL_PATH" ]; then
    echo "[3/4] Downloading ${MODEL_SIZE} model..."
    mkdir -p "$WHISPER_DIR/models"
    # Try huggingface mirror first
    wget -q --show-progress \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}" \
        -O "$MODEL_PATH" \
        2>/dev/null || \
    wget --show-progress \
        "https://cdn.ollama.ai/models/whisper.cpp/${MODEL_FILE}" \
        -O "$MODEL_PATH" \
        2>/dev/null || \
    curl -L --progress-bar \
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}" \
        -o "$MODEL_PATH"
fi

# Create build directory
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

# Configure with CMake
echo "[4/4] Building..."

CMAKE_FLAGS="-DCMAKE_BUILD_TYPE=Release"

if [ $USE_CUDA -eq 1 ]; then
    CMAKE_FLAGS="$CMAKE_FLAGS -DWHISPER_CUDA=ON"
    echo "  CUDA support enabled"
else
    echo "  CPU only (CUDA disabled)"
fi

# Configure
cmake "$WHISPER_DIR" $CMAKE_FLAGS

# Build
cmake --build . --config Release -- -j$(nproc)

echo ""
echo "============================================"
echo "Build complete!"
echo ""
echo "Model: $MODEL_PATH"
echo "Binary: $BUILD_DIR/whisper"
echo ""
echo "Test with:"
echo "  $BUILD_DIR/whisper -m models/$MODEL_FILE -f samples/jfk.wav"
echo "============================================"
