#!/bin/bash
#
# Build whisper.cpp locally with optional CUDA acceleration.
# Requires: CMake, GCC/G++ (or Clang), Ninja (optional), CUDA Toolkit (optional)
#
# Usage:
#   ./scripts/build-whisper.sh                          # Default: large-v3 + CUDA
#   ./scripts/build-whisper.sh small                    # Small model
#   ./scripts/build-whisper.sh large-v3-turbo           # Turbo variant (faster, slightly less accurate)
#   ./scripts/build-whisper.sh medium-q5_0              # Quantized variant
#   ./scripts/build-whisper.sh ggml-large-v3-q5_0.bin   # Full filename form also accepted
#   ./scripts/build-whisper.sh --cpu                    # CPU only
#   ./scripts/build-whisper.sh large --gpu-arch 86      # Override auto-detected GPU arch
#   ./scripts/build-whisper.sh --help                   # List available models
#
# Aliases: tiny | base | small | medium | large (large => large-v3)
# All models listed at https://huggingface.co/ggerganov/whisper.cpp are supported.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WHISPER_DIR="$PROJECT_ROOT/whisper.cpp"
BUILD_DIR="$WHISPER_DIR/build"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
USE_CUDA="${WHISPER_USE_CUDA:-1}"
GPU_ARCH=""
MODEL_SIZE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --cpu)
            USE_CUDA=0
            shift
            ;;
        --gpu-arch)
            GPU_ARCH="${2:-}"
            shift 2
            ;;
        --gpu-arch=*)
            GPU_ARCH="${1#*=}"
            shift
            ;;
        --help|-h)
            cat <<'EOF'
Available model aliases: tiny | base | small | medium | large
Available model names (from upstream):
  tiny, tiny.en, tiny-q5_1, tiny.en-q5_1, tiny-q8_0,
  base, base.en, base-q5_1, base.en-q5_1, base-q8_0,
  small, small.en, small.en-tdrz, small-q5_1, small.en-q5_1, small-q8_0,
  medium, medium.en, medium-q5_0, medium.en-q5_0, medium-q8_0,
  large-v1, large-v2, large-v2-q5_0, large-v2-q8_0,
  large-v3, large-v3-q5_0, large-v3-turbo, large-v3-turbo-q5_0, large-v3-turbo-q8_0
EOF
            exit 0
            ;;
        -*)
            echo "Unknown option: $1" >&2
            exit 1
            ;;
        *)
            MODEL_SIZE="$1"
            shift
            ;;
    esac
done

MODEL_SIZE="${MODEL_SIZE:-large}"

echo "============================================"
echo "Building whisper.cpp"
echo "  Model size: $MODEL_SIZE"
echo "  CUDA: $([ $USE_CUDA -eq 1 ] && echo 'enabled' || echo 'disabled')"
echo "  Build dir: $BUILD_DIR"
echo "============================================"

# ---------------------------------------------------------------------------
# Check prerequisites
# ---------------------------------------------------------------------------
missing=()
command -v cmake >/dev/null 2>&1 || missing+=("CMake")
command -v git   >/dev/null 2>&1 || missing+=("Git")
if [ "$USE_CUDA" -eq 1 ] && ! command -v nvcc >/dev/null 2>&1; then
    echo "CUDA requested but nvcc not found, disabling CUDA" >&2
    USE_CUDA=0
fi
if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing dependencies: ${missing[*]}" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Auto-detect GPU architecture (only when CUDA is enabled and arch not pinned)
# ---------------------------------------------------------------------------
detect_gpu_arch() {
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        return 1
    fi
    local gpu_name
    gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1 | xargs)
    if [ -z "$gpu_name" ]; then
        return 1
    fi
    echo "  Detected GPU: $gpu_name" >&2

    # Substring matches; longest/most-specific entries first when order matters
    case "$gpu_name" in
        *"RTX 5090"*|*"RTX 5080"*|*"RTX 5070"*)  echo "100" ;;
        *"RTX 4090"*|*"RTX 4080"*|*"RTX 4070"*|*"RTX 4060"*)  echo "89" ;;
        *"RTX 3090"*|*"RTX 3080"*|*"RTX 3070"*|*"RTX 3060"*|*"RTX 3050"*|*"RTX A6000"*|*"RTX A5000"*|*"RTX A4000"*|*"RTX A3000"*)  echo "86" ;;
        *"GTX 1660"*|*"GTX 1650"*|*"RTX 5000"*|*"RTX 4000"*|*"RTX 3000"*)  echo "75" ;;
        *"GTX 1080"*|*"GTX 1070"*|*"GTX 1060"*|*"GTX 1050"*)  echo "61" ;;
        *"GTX 980"*|*"GTX 970"*|*"GTX 960"*|*"GTX 750"*|*"GTX 650"*)  echo "52" ;;
        *"TITAN V"*|*"V100"*)  echo "70" ;;
        *"A100"*)  echo "80" ;;
        *"H100"*|*"H200"*)  echo "90" ;;
        *) return 1 ;;
    esac
}

if [ "$USE_CUDA" -eq 1 ] && [ -z "$GPU_ARCH" ]; then
    if detected=$(detect_gpu_arch); then
        GPU_ARCH="$detected"
    else
        echo "  Could not auto-detect GPU arch. Will let CMake auto-select." >&2
    fi
fi

# ---------------------------------------------------------------------------
# Clone whisper.cpp (skip if already exists and complete)
# ---------------------------------------------------------------------------
echo "[1/4] Cloning whisper.cpp..." >&2
need_clone=1
if [ -d "$WHISPER_DIR" ]; then
    if [ -f "$WHISPER_DIR/CMakeLists.txt" ]; then
        echo "  whisper.cpp already exists, skipping clone" >&2
        need_clone=0
    else
        rm -rf "$WHISPER_DIR"
    fi
fi

# Required for CCCL/CUDA 13.2+ with MSVC to avoid preprocessor error.
# Harmless on other toolchains; we still set it for parity with the PowerShell script.
export CCCL_IGNORE_MSVC_TRADITIONAL_PREPROCESSOR_WARNING=1

if [ "$need_clone" -eq 1 ]; then
    git clone --depth 1 --branch v1.7.1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR" \
        || git clone --branch v1.7.1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

# ---------------------------------------------------------------------------
# Resolve model name -> filename + URL
# ---------------------------------------------------------------------------
# Recognised size aliases
declare -A SIZE_ALIAS=(
    [tiny]=tiny
    [base]=base
    [small]=small
    [medium]=medium
    [large]=large-v3    # canonical large for highest accuracy
)

VALID_MODELS=(
    tiny tiny.en tiny-q5_1 tiny.en-q5_1 tiny-q8_0
    base base.en base-q5_1 base.en-q5_1 base-q8_0
    small small.en small.en-tdrz small-q5_1 small.en-q5_1 small-q8_0
    medium medium.en medium-q5_0 medium.en-q5_0 medium-q8_0
    large-v1 large-v2 large-v2-q5_0 large-v2-q8_0
    large-v3 large-v3-q5_0 large-v3-turbo large-v3-turbo-q5_0 large-v3-turbo-q8_0
)

# Strip an optional leading `ggml-` and trailing `.bin` so users can pass either form
NORMALIZED="$MODEL_SIZE"
NORMALIZED="${NORMALIZED#ggml-}"
NORMALIZED="${NORMALIZED%.bin}"

if [ -n "${SIZE_ALIAS[$NORMALIZED]+x}" ]; then
    MODEL_NAME="${SIZE_ALIAS[$NORMALIZED]}"
elif printf '%s\n' "${VALID_MODELS[@]}" | grep -qx "$NORMALIZED"; then
    MODEL_NAME="$NORMALIZED"
else
    echo "Unknown model '$MODEL_SIZE'." >&2
    echo "Available models: ${VALID_MODELS[*]}" >&2
    echo "Aliases: tiny, base, small, medium, large" >&2
    exit 1
fi

MODEL_FILE="ggml-${MODEL_NAME}.bin"
MODEL_PATH="$WHISPER_DIR/models/$MODEL_FILE"

# tdrz variants live in a separate HuggingFace repo
if [[ "$MODEL_NAME" == *tdrz* ]]; then
    MODEL_URL="https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/$MODEL_FILE"
else
    MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_FILE"
fi

# Minimum size threshold (bytes); the ggml magic check is the real validation
case "$MODEL_FILE" in
    ggml-tiny*|ggml-base*)  MIN_SIZE=$((30 * 1024 * 1024)) ;;
    ggml-small*)            MIN_SIZE=$((100 * 1024 * 1024)) ;;
    ggml-medium*)           MIN_SIZE=$((100 * 1024 * 1024)) ;;  # also covers q5_0/q8_0
    ggml-large*)            MIN_SIZE=$((500 * 1024 * 1024)) ;;  # covers q5_0 (~574MB) and full (~3.1GB)
    *)                      MIN_SIZE=$((30 * 1024 * 1024)) ;;
esac

# ---------------------------------------------------------------------------
# Validate existing model file
# ---------------------------------------------------------------------------
check_ggml_magic() {
    local path="$1"
    [ -f "$path" ] || return 1
    local size
    size=$(stat -c %s "$path" 2>/dev/null || stat -f %z "$path" 2>/dev/null)
    [ "$size" -ge "$MIN_SIZE" ] || return 1
    # Read first 4 bytes; ggml magic = 0x67676d6c ("ggml" ASCII).
    # In memory the bytes are 0x6c, 0x6d, 0x67, 0x67 (little-endian uint32),
    # and `od -tx1` prints them in that same memory order.
    local magic_hex
    magic_hex=$(head -c 4 "$path" | od -An -tx1 | tr -d ' \n')
    [ "$magic_hex" = "6c6d6767" ]
    return $?
}

cd "$WHISPER_DIR"

if check_ggml_magic "$MODEL_PATH"; then
    echo "[2/4] Model already exists and is valid, skipping download" >&2
else
    if [ -f "$MODEL_PATH" ]; then
        existing_size=$(stat -c %s "$MODEL_PATH" 2>/dev/null || stat -f %z "$MODEL_PATH" 2>/dev/null)
        echo "[2/4] Existing model file is invalid (size=$existing_size bytes), re-downloading..." >&2
        rm -f "$MODEL_PATH"
    fi
    echo "[2/4] Downloading ${MODEL_NAME} model..." >&2
    mkdir -p "$WHISPER_DIR/models"
    echo "  From: $MODEL_URL" >&2

    # Prefer curl with progress bar; falls back to wget
    if command -v curl >/dev/null 2>&1; then
        curl -L --fail --retry 5 --retry-delay 5 --retry-all-errors --retry-connrefused \
             --connect-timeout 30 --progress-bar -o "$MODEL_PATH" "$MODEL_URL"
    elif command -v wget >/dev/null 2>&1; then
        wget --tries=5 --waitretry=5 --timeout=30 --show-progress -O "$MODEL_PATH" "$MODEL_URL"
    else
        echo "Either curl or wget is required to download the model." >&2
        exit 1
    fi

    if ! check_ggml_magic "$MODEL_PATH"; then
        echo "Downloaded file is still invalid. Try a different model size or network." >&2
        echo "URL: $MODEL_URL" >&2
    fi
fi

# ---------------------------------------------------------------------------
# Configure and build
# ---------------------------------------------------------------------------
if [ -d "$BUILD_DIR" ]; then
    echo "  Cleaning build directory..." >&2
    rm -rf "$BUILD_DIR"
fi
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

echo "[3/4] Configuring..." >&2

CMAKE_FLAGS=(-DCMAKE_BUILD_TYPE=Release)

if [ "$USE_CUDA" -eq 1 ]; then
    CMAKE_FLAGS+=(-DGGML_CUDA=ON)
    # CUDA 13.2+ requires /Zc:preprocessor and C++17 for CCCL/CUB compatibility
    CMAKE_FLAGS+=(-DCMAKE_CUDA_FLAGS="-Xcompiler=/Zc:preprocessor")
    CMAKE_FLAGS+=(-DCMAKE_CUDA_STANDARD=17)
    CMAKE_FLAGS+=(-DCMAKE_CUDA_STANDARD_REQUIRED=ON)
    if [ -n "$GPU_ARCH" ]; then
        CMAKE_FLAGS+=(-DCMAKE_CUDA_ARCHITECTURES="$GPU_ARCH")
        echo "  CUDA support enabled (arch=$GPU_ARCH, C++17)" >&2
    else
        echo "  CUDA support enabled (auto-arch, C++17)" >&2
    fi
else
    echo "  CPU only (CUDA disabled)" >&2
fi

GENERATOR=""
if command -v ninja >/dev/null 2>&1; then
    GENERATOR="-G Ninja"
    echo "  Using Ninja generator" >&2
fi

cmake "$WHISPER_DIR" "${CMAKE_FLAGS[@]}" $GENERATOR

echo "[4/4] Building..." >&2
cmake --build . --config Release -- -j"$(nproc 2>/dev/null || echo 2)"

echo ""
echo "============================================"
echo "Build complete!"
echo ""
echo "Model: $MODEL_PATH"
echo "Binary: $BUILD_DIR/bin/main"
echo ""
echo "Test with:"
echo "  whisper.cpp/build/bin/main -m whisper.cpp/models/$MODEL_FILE -f whisper.cpp/samples/jfk.wav"
echo "============================================"