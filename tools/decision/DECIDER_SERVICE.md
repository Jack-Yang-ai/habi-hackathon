# Decider 0.8B Q4 本地常驻服务

提供 AgentJev-shaped 的 `/api/evaluate`，只返回原始选项分布。服务不会创建餐食、发送提醒或调用相机，也不会连接或修改 `8787` 产品后端。

## 启动与复现

```sh
# 校验已下载的源码、模型、tokenizer 和隔离环境；不启动服务。
python3 tools/decision/setup-decider.py --verify-only

# 缺少环境/模型时安装；全部缓存保存在忽略目录 .tools/。
python3 tools/decision/setup-decider.py

# 前台常驻：127.0.0.1:8150，默认 CPU 2 线程，n_ctx=2048。
.tools/decider-venv/bin/python tools/decision/server_decider.py
```

`--backend metal` 显式选择 Metal。需要对应的 llama-cpp-python 构建；安装时可用 `setup-decider.py --build-backend metal`。服务依据本次模型加载日志确认真正 offload 的层数；无法确认时拒绝宣称 Metal 成功。CPU 模式始终设置 `n_gpu_layers=0`。

`GET http://127.0.0.1:8150/health` 返回 `model`、模型 `sha256`、固定源码 commit、模型 revision、`actual_backend`、`gpu_layers_offloaded`、线程数、上下文长度和当前队列状态。编译支持 GPU 不等于本次使用 GPU。

源码固定为 Mapika/decider commit `d6fc522aed7fc392576a9b66a330409bc6c382bd`。使用的 GGUF 是[第三方 Q4_K_M 转换](https://huggingface.co/seongukjeong/decider-0.8b-GGUF)，模型 revision 固定为 `48c1a1dfb87edda1fff62c037cf3cf559f6dbafd`，文件大小 529,297,504 B，SHA-256：

```text
5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a
```

`decider-model.lock.json` 还锁定 tokenizer、温度配置和来源文件的摘要；启动前逐项校验，不自动下载或使用未固定的新版本。依赖固定在 `requirements-decider.txt`；现有源码若被修改或 revision 不同，安装器保留它并报错，不执行 reset。

## HTTP 契约

```json
{
  "state": {
    "transcript": "我要去吃饭了",
    "speaker": "unknown",
    "source": "unknown",
    "recent_utterances": [],
    "audio_events": []
  },
  "questions": [{
    "id": "meal_stage",
    "type": "choice",
    "question": "What is the speaker's meal intent right now?",
    "options": {
      "start_soon": "Preparing to eat food now.",
      "unrelated": "Unrelated to eating now."
    }
  }]
}
```

POST 到 `/api/evaluate`，`Content-Type: application/json`。响应具有以下字段，示意中的数值不是模型实测：

```json
{
  "model": "decider-0.8b-q4",
  "backend": "cpu",
  "results": [{"answers": [{
    "id": "meal_stage",
    "type": "choice",
    "value": "start_soon",
    "top_probability": 0.75,
    "margin": 0.5,
    "distribution": {"start_soon": 0.75, "unrelated": 0.25}
  }]}],
  "usage": {"wall_ms": 100.0, "queue_ms": 0.1, "input_tokens": 100, "output_tokens": 0},
  "domainCalibrated": false
}
```

选项顺序按输入保持，模型的 `probs_list` 原样映射回选项 ID。最高概率和第一、第二名差值直接从这些分数取得；没有规则覆盖或额外校准。多个问题分别独立评分，避免问题之间相互影响。

## 有界执行

- 仅绑定 `127.0.0.1`，不提供远程 host 参数；不开放跨站浏览器请求。
- 请求体最多 64 KiB；state 为非空字符串或对象，序列化后最多 12,000 字符、嵌套最多 8 层。
- 每次 1–4 个问题，仅支持 `choice`；每题 2–10 个命名选项。问题和选项描述各最多 1,000 字符。
- 完整上下文、问题和选项必须在 2,048 tokens 内。启动原生推理前核对实际 token 数，超限返回 `422 context_too_long`，不会静默截断。
- 工作区文件锁防止误启动第二个服务模型；进程内单模型锁、单推理 worker、`n_seq_max=1`。
- 默认最多 2 个等待任务、8 个 HTTP 连接。满载返回 `503`，不无限创建线程或堆积请求。
- 默认总等待期限 12 秒，可用 `--request-timeout` 在 0.05–60 秒内调整。超时返回 `504`，未开始的任务会跳过。已经开始的原生推理不能安全强制中断，仍由唯一 worker 完成，其结果不再交给超时请求。
- 不记录请求正文或语音转写。模型读取和推理均使用离线模式。

这些是执行和输入边界。概率尚未在中文饮食领域校准；本人归属、媒体排除、暂停、时效、冷却和首图视觉复核仍由产品后端执行。

## 验证与启用

```sh
python3 -m unittest discover -s tools/decision -p test_server_decider.py -v

# 临时随机端口检查实际模型、HTTP 契约和 token 超限拒绝；结束后关闭。
python3 tools/decision/smoke-decider-service.py --backend cpu
```

smoke 结果保存在 `output/validation/decider-service-smoke-cpu.json`，不会调用产品后端。服务留待开发负责人手动常驻启动，再由产品后端将 `JEV_URL` 指向 `http://127.0.0.1:8150`。默认服务期限 12 秒短于现有后端 15 秒调用期限；未改变产品环境变量。
