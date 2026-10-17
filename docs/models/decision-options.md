# 用餐线索模型选择 · 2026-10-15

第一版选 **Mapika/Decider 0.8B，Q4_K_M GGUF**。Mac与Android CPU均已实际加载和推理，已接入手机持续录音链路；见[手机验收](../device/PHONE_PIPELINE.md)。模型原始中文分类仍不稳定，作为辅助候选；明确的准备线索优先触发一张验证图，不能把分类结果直接记作用户已经进食。

## 本机核查

| 候选 | 权重/格式 | 当前用途与证据 |
|---|---|---|
| [Decider 0.8B](https://huggingface.co/Mapika/decider-0.8b) | 原版约1.4 GB BF16；本轮[第三方Q4](https://huggingface.co/seongukjeong/decider-0.8b-GGUF) 529,297,504 B | Mac和Android CPU已跑通；模型卡主要覆盖英文，中文原始细分类不稳定，保留规则与首图复核 |
| [Laya-MLX multilingual](https://huggingface.co/aac6fef/laya-multilingual-mlx) | 约322M，643,835,426 B FP16权重 | Mac联调对照。`laya-mlx`是Apple Silicon实现，手机Android需要另一个运行时。移植保留原checkpoint能力与限制 |
| [Decima-small](https://huggingface.co/amyrmahdy/decima-small) | 122M，INT8 ONNX约127 MB，加tokenizer共144 MB | CPU研究对照，当前中文输入格式有高分误判。作者披露部分训练数据的非商业条款，未作为产品默认分发 |
| [AgentJev](https://github.com/malevrigns/agent-jev) | 0.6B，1,196,881,242 B BF16权重 | 已在Mac CPU跑通，中文用餐首测分布较平，保留研究脚本 |
| [Chinese-Jev](https://gulucaptain.github.io/Chinese-Jev/) | 论文约322M | 项目页仍标权重planned/coming soon，本轮无法部署 |

原模型和转换都以各自模型卡/许可证为准。Decider、Laya-MLX的模型/代码卡标Apache-2.0。Decima作者的具体训练材料说明见[原仓库release/LICENSING.md](https://github.com/amyrmahdy/decima/blob/main/release/LICENSING.md)，此处不把标注Apache等同于训练材料已完成商业审核。

## 小规模开发探针

同组18条人工合成中文开发样例，涵盖准备吃、邀请、接受、吃完、拒绝、未来、媒体、旁人、吃药、开放/开饭误字。金标按本产品的本人/当前上下文语义定义；它不是随机抽样的独立测试集，也不是模型通用能力排名。改prompt后仍在同一开发集上测，只能用于调试。

| 运行方式 | 当前中文JSON/长选项吻合 | 短英文问题/选项对照吻合 | 暖态中位耗时 |
|---|---:|---:|---|
| Decider Q4 / Mac CPU 2线程 | 11/18 | 10/18 | 约755 / 478 ms |
| Decider Q4 / Mac Metal | 10/18 | 10/18 | 约114 / 79 ms |
| Decima INT8 / Mac CPU 2线程 | 3/18 | 9/18 | 约27 / 10 ms |
| Laya multilingual MLX / Mac GPU | 2/18 | 本轮未测 | 约26 ms |

各模型实现、输入预算与硬件后端不同，耗时不构成公平性能排名。上表不表示实际用户准确率。Decider CPU与Metal在一条同音字探针上也出现不同top-1，未把两种后端写成概率完全等价。Laya结果只覆盖当前提示格式；可继续优化输入，不能据此概括其整体质量。

可复现：

```sh
.tools/decider-venv/bin/python tools/decision/check-decider.py
.tools/decider-venv/bin/python tools/decision/check-decider.py --backend metal
.tools/laya-venv/bin/python tools/decision/check-laya.py
```

模型和环境放在Git忽略的`.tools/`；原始结果在`output/validation/`。Decima复现见`docs/audio/decima-comparison.md`。作者公布的GPU、iPhone或其他Android速度都没有当作本手机的速度。

## 首图复核策略

1. 用户开启“自动拍照与识别”；音频保留在本地，先过VAD/声音候选与上下文处理。
2. 本地规则或Decider提出可能用餐，先开`probe`，只允许一张。身份未知不再要求先证明已经进食；已知媒体、旁人自己的计划、明确拒绝、未来/假设和旧录音仍过滤。
3. 首图原子保存并回ACK；持久化视觉任务再调用Step，不让网络推理阻塞相机上传回执。
4. 首图无食物结束，不生成餐记录；画面不清最多重试一张。看到食物才开新的`followup`窗口，最多补两张，始终受45秒总期限和3张总预算约束。
5. 多图共享一个候选餐；后续照片只保留为视角，`analysis.captureIds`只列实际分析过的图。实际吃多少由用户确认。

模型分布不是经过当前领域校准的真实发生概率。将第一次拍摄作为可控的取证动作，能降低触发器的准确率要求；暂停、限次、到期、冷却和首图复核共同控制误拍。
