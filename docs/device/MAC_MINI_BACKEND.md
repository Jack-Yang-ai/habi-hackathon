# Mac mini 后端与 Step 调用

2026-10-15：用户决定将常驻后台留给后续Mac mini；当前电脑只写代码和手动测试，不安装后台常驻或登录自启动服务。当前Mac的试装已撤回，LaunchAgent未加载、自启动plist已移除。以下安装命令只在目标Mac mini执行；尚未在那台机器验收。

## 数据与模型

手机保存原始录音并运行SenseVoice和Decider。Mac mini运行单个Node服务，SQLite和原图留在其本地`.data/`；Step密钥只保存在Mac mini的私有`.env`。食物识别与陪伴对话联网调用Step，不要求另租应用服务器或数据库。

已重新核对私有health-agent主分支最新commit `67dedf452212cb53ba3ab343fb86b3af8a92bcb7`，`server/food_vision.py`的Git blob为`b00dde26b255257223b30dcb1663335559ff71b1`。复用其官方`https://api.stepfun.com/v1/chat/completions`、`step-1o-turbo-vision`、4096 tokens、temperature=0.2、120秒超时。详细字段边界见[调用复用说明](../models/health-agent-reuse.md)。

本工程继续用热量区间和本人食量确认，不把原项目的单点热量当成摄入事实。已修复真实Step响应`foodDetected=false / uncertainties=[]`被错误拒绝的问题；有食物的估算仍须说明不确定性。

## 准备可迁移代码包

开发机执行：

```sh
python3 tools/backend/package-release.py
```

生成`output/deployment/habi-mac-mini-时间戳.tar.gz`，内容是后端源码、编译好的前端、依赖锁文件、部署工具及合成测试图。生成过程检查本机已配置密钥未进入归档；不打包`.env`、SQLite、用户图片、音频、模型权重、node_modules或本机路径配置。打包不会安装服务。

## 在目标Mac mini安装

需Node.js22.16+、npm和Python3。解压到`~/Library/Application Support/HabiBackend`，避免常驻进程依赖Documents/Desktop/Downloads的目录访问权限。把归档路径换成实际文件：

```sh
mkdir -p "$HOME/Library/Application Support/HabiBackend"
tar -xzf /path/to/habi-mac-mini-release.tar.gz -C "$HOME/Library/Application Support/HabiBackend"
cd "$HOME/Library/Application Support/HabiBackend"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
python3 tools/backend/configure.py --lan
```

configure会在终端隐藏输入Step key，生成独立的App/设备随机口令，`.env`权限0600；不打印凭据、不覆盖已有配置，也不启动服务。省略`--lan`则只绑定127.0.0.1。同Wi-Fi连接使用`--lan`，当前是带鉴权的局域网HTTP开发通路，外出访问与公网HTTPS另行配置。

先手动启动并检查，之后才装常驻：

```sh
node --env-file=.env services/api/src/server.mjs
```

另开终端，进入同一目录，用合成图验证真实联网调用：

```sh
node --env-file=.env tools/backend/check-step.mjs --live --fixture tools/backend/fixtures/no-food.png
```

通过后在手动服务终端Ctrl-C，再执行：

```sh
python3 tools/backend/macos-service.py install
python3 tools/backend/macos-service.py status
```

服务使用当前用户的LaunchAgent，登录后自动启动，异常退出后重启；不是无需登录的系统LaunchDaemon。Mac mini仍需持续供电、联网并保持可运行，脚本不改变睡眠、合盖、网络或防火墙设置。日志在`~/Library/Logs/HabiBackend/`；plist只记录程序路径，不含Step key。

起停与撤回：

```sh
python3 tools/backend/macos-service.py stop
python3 tools/backend/macos-service.py start
python3 tools/backend/macos-service.py uninstall
```

所有操作仅针对当前部署目录产生的job，撤回时保留本地plist副本；不会卸载Node、删除数据或停止其他项目的进程。若要替换同目录已有手动服务，install的`--replace-running`只在核对PID、命令和工作目录一致后发SIGTERM，不强杀。

## 手机、开发板与备份

手机“设备”面板保存`http://Mac-mini的局域网IP:8787`；网页设置中用Mac mini `.env`里的`APP_ACCESS_TOKEN`连接。设备端使用不同的`DEVICE_ACCESS_TOKEN`，不持有Step key。IP随网络变化时需更新地址；手机后台发送只带文字/模型结果，原始录音仍留在手机。明文 HTTP 的页面不是安全上下文，没有 `crypto.randomUUID`（前端已做兼容，但仍优先用 HTTPS）。

对外域名 **https://habi.zhexin.site** 的联调方式、一键检查脚本、以及“线上旧版本 / 设备 token 不一致”的排查见[线上域名联调](./REMOTE_INTEGRATION.md)。

ESP32现有固件在局域网内上传照片；接板时需确认它与Mac mini网络互通并配置设备凭据。外出联网、手机热点转发、独立背屏及真实相机尚不能因这份部署包而宣称通过。

手动备份命令：

```sh
node --env-file=.env tools/backend/backup.mjs
```

通过SQLite一致性快照保存数据库，再复制快照引用的原图并核对SHA；检查SQLite完整性。备份保存在`.tools/backend-backups/`，包含业务数据，不含录音和密钥，不自动外发，也不自动删除旧备份。当前只提供手动备份工具，未配置每日计划。跨机器迁移现有业务数据时单独传输这份私有备份，不混入代码归档；停服后恢复数据库及配套media，保留原数据副本。

## 本轮证据

真实Step检测报告在本机被忽略的`output/validation/mac-step-check-fixed.json`：合成无食物图经后端分析接口HTTP200，真实模型对话接口HTTP200，测试数据库独立并在结束后清理。此前两次失败报告另保留，原因定位到空uncertainties校验；未作为真实用户餐食或热量准确率验收。

Mac mini未在本轮连接，因此常驻、睡眠恢复、局域网与跨机器数据迁移仍待目标机验收。
