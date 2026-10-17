# 自定义背屏图案

2026-10-15 在 StepX PZ261A / Android 16 当前固件上验证：普通 ADB shell（UID2000）可通过厂商 `setBackScreenFrame(int[391], null)` 提交自定义图案，无需 root。本次“碗筷进食”静态图案已由用户确认实物正确。

## 画自己的图案

可编辑源稿：`contracts/rear-display/habi-eating.txt`。

- 每帧 23 行，每行 17 个字符。
- `#` 为亮点，`.` 为灭点；空行分隔不同帧。
- 示例包含碗、斜筷子和热气，共三帧。当前真机工具每次显示其中一张静态帧；GIF 仅为动画设计预览。

在仓库根目录生成设备数据和预览：

```sh
python3 tools/device/make-rear-pattern.py contracts/rear-display/habi-eating.txt \
  --output contracts/rear-display/habi-eating.json \
  --scene eating --pattern-id habi-eating-v1 --title '进食 · 碗筷与热气' \
  --preview-dir output/validation/habi-eating
```

预览需要 Pillow；JSON 生成和设备测试不需要它。位序为 MSB-left：bit16 对应最左侧；设备接收行优先的 391 个灰度值，此工具使用 0/255。

## 真机限时显示

USB 手机需已授权 ADB，并将背屏朝上。运行期间只允许一个 shell 图案控制器：

```sh
python3 tools/device/habi-frame-test.py --run \
  --pattern contracts/rear-display/habi-eating.json --scene eating --wake
```

使用 `--frame-index 1` 或 `2` 测试其他帧。不加 `--run` 只校验并编译，不操作手机。

目标展示时间为 8 秒。独立手机 guard 核对本次进程、epoch、UID 和精确帧 hash 后清理；清理后还等待超过厂商 5 秒持久化窗口并复查。慢速系统调用会使实际清理晚于目标，约 30 秒是实验预算而非硬实时保证。

## 本次实测

- 图案：`habi-eating-v1 / eating / frame 0`。
- 图案接收：`appUsesCustomFrame=true`、`appFrameOwner=uid=2000`。
- 系统显示：`appliedCustomFrame=true`、`policyAllowsOutput=true`、`power=on`。
- 持久化：超过 5 秒后，391 字节帧的 SHA256 与源稿一致：`ed6c0020310f60dc252152b117979ff3ac3d6b878810edd4c34accea158696e3`。
- 实物确认：用户直接回复“看到了，图案正确”。
- 实际清理提交：显示提交后约 8.85 秒；包括持久化复查的实验总时长约 21.76 秒。
- 最终：custom/applied 均 false、owner=none、保存帧为空。

原始本地记录位于忽略目录 `.tools/device-diagnostics/habi-frame-test-20261015-222711-06caff7a/`。`receipt.json` 保留工具自动结果；肉眼确认另存于 `physical-confirmation.json`，未覆盖原始数据。

## 使用范围

这是电脑 ADB 发起的独立实验工具；现有网页原 Habi 图案和 App/后端不依赖此工具。后续手机原生静态状态接入已完成代码与编译，完整真机验收仍待完成，见 [NATIVE_REAR_DISPLAY.md](NATIVE_REAR_DISPLAY.md)。连续动画尚未接入。

当前固件的签名权限声明不等于该帧入口实际执行了权限检查；本次成功以实机调用和用户确认收口，其他固件仍须重新验证。

帧属于 BASIC 显示层，通知、拍照、活跃 Agent 状态以及姿态/温度/休眠等策略可能影响显示。没有改亮度、全局常显或显示模式，也不使用绕过策略的 `pixel` 诊断路径。

服务端没有帧 token、当前帧 getter 或按 owner 原子清理 API。同为 UID2000 的另一个控制器若同时换帧，在其延迟持久化前无法完整识别。因此本工具只用于独占实验，不宣称解决了所有并发归属。正常到期恢复已通过真机验证，owner/hash 判断通过了合成检查；提前强杀与 USB 断开的恢复尚未单独实测。
