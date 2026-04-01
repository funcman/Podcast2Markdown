#ifndef WHISPER_ADDON_H
#define WHISPER_ADDON_H

#include <napi.h>
#include <string>
#include <vector>

struct WhisperSegment {
    double start;
    double end;
    std::string text;
};

struct WhisperResult {
    std::string language;
    std::string fullText;
    std::vector<WhisperSegment> segments;
};

class WhisperAddon : public Napi::ObjectWrap<WhisperAddon> {
public:
    WhisperAddon(const Napi::CallbackInfo& info);
    ~WhisperAddon();

    // Initialize with model (JavaScript: addon.init(modelPath, cuda))
    Napi::Value InitModel(const Napi::CallbackInfo& info);

    // Transcribe audio file (JavaScript: addon.transcribe(audioPath, language))
    Napi::Value Transcribe(const Napi::CallbackInfo& info);

    // Check CUDA availability
    Napi::Value IsCudaAvailable(const Napi::CallbackInfo& info);

    // Get model info
    Napi::Value GetModelInfo(const Napi::CallbackInfo& info);

    // Cleanup resources
    void Cleanup();

private:
    void* context_;           // Opaque pointer to whisper context
    std::string modelPath_;
    bool isInitialized_;
    bool useCuda_;
};

#endif // WHISPER_ADDON_H
