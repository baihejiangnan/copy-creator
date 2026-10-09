# 重载界面期间的原生保存握手

## 真实发现

`native-release-clipboard-events`（SHA `ede0d6686853230e12ba4d20f47f7ee03387f9e8fe6e3cc45accbdc2c1d2a0db`）的 [驱动](../../scripts/verify-lifecycle-reload.cjs) 暂留真正的原生重启保存事件，再实际执行主 WebView reload。新 JS 会话 ready 后，原生将旧请求绑定到新会话并重新投递；新前端据自己的空保存屏障发起旧请求的 lifecycle_saved。

`lifecycle-reload-1791433960619.json` 为 **reproduction**，replacementAttemptedOldAck=true。驱动在新的原生传输前拦住这条确认，先取消请求，再用旧身份真实调用确认，原生拒绝；后续当前会话排他 lease 正常释放。本轮没有让该请求实际重启，也未故意丢弃任何未确认草稿。它证明请求被错误重绑定及新确认尝试，不能称为已复现真实用户草稿丢失。包装器 controlled-clipboard-1791433958102.json 通过，停止 QA 后恢复/字节校验 4 格式。

首轮 lifecycle-reload-1791433885260.json 已观察重绑定，但驱动把自己后续的负向确认也拦住，导致等待；核对确切探针阶段后仅将该断言回调以驱动错误结束，保留 passed=false，未放行任何终止确认。包装器 controlled-clipboard-1791433882714.json 恢复/校验 4 格式。修正传输恢复顺序后完整重跑上轮；首轮不算完整通过。

## 修复与检查

原生 Protocol.ready 现在区分首次 ready 与已有会话替换：初次可以绑定尚无前端的请求；已有会话被替换时取消未确认的退出/重启，拒绝新旧会话对旧请求的确认，并给当前界面显示中英文 sessionChanged 提示。已进入最终排空/退出阶段仍拒绝新 ready，不提前恢复在途 worker；存储 lease 的原有 worker 持有规则保持。

新增实际 Protocol 回归，修复前因 pending 未取消而失败；修复后全量 Rust **129 通过 /3 忽略**，前端 **71/71**、类型及生产构建通过。此前一个误用 --exact 的命令匹配 0 项，不计入回归；已用正确过滤得到真实失败，再执行修复后的全量检查。

新冻结前端 40 文件 **46,297,783 字节**、JS **821,334**、CSS **90,812**、5 原字体 **44,422,196**；主/轮盘静态 JS 453,907/321,331。对上一冻结 JS +303 字节来自中英文提示。完整默认 `native-release-lifecycle-reload` **46,268,928 字节**，SHA `09f8425a0762b8a872cfeb45fbfad479eb5d8c5688aee92dd9250b3c9f6b3acb`，缓存构建 57.942 秒，EXE 字节数与事件版相同。

`lifecycle-reload-1791434124352.json` 在该默认 Release 实际 reload 后 replacementAttemptedOldAck=false，界面显示 sessionChanged 提示；新旧身份对旧请求的真实原生命令均拒绝，后续当前会话 lease 正常释放。包装器 controlled-clipboard-1791434120185.json 通过，4 格式恢复/字节校验。

同 SHA 的 `lifecycle-restart-1791434207203.json` 在实际便签协调器编辑的同一 JS task 请求正常原生重启，确认 pending=true；原进程 138536 被真实替换为同哈希进程 123796，仍打开相同合成库，正文 CRLF/空白/中文完整、revision 1→2。没有用 location.reload、外部停止或再次启动代替原生重启。包装器 controlled-clipboard-1791434204651.json 识别/停止替换后的进程，再恢复/校验 4 格式。

本记录不证明进程崩溃后的未提交 JS 草稿持久恢复、磁盘故障或未 ready 首次启动的完整桌面验收；剩余范围见 [TODO](../TODO.md)。

同 SHA 的联合回归 `lifecycle-joint-1791434224414.json` 再通过无效设置阻止重启、便签交付故障阻止真实托盘 Quit、实际保存截止后迟到确认不重启/不清新稿、隐藏按钮联合提交，以及正常托盘 Quit 后进程实际结束、磁盘正文和设置一致（revision 7、integrity=ok）。11,639ms 为驱动整体观察值，不改产品截止时间或称为原生 15s 无响应测试。包装器 controlled-clipboard-1791434221851.json 确认应用已退出后恢复/校验 4 格式。
