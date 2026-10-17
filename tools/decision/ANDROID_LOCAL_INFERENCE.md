# Android local SenseVoice and Decider

`LocalInferenceEngine` runs entirely in the Android application process on CPU. It takes a completed PCM16/16 kHz/mono WAV plus its schema 2 recording receipt. It never opens a microphone, invokes a camera, sends HTTP, or creates a meal. The application pipeline owns recording and orchestration.

## Build and install

From the repository root:

```sh
python3 tools/decision/prepare-android-local.py --install-toolchain --skip-probe-build
python3 tools/decision/prepare-android-kws.py
```

The first app build skips the standalone public probe so it does not depend on a prewarmed Gradle Kotlin compiler cache. After building the APK, omit `--skip-probe-build` when preparing that optional probe.

The first run installs NDK 28.2.13676358 and CMake 3.31.1 through the existing Android SDK. Subsequent builds can omit `--install-toolchain`. This script does not touch a phone or alter Gradle files. It outputs:

- `.tools/local-inference-android/sherpa-source/`: hash-locked Kotlin API sources.
- `.tools/local-inference-android/jniLibs/arm64-v8a/`: four matching native libraries.
- `.tools/local-inference-android/models/`: 769,494,453 bytes, including four model/token files and tokenizer verification vectors.
- `.tools/local-inference-android/probe.jar`: separate public-file runner; not packaged in the application.
- `.tools/local-inference-android/bundle-manifest.json`: per-file sizes and SHA-256.

The application's Gradle source sets need:

```kotlin
sourceSets.getByName("main").java.srcDir("../../.tools/local-inference-android/sherpa-source")
sourceSets.getByName("main").jniLibs.srcDir("../../.tools/local-inference-android/jniLibs")
```

No Gradle `externalNativeBuild` is needed: the preparation script builds the JNI library before the APK build. Package only `arm64-v8a`. After installing the debuggable application, while its inference worker is stopped, deploy only the models:

```sh
python3 tools/decision/deploy-android-models.py --serial YOUR_ADB_SERIAL
```

This stages verified model files in a fresh `/data/local/tmp/echo-local-models-*` directory, uses `run-as com.withecho.companion.dev` to copy into `files/local-models`, then verifies the app-private hashes. It does not install/start/stop the application or recording. The production package requires its own debuggable build for `run-as`; an APK release should provision the same files through its app-owned installer.

## API and data

```kotlin
val engine = LocalInferenceEngine(context)
val status: JSONObject = engine.prepare()
val report: JSONObject = engine.analyze(wavFile, schema2Receipt)
engine.close()
```

The batch methods serialize their work. recognizeCommand shares only the SenseVoice recognizer lock, so a Decider call does not block a short wake command. Native Decider additionally enforces one loaded instance per process and one global mutex. Call the API on a background worker. A second engine in the same process fails preparation rather than loading another Decider copy. `close()` waits for an in-flight native call and releases model contexts; native decoding is not interrupted midway.

Preparation streams and checks the four locked model/token hashes and the tokenizer-vector file hash. It then compares the GGUF tokenizer to 13 frozen HF-tokenizer vectors, including Chinese and an emoji. Any mismatch fails preparation. It uses the matched sherpa 1.13.8 / ORT 1.28.2 libraries, avoiding the older runtime involved in the SM8845 SME2 SIGILL. Decider is compiled for baseline `armv8-a`, with no GPU offload, OpenMP, KleidiAI, SVE or SME dependency.

An abbreviated real public-file result is below; scores are the raw phone model output, not a corrected example:

```json
{
  "schema_version": 1,
  "audio_sha256": "b77f1794fe374a0ba1ee1dc458bfaf9349496cbbfc32780c50ba3c5a7ad8e373",
  "capture_id": "public-fixture-only",
  "frame_offset": 0,
  "sample_rate": 16000,
  "duration_sec": 5.592,
  "test_fixture": true,
  "speech_vad_verified": true,
  "segments": [{
    "text": "开饭时间早上9点至下午5点。",
    "window_start_sec": 0.442,
    "window_end_sec": 5.592,
    "language_tag": "<|zh|>",
    "emotion_tag": "<|NEUTRAL|>",
    "event_tag": "<|Speech|>",
    "speech_vad_verified": true,
    "test_fixture": true,
    "speaker": "unknown",
    "source_context": "unknown",
    "observed_at": "2000-01-01T00:00:05.592Z",
    "decision": {
      "stage": "start_soon",
      "probability": 0.437350603471639,
      "margin": 0.04690933592202651,
      "distribution": {
        "start_soon": 0.437350603471639,
        "invited": 0.3904412675496125,
        "eating_now": 0.038788352463589235,
        "finished": 0.04437946972882015,
        "declined": 0.010263247503981566,
        "unrelated": 0.04869132893333455,
        "uncertain": 0.030085730349022958
      },
      "wallMs": 1554.06,
      "model": "decider-0.8b-q4",
      "modelSha256": "5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a",
      "runtime": "llama.cpp-android-cpu",
      "temperature": 1.03,
      "promptTokens": 122,
      "promptVersion": "meal-short-english-v1-identity-unknown",
      "domainCalibrated": false
    }
  }],
  "timings_ms": {"vad": 24.681146, "asr": 130.898072, "decider": 1554.06, "total": 1715.643906}
}
```

Times are relative to this WAV, not relative to the recording. The recording time is `capture_started_at + (frame_offset / 16000) + window_end_sec`; the engine never substitutes current time or file mtime when timing evidence is absent. Unknown speaker/source stay unknown. SenseVoice provides categorical tags and optional token timestamps; the engine invents no ASR confidence, voiceprint or user identity.

## Gating, context and readout

VAD runs before ASR. At least 0.25 seconds of detected speech is required. The enclosing speech window receives 0.3 seconds of leading padding and 0.5 seconds of trailing padding, clipped to this file. Its RMS must be at least 0.0001. ASR text becomes a segment, and reaches Decider, only when it is nonempty and the real returned event tag is exactly `<|Speech|>`. Silence produces `segments: []` with zero ASR/Decider time. This is a noise/ASR guard, not a proof that speech belongs to the user or is live rather than media.

The seven option descriptions and short English question match `check-decider.py`'s `short_english_text` variant. Context is rendered as:

```text
Previous: <up to three prior recognized texts, joined by |>
Speaker: unknown
Source: unknown
Message: <current ASR text>
```

The original Decider plain state-first format is retained. `Context:\n<context>` and the question/options/`Answer: (` piece are tokenized separately, without BOS or chat formatting. No options are shuffled. A single forward pass reads the final answer-slot logits for letter tokens A through G, divides them by the pinned temperature 1.03, and applies softmax across those seven choices. There is no generated answer, keyword substitution, semantic rule override or probability renormalization over a different label set. Contexts longer than 2,048 complete prompt tokens fail before native decoding.

Only the same `capture_id`'s previous three recognized segments within 60 seconds are retained. A capture change clears history. Exact `capture_id + frame_offset + SHA-256` repeats return `duplicate: true` without another inference; older out-of-order chunks are refused. The host pipeline should also deduplicate submitted signal IDs. Files are non-overlapping; this version does not stitch raw audio across 10-second boundaries. Padding protects phonemes inside each file but does not prove lossless recognition across a file boundary.

All locked public audio SHA-256 values and receipt `time_source: synthetic_fixture` mark the result and each segment `test_fixture: true`. Fixture timestamps remain deliberately old. The caller must preserve these markers and must not turn fixture output into live camera instructions.

## Phone evidence

```sh
python3 tools/decision/run-android-local-public.py --serial YOUR_ADB_SERIAL
```

The runner checks every host and device bundle hash, then executes only public/synthetic files in an isolated `app_process`. It does not install/restart the application or open a microphone. The completed 2026-10-15 result is saved locally at `output/validation/android-local-inference-public.json` (ignored from Git).

Measured on the attached PZ261A / SM8845 / Android SDK 36, CPU with two inference threads:

| Probe | Measured result |
| --- | --- |
| Three resident models, including hash/vector verification | 2,164.9 ms preparation |
| Public Chinese WAV, 5.592 s | VAD 24.7 ms; ASR 130.9 ms; Decider 1,554.1 ms; total 1,715.6 ms |
| Synthetic silence, 10 s | 28.8 ms total; no segments; no ASR or Decider |
| Exact duplicate WAV receipt | Duplicate flag verified without another inference |
| Three authored Chinese text probes | 1,466–1,479 ms per native decision |
| Process peak resident memory, all three models loaded | 1,436,644 kB, approximately 1.37 GiB |
| HF/GGUF tokenizer parity | All 13 fixed vectors passed on the phone |

These are execution measurements, not an accuracy benchmark or a microphone, battery, thermal, background-lifecycle or full-day test. The public sentence was recognized as “开饭时间…” rather than “开放时间…”, and the model assigned `start_soon` 0.437 with margin 0.047. An authored “我要去吃饭了” text was classified `invited` with probability 0.567. Those are retained errors/ambiguities, not corrected predictions. Camera authorization, speaker/source checks, freshness, cancellation, cooldown and Step first-photo review belong to the surrounding controller.

## Pinned sources

- [sherpa Android runtime 1.13.8](https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.8), pinned by `audio/android-runtime.lock.json`; matched ORT binary SHA-256 `33847ad4…cf2da1`.
- [Decider prompt source](https://github.com/Mapika/decider/blob/d6fc522aed7fc392576a9b66a330409bc6c382bd/decider/prompt.py), pinned Decider source commit and model config in `decider-model.lock.json`.
- [Third-party 0.8B Q4_K_M conversion](https://huggingface.co/seongukjeong/decider-0.8b-GGUF/tree/48c1a1dfb87edda1fff62c037cf3cf559f6dbafd), exact 529,297,504-byte weight hash `5cb5d042…b7b11a`.
- `android-local.lock.json` pins the complete llama-cpp-python 0.3.36 source archive, SHA-256 `832db069…60c1a2e`, whose vendored llama.cpp is compiled into the JNI library. The exported library's exact SHA appears in each prepared bundle manifest.

## Realtime wake word (0.5.0)

See [phone voice camera](../../docs/device/PHONE_CAMERA.md). `prepare-android-kws.py` downloads the official 3M Chinese/English Zipformer archive and matching Kotlin bindings using exact size/SHA locks. `--deploy --serial ...` copies only five KWS files into app-private `files/local-models/kws`; recording must be stopped. It preserves the existing SenseVoice/Decider installation. Model binaries, SDKs, private validation audio and logs stay ignored.

`VoiceKwsRuntime` consumes the same live PCM as the file writer. KWS detects 哈比; a separate VAD instance finds the short utterance endpoint, and the existing SenseVoice recognizer confirms the full original phrase. A lone wake keeps a six-second window open. Only an accepted full command invokes the phone camera. Batch context cannot invoke it again. Raw ASR spelling is preserved, including the observed happy记录 alias; broad happy or quoted/negative/future phrases are not accepted.

KWS resets its token timestamps after silence, and the Kotlin result omits segment start_time. These raw timestamps are explicitly marked segment-relative and never used as absolute capture time. Clip ranges and freshness use original AudioRecord frame numbers plus the capture's BOOTTIME anchor, both before and after ASR. Stopping or a PCM queue discontinuity cancels the candidate. No recorded file is promoted into a fresh live request.

The debug `KwsValidationInstrumentation` reads only the explicit app-private kws-validation/command.wav fixture and never opens a microphone, camera or network connection. It checks full phrase, eight seconds of leading silence, a two-second split, seven-second expiry, wake-only, command-only and silence. The fixture-specific split is diagnostic code only, not a runtime rule or accuracy benchmark. Run instrumentation only when recording is stopped.
