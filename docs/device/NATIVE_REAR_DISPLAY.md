# Habi 手机原生背屏接入

2026-10-15：已实现原生接入并完成编译，非空图案从普通 App UID 提交和完整到期恢复仍待真机验收。本文与 `CUSTOM_REAR_DISPLAY.md` 的 shell 独占实验分开记录。

## 已接入的行为

- 网页状态通过 `EchoDevice.setRearScene` 进入原生 `RearDisplayController`；普通第二显示设备继续使用公开 Presentation 接口，StepX 点阵走 `VendorRearService`。
- 原生服务直接读取同源 `contracts/rear-display/habi.json`，支持陪伴、留意、收好、聆听、轻摆、休息，每个场景取第一张静态帧。没有接入连续动画。
- 每次目标显示约 8 秒。场景变化先清理当前图案，再提交最新场景；网页轮询不重复续期。
- 设置增加“Habi 自定义背屏”开关，背屏面板增加“显示到手机背屏”。未配置诊断权限时不可启用。
- 独立 `:rear` 前台服务不调用录音、相机或云端模型。通知提供“停止背屏”。它与主界面进程分离；主进程退出后的恢复能力尚待实测。

## 调试包配置

厂商 setter 的签名权限声明不作为该固件实际拒绝普通 App 的证据。本次普通 App UID 10109、厂商权限未授予时，`setBackScreenFrame(null, null)` 调用成功；这只证明空帧入口可调用，不能代替非空图案显示验收。

当前实现使用 `dumpsys display_ext back_screen` 查询帧归属，因此仅 debug manifest 声明 Android `DUMP`。它是范围较广的系统服务诊断读取权限，并非厂商写帧权限。未授权时原生服务拒绝写帧，不降低归属检查。release 没有声明此权限，这一接入目前面向设备调试包。

用户明确同意后才执行一次性授权：

```sh
.tools/platform-tools/adb shell pm grant com.withecho.companion.dev android.permission.DUMP
```

撤销：

```sh
.tools/platform-tools/adb shell pm revoke com.withecho.companion.dev android.permission.DUMP
```

此后手机自身调用 setter 和清理，不需要电脑运行中继；脱线实际显示与恢复仍需单独验收。USB 中继和原生服务联调时应只保留一方控制。

## 归属与恢复

写入前获取与 shell 实验相同的本机抽象 socket 租约，确认槽位为空、系统没有活跃交互。先记录 App UID、启动轮次和精确帧 SHA256，再调用 setter。

到期或停用时，只对同一 App UID、journal 中精确 hash 的帧清理。两次快照须一致，发现外来帧即保留并退出；读取不完整时不盲目清屏。清理后等待至少 6.2 秒跨过厂商延迟持久化窗口，再复查 active 与保存帧均为空。所有恢复检查有界执行，失败报告 `cleanup-pending` 并保留 journal，下一次启动再尝试按归属恢复。

由于厂商没有 token/原子按 owner 清理接口，快照与 setter 之间仍有竞态，同 UID 外部写入在持久化前也无法完整识别。完整 force-stop 会杀掉 App 的所有进程，独立服务不能保证在此情况下继续清理。系统通知、拍照和姿态/温度等显示策略保持优先，没有改亮度或全局常显设置。

## 验收证据

- 空帧 App UID 探针：`output/validation/habi-rear-app-uid-probe.txt`。未启动麦克风或相机。
- 归属策略 host fixture：`android/tests/RearFrameOwnershipFixture.java`，19 项检查通过，覆盖外来 UID/hash、未知快照、外部系统/Agent 状态与持久化残留。
- Android 编译记录：`output/validation/habi-rear-native-build.log`。
- 网页编译记录：`output/validation/habi-rear-web-build.log`。

待完成：新版安装、用户批准的诊断授权、App UID 非空图案接收/持久化/应用/清理回读、实物确认、主界面进程退出后的清理，以及断开 USB 后显示和恢复。安装前必须确认正在运行的录音已结束，或用户已明确同意中断。
