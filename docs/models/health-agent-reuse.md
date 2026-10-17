# health-agent 食物识别复用

核查日期：2026-10-15。只读用户明确指定的私有仓库 `Jack-Yang-ai/health-agent`，固定源码 commit `67dedf452212cb53ba3ab343fb86b3af8a92bcb7`。没有拉取用户健康数据、图片、日志或录音；没有把密钥打印、写入代码或带到浏览器。

## 已核调用路径

核心源码是 [server/food_vision.py](https://github.com/Jack-Yang-ai/health-agent/blob/67dedf452212cb53ba3ab343fb86b3af8a92bcb7/server/food_vision.py)，提示词在 [server/food_prompt.py](https://github.com/Jack-Yang-ai/health-agent/blob/67dedf452212cb53ba3ab343fb86b3af8a92bcb7/server/food_prompt.py)。照片主路由：

| 项目 | 源码中的确定值 |
| --- | --- |
| 模型 ID | `step-1o-turbo-vision`，中间是数字1、字母o |
| 接口 | `https://api.stepfun.com/v1/chat/completions` |
| 协议 | OpenAI-compatible Chat Completions，Bearer鉴权 |
| 密钥入口 | `STEPFUN_API_KEY` |
| 模型覆盖 | `HEALTH_AGENT_FOOD_VISION_MODEL` |
| 完整URL覆盖 | `STEPFUN_VISION_URL` |
| 请求 | system prompt + 可选文字 + 多张 `image_url`，图像使用 data URI/base64 |
| 默认参数 | max_tokens4096、temperature0.2、timeout120秒 |
| 推理设置 | 默认不发；只在 `HEALTH_AGENT_FOOD_REASONING_EFFORT` 明确设置时发送 |

该主路直接访问官方地址，源码没有必须经过 health-agent 专用代理的要求；运行环境是否需要系统代理，要以实际网络为准。[StepFun 官方首页](https://platform.stepfun.com/)也给出同一 `https://api.stepfun.com/v1` 的 OpenAI-compatible 用法。这里核的是源码配置，不代表本次已验证这个模型账号的可调用性、精度或延迟。

旧文件仍保留 TrackUp `AnalyzeWholeFood` 网关作为特定基础设施失败时的单图兜底。本工程没有自动启用这条额外外发路径；换供应商要由配置和用户上传选择体现。

`server/model_router.py` 的 step_plan `/messages` 是其他文本场景的路由，与本次食物照片的 `/v1/chat/completions` 分开。不能把 Step Plan 的端点、模型名或参数直接塞进这条视觉请求。

## 结构化结果与本工程口径

原 food_prompt 预期：

```json
{
  "status": "success",
  "name": "示例餐食",
  "ingredients": {
    "example_food": {
      "display_name": "示例食物",
      "weight": "105g",
      "calorie": "50kcal"
    }
  },
  "total_colorie": "310kcal"
}
```

数值仅为源码 schema 示例。原字段名确实为 `total_colorie`；原归一化函数也兼容 `total_calorie`。无食物为 `status=failed`，条形码为 `status=barcode`。旧代码还归一化碳水、蛋白、脂肪及 GI 等，本工程未导入这些健康判断。

本工程复用**模型、调用协议、多图+文字机制和参数**，继续要求自己的保守结构：`foodDetected / title / foods[{name,estimatedGrams}] / calorieRange{min,max}|null / uncertainties[]`。原因是旧 prompt 有“包装净含量等于整份重量”“通常不喝汤”等假设，不符合本产品拍到什么与实际吃多少分别确认的边界。

没有把旧单点 `310kcal` 人为扩成置信区间，也不把包装净含量当作实际摄入。模型必须明确返回有效区间或 null；不合结构时报告估算失败，原照片继续保留。多张同餐视角不能重复累加。

## 已实现的适配

`services/api/src/provider.mjs` 现在兼容原 health-agent 环境变量，同时保留本工程的显式覆盖：

```text
STEPFUN_API_KEY=在服务端安全注入
FOOD_MODEL_PROVIDER=stepfun
HEALTH_AGENT_FOOD_VISION_MODEL=step-1o-turbo-vision
STEPFUN_VISION_URL=https://api.stepfun.com/v1/chat/completions
```

只注入 `STEPFUN_API_KEY` 时默认选官方端点和该模型。`FOOD_MODEL_BASE_URL / FOOD_MODEL_API_KEY / FOOD_MODEL_NAME` 的显式配置优先。完整 `/chat/completions` URL 会归一到 base URL，避免重复拼接。

陪伴对话不在这条视觉复用路径内：`CHAT_MODEL_NAME` 独立配置，官方 StepFun 端点在未显式设置时默认 `step-5-preview`。它不会改变照片复核使用的 `step-1o-turbo-vision`，两条调用可以分别覆盖。

环境里偶然存在的 `STEPFUN_API_KEY` 只会自动发给官方 `https://api.stepfun.com` origin；自定义网关必须明确提供 `FOOD_MODEL_API_KEY`。没有把密钥透传至网页。

Provider 可接 `analyze(buffer,mime,{ images:[{buffer,mime}], note })`，最多六张图片；当前 API 如何选同餐来源仍由业务路由明确决定。未替调用方默默读取更多照片。

不强制发送未经本次官方文档验证的 `response_format`，继续用明确 JSON prompt + 本地 schema 校验。非JSON HTTP响应、反向热量区间、旧单点结构等不会成为成功估算。

## 凭据与验证现状

部署模板指向 `~/.config/health-agent/secrets.env`；本机该默认文件不存在。本轮只检查文件是否存在与选定环境变量名，不输出任何值。服务器可以从用户实际指定的秘密配置安全注入 `STEPFUN_API_KEY`；源码可复用不等于凭据已可用。

八项离线 Provider 回归已通过：默认模型/端点与参数、旧URL归一、显式覆盖、凭据不继承到无关网关、多图与文字、旧单点结构拒绝、上游非JSON、无食物字段收口。这些离线回归的图片字节和模型输出均为合成夹具。

用户随后在当前工程本机 `.env` 填入 `STEPFUN_API_KEY`，文件权限 0600，Git 忽略。2026-10-15 完成两次真实官方接口调用：512×512 合成无食物测试图返回 `foodDetected=false / calorieRange=null`，约 1435 ms；中性问候的模型对话约 677 ms（当时对话模型是 `step-1o-turbo-vision`）。报告在被忽略的 `output/validation/step-interface-check.json` 和 `step-chat-check.json`。这些只是单次调用可达性、模型读取图片与结构化响应验证，未作为用户餐记录保存。

2026-10-17 把陪伴对话的默认模型切到 `step-5-preview`，并用同一服务端密钥做了一次真实问候调用：HTTP 200，约 1.74 s，返回中文短句。只验证模型 ID 可调用与对话格式，未重测视觉模型，也不代表长期延迟、并发或准确率。已有部署升级时要把 `.env` 的 `CHAT_MODEL_NAME` 更新为 `step-5-preview` 并重启服务；显式配置优先于代码默认值。

本机服务已重新加载配置，`analysisConfigured=true / chatMode=model`，餐食数量仍为 0。真实餐食识别、份量和热量误差、持续延迟仍待单独验收。原仓库注释里的20张图 benchmark属于旧项目记录，没有改写成本 App 的实测结果。

后续重新读取GitHub主分支，最新commit仍为上述版本；完整food_vision.py的Git blob为`b00dde26b255257223b30dcb1663335559ff71b1`，参数一致。真实联网复测发现Step可返回合法无食物JSON但`uncertainties=[]`；原schema要求至少一项而导致HTTP502。现已允许无食物结果保留空列表，有食物估算仍要求非空的不确定性说明，并补回归。修复后经隔离后端的照片分析与对话接口均HTTP200，报告`output/validation/mac-step-check-fixed.json`；用户数据未写入测试库。
