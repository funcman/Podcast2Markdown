/**
 * whisper-addon.cc
 *
 * Native Node.js addon for whisper.cpp.
 * Provides a simple wrapper around the whisper.cpp CLI for transcription.
 *
 * This approach uses the whisper.cpp command-line tool as a subprocess,
 * which is the most reliable way to use whisper.cpp with CUDA support.
 *
 * Build requirements:
 *   - whisper.cpp CLI (build with: ./scripts/build-whisper.ps1)
 *   - node-addon-api
 *   - node-gyp
 */

#include "whisper-addon.h"
#include <napi.h>
#include <string>
#include <vector>
#include <memory>
#include <fstream>
#include <sstream>
#include <iostream>
#include <cstring>
#include <thread>
#include <mutex>

#ifdef _WIN32
    #include <windows.h>
    #include <process.h>
    #define popen _popen
    #define pclose _pclose
#else
    #include <dlfcn.h>
#endif

// ============================================================================
// WhisperAddon Class Implementation
// ============================================================================

WhisperAddon::WhisperAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WhisperAddon>(info)
    , context_(nullptr)
    , isInitialized_(false)
    , useCuda_(false)
    , modelPath_("") {
}

WhisperAddon::~WhisperAddon() {
    Cleanup();
}

void WhisperAddon::Cleanup() {
    // No cleanup needed for CLI-based approach
    isInitialized_ = false;
}

Napi::Value WhisperAddon::InitModel(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected model path as first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string modelPath = info[0].As<Napi::String>().Utf8Value();
    bool useCuda = info.Length() > 1 && info[1].IsBoolean() && info[1].As<Napi::Boolean>().Value();

    // Verify the whisper CLI exists
    std::string whisperExe = "./whisper.cpp/build/whisper.exe";
#ifdef _WIN32
    std::ifstream test(whisperExe);
#else
    std::string whisperExeUnix = "./whisper.cpp/build/whisper";
    std::ifstream test(whisperExeUnix);
#endif
    if (!test.good()) {
        Napi::Error::New(env,
            "whisper CLI not found at " + whisperExe + ". "
            "Build whisper.cpp first: ./scripts/build-whisper.ps1"
        ).ThrowAsJavaScriptException();
        return env.Null();
    }
    test.close();

    modelPath_ = modelPath;
    isInitialized_ = true;
    useCuda_ = useCuda;

    std::cout << "[WhisperAddon] Initialized: model=" << modelPath
              << ", cuda=" << (useCuda_ ? "yes" : "no") << std::endl;

    Napi::Object result = Napi::Object::New(env);
    result.Set("success", Napi::Boolean::New(env, true));
    result.Set("modelPath", Napi::String::New(env, modelPath_));
    result.Set("cudaEnabled", Napi::Boolean::New(env, useCuda_));
    return result;
}

Napi::Value WhisperAddon::Transcribe(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!isInitialized_) {
        Napi::Error::New(env, "Whisper not initialized. Call init() first.").ThrowAsJavaScriptException();
        return env.Null();
    }

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected audio file path as first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string audioPath = info[0].As<Napi::String>().Utf8Value();
    std::string language = "zh";
    if (info.Length() > 1 && info[1].IsString()) {
        language = info[1].As<Napi::String>().Utf8Value();
    }

    std::cout << "[WhisperAddon] Transcribing: " << audioPath << " (lang=" << language << ")" << std::endl;

    // Build whisper CLI command
    std::string whisperExe = "./whisper.cpp/build/whisper.exe";
    std::string command = "\"" + whisperExe + "\""
        + " -m \"" + modelPath_ + "\""
        + " -f \"" + audioPath + "\""
        + " -l " + language
        + " --output-json";

    if (useCuda_) {
        command += " -c";  // CUDA flag if supported
    }

    std::cout << "[WhisperAddon] Running: " << command << std::endl;

    // Run whisper CLI and capture output
    FILE* pipe = popen(command.c_str(), "r");
    if (!pipe) {
        Napi::Error::New(env, "Failed to run whisper CLI").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string output;
    char buffer[256];
    while (fgets(buffer, sizeof(buffer), pipe) != nullptr) {
        output += buffer;
    }

    int ret = pclose(pipe);

    if (ret != 0) {
        std::ostringstream err;
        err << "whisper CLI failed with code: " << ret;
        Napi::Error::New(env, err.str()).ThrowAsJavaScriptException();
        return env.Null();
    }

    // Parse JSON output (simplified - whisper outputs text, not JSON by default)
    // For proper JSON parsing, use: --output-json-full
    Napi::Object result = Napi::Object::New(env);
    result.Set("language", Napi::String::New(env, language));
    result.Set("fullText", Napi::String::New(env, output));
    result.Set("segments", Napi::Array::New(env, 0));

    std::cout << "[WhisperAddon] Done: " << output.size() << " chars" << std::endl;

    return result;
}

Napi::Value WhisperAddon::IsCudaAvailable(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, useCuda_);
}

Napi::Value WhisperAddon::GetModelInfo(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object infoObj = Napi::Object::New(env);
    infoObj.Set("modelPath", Napi::String::New(env, modelPath_));
    infoObj.Set("initialized", Napi::Boolean::New(env, isInitialized_));
    infoObj.Set("cudaEnabled", Napi::Boolean::New(env, useCuda_));
    return infoObj;
}

// ============================================================================
// Module Initialization
// ============================================================================

// Module initialization - registers the WhisperAddon class
Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
    // Define the WhisperAddon class
    Napi::Function whispertype = Napi::ObjectWrap<WhisperAddon>::DefineClass(env, "WhisperAddon", {
        Napi::ObjectWrap<WhisperAddon>::InstanceMethod<&WhisperAddon::InitModel>("initModel"),
        Napi::ObjectWrap<WhisperAddon>::InstanceMethod<&WhisperAddon::Transcribe>("transcribe"),
        Napi::ObjectWrap<WhisperAddon>::InstanceMethod<&WhisperAddon::IsCudaAvailable>("isCudaAvailable"),
        Napi::ObjectWrap<WhisperAddon>::InstanceMethod<&WhisperAddon::GetModelInfo>("getModelInfo"),
    });

    Napi::Object helpers = Napi::Object::New(env);
    helpers.Set("isCudaAvailable", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), false);
    }));

    exports.Set("WhisperAddon", whispertype);
    exports.Set("helpers", helpers);
    return exports;
}

NODE_API_MODULE(whisper_addon, InitModule)
