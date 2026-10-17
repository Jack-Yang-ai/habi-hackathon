// Decider's plain state-first prompt and one letter-logit readout. No generation.
#include <jni.h>
#include <llama.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
constexpr int kContext = 2048;
constexpr double kTemperature = 1.03;
struct Engine {
    llama_model *model = nullptr;
    llama_context *ctx = nullptr;
    llama_batch batch{};
    bool has_batch = false;
    int last_tokens = 0;
    std::array<llama_token, 10> letters{};
    ~Engine() {
        if (has_batch) llama_batch_free(batch);
        if (ctx) llama_free(ctx);
        if (model) llama_model_free(model);
    }
};
std::mutex mutex;
std::unique_ptr<Engine> engine;

void fail(JNIEnv *env, const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
}
std::string utf8(JNIEnv *env, jbyteArray bytes) {
    if (!bytes) throw std::runtime_error("null_utf8_input");
    const jsize n = env->GetArrayLength(bytes);
    if (n < 0 || n > 65536) throw std::runtime_error("input_too_long");
    std::string result(static_cast<size_t>(n), '\0');
    if (n) env->GetByteArrayRegion(bytes, 0, n, reinterpret_cast<jbyte *>(result.data()));
    return result;
}
std::vector<llama_token> tokenize(const llama_vocab *vocab, const std::string &text) {
    int n = llama_tokenize(vocab, text.data(), static_cast<int>(text.size()), nullptr, 0, false, false);
    if (n == 0) return {};
    if (n > 0) throw std::runtime_error("unexpected_tokenizer_size");
    std::vector<llama_token> result(static_cast<size_t>(-n));
    n = llama_tokenize(vocab, text.data(), static_cast<int>(text.size()), result.data(),
                       static_cast<int>(result.size()), false, false);
    if (n < 0) throw std::runtime_error("tokenization_failed");
    result.resize(static_cast<size_t>(n));
    return result;
}
Engine &get(jlong handle) {
    if (handle != 1 || !engine) throw std::runtime_error("decider_not_prepared");
    return *engine;
}
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_withecho_companion_LocalDeciderNative_open(JNIEnv *env, jobject, jbyteArray path, jint threads) {
    std::lock_guard<std::mutex> guard(mutex);
    try {
        if (engine) throw std::runtime_error("one_decider_instance_per_process");
        if (threads < 1 || threads > 4) throw std::runtime_error("invalid_threads");
        auto next = std::make_unique<Engine>();
        llama_backend_init();
        auto mp = llama_model_default_params();
        mp.n_gpu_layers = 0;
        mp.load_mode = LLAMA_LOAD_MODE_MMAP;
        next->model = llama_model_load_from_file(utf8(env, path).c_str(), mp);
        if (!next->model) throw std::runtime_error("decider_model_load_failed");
        const auto *vocab = llama_model_get_vocab(next->model);
        for (int i = 0; i < 10; ++i) {
            auto ids = tokenize(vocab, std::string(1, static_cast<char>('A' + i)));
            if (ids.size() != 1) throw std::runtime_error("letter_not_single_token");
            next->letters[i] = ids[0];
        }
        auto cp = llama_context_default_params();
        cp.n_ctx = kContext;
        cp.n_batch = kContext;
        cp.n_ubatch = kContext;
        cp.n_seq_max = 1;
        cp.n_threads = threads;
        cp.n_threads_batch = threads;
        cp.kv_unified = true;
        next->ctx = llama_init_from_model(next->model, cp);
        if (!next->ctx) throw std::runtime_error("decider_context_load_failed");
        next->batch = llama_batch_init(kContext, 0, 1);
        next->has_batch = true;
        engine = std::move(next);
        return 1;
    } catch (const std::exception &error) { fail(env, error); return 0; }
}

extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_withecho_companion_LocalDeciderNative_evaluate(JNIEnv *env, jobject, jlong handle,
        jbyteArray context, jbyteArray question, jobjectArray options) {
    std::lock_guard<std::mutex> guard(mutex);
    try {
        auto &e = get(handle);
        if (!options) throw std::runtime_error("options_missing");
        int count = env->GetArrayLength(options);
        if (count < 2 || count > 10) throw std::runtime_error("choice_requires_2_to_10_options");
        const auto *vocab = llama_model_get_vocab(e.model);
        // Upstream decider.prompt.build tokenizes context and the question piece
        // separately, without BOS, chat template, generated answer or option shuffle.
        auto ids = tokenize(vocab, "Context:\n" + utf8(env, context));
        std::string piece = "\n\nQuestion: " + utf8(env, question) + "\nOptions:";
        for (int i = 0; i < count; ++i) {
            auto bytes = static_cast<jbyteArray>(env->GetObjectArrayElement(options, i));
            piece += "\n(" + std::string(1, static_cast<char>('A' + i)) + ") " + utf8(env, bytes);
            env->DeleteLocalRef(bytes);
        }
        piece += "\nAnswer: (";
        auto suffix = tokenize(vocab, piece);
        ids.insert(ids.end(), suffix.begin(), suffix.end());
        if (ids.empty() || ids.size() > kContext) throw std::runtime_error("context_too_long");
        e.last_tokens = static_cast<int>(ids.size());
        llama_memory_clear(llama_get_memory(e.ctx), true);
        auto &batch = e.batch;
        batch.n_tokens = e.last_tokens;
        for (int i = 0; i < batch.n_tokens; ++i) {
            batch.token[i] = ids[static_cast<size_t>(i)];
            batch.pos[i] = i;
            batch.n_seq_id[i] = 1;
            batch.seq_id[i][0] = 0;
            batch.logits[i] = (i == batch.n_tokens - 1);
        }
        int rc = llama_decode(e.ctx, batch);
        if (rc != 0) throw std::runtime_error("llama_decode_failed:" + std::to_string(rc));
        const float *logits = llama_get_logits_ith(e.ctx, -1);
        if (!logits) throw std::runtime_error("letter_logits_missing");
        std::vector<jdouble> p(static_cast<size_t>(count));
        double largest = -INFINITY;
        for (int i = 0; i < count; ++i) {
            p[i] = static_cast<double>(logits[e.letters[i]]) / kTemperature;
            if (!std::isfinite(p[i])) throw std::runtime_error("nonfinite_logit");
            largest = std::max(largest, p[i]);
        }
        double sum = 0;
        for (auto &v : p) { v = std::exp(v - largest); sum += v; }
        for (auto &v : p) v /= sum;
        auto result = env->NewDoubleArray(count);
        env->SetDoubleArrayRegion(result, 0, count, p.data());
        return result;
    } catch (const std::exception &error) { fail(env, error); return nullptr; }
}

extern "C" JNIEXPORT jintArray JNICALL
Java_com_withecho_companion_LocalDeciderNative_tokenize(JNIEnv *env, jobject, jlong handle, jbyteArray text) {
    std::lock_guard<std::mutex> guard(mutex);
    try {
        auto &e = get(handle);
        auto ids = tokenize(llama_model_get_vocab(e.model), utf8(env, text));
        auto result = env->NewIntArray(static_cast<jsize>(ids.size()));
        env->SetIntArrayRegion(result, 0, static_cast<jsize>(ids.size()), ids.data());
        return result;
    } catch (const std::exception &error) { fail(env, error); return nullptr; }
}

extern "C" JNIEXPORT jint JNICALL
Java_com_withecho_companion_LocalDeciderNative_lastTokenCount(JNIEnv *env, jobject, jlong handle) {
    std::lock_guard<std::mutex> guard(mutex);
    try { return get(handle).last_tokens; }
    catch (const std::exception &error) { fail(env, error); return 0; }
}

extern "C" JNIEXPORT void JNICALL
Java_com_withecho_companion_LocalDeciderNative_close(JNIEnv *env, jobject, jlong handle) {
    std::lock_guard<std::mutex> guard(mutex);
    try { (void)get(handle); engine.reset(); }
    catch (const std::exception &error) { fail(env, error); }
}
