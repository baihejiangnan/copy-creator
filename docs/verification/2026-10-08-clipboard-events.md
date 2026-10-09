# Windows 剪贴板事件唤醒与延迟

原 800ms 轮询与 PRD 的复制后 100ms 内完成记录存在直接差距。本轮使用同一合成库、同一冻结前端、WAL/FULL 和独立自动启动身份的完整默认 Release 对照。没有读取生产库或真实剪贴板内容；原剪贴板仅保存在保护助手内存，停止 QA 后恢复并逐字节校验。

## 实现与边界

[clipboard_wake.rs](../../copy-creator/src-tauri/src/clipboard_wake.rs) 用独立原生消息窗口接收 WM_CLIPBOARDUPDATE，sync_channel(1) 只保留一次唤醒，数据仍由原有单个采集 worker 读取/处理。回调不读内容、不执行 SQL、不创建 WebView；注册/消息泵失败或事件遗漏保留 800ms watchdog，通道断开后退回 sleep，避免忙循环。依据：[Microsoft AddClipboardFormatListener](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-addclipboardformatlistener)。没有仅缩短轮询间隔。

采集继续先取得 lifecycle producer；保存交接/排他操作期间不得绕过暂停。启动原有 1.6 秒抑制按经过时间计算，避免事件突发消耗“两次轮询”计数。PASTING、敏感序列号和去重规则保留。新增采集文本快照与应用原生复制事务的互斥：防止 worker 检查 PASTING 后恰好读到尚未发布敏感序列的私密文本；文本/图片/文件写入与缓存同步在同一互斥范围，图片处理不占用这把互斥。没有声称实际复现过私密文本泄漏。

原生回归 **128 通过 /3 忽略**；前端未改，沿用该冻结 **71/71**、类型/lint/构建证据。完整默认 `native-release-clipboard-events` **46,268,928 字节**，SHA `ede0d6686853230e12ba4d20f47f7ee03387f9e8fe6e3cc45accbdc2c1d2a0db`，缓存构建 72.279 秒；前版 `native-release-backup-session` **46,266,368 字节**，增加 **2,560 字节**。前端/CSS/5 个原字体不变。

## 实际原生写入至提交事件

[驱动](../../scripts/verify-clipboard-latency.cjs) 通过自有 Windows 窗口写入 60 次唯一合成普通文本，在当前 WebView 接收实际提交后的 clipboard-update；每次带不同间隔，避免固定相位。计时从发给辅助进程前开始，包含辅助进程调度、原生写入、DB 提交和事件 IPC；排除启动抑制期。不是只测 SQL，也不是图片/文件或系统任意负载的延迟保证。

| 同环境样本 | P50 / P95 / max ms | <100ms 样本 | 报告 |
| --- | ---: | ---: | --- |
| 原 800ms 轮询 | 672 / 761 / 764 | 0 /60 | clipboard-latency-1791433348115.json |
| 事件唤醒 | 22 / 36 / 87 | 60 /60 | clipboard-latency-1791433504774.json |

两轮分别另做 **100 次成功的合成私密复制**，历史均无对应记录；系统剪贴板暂时占用正确返回 clipboardBusy，驱动仅对该错误最多重试 20 次、每次 10ms，并报告实际重试 **20 /12 次**，不称一次调用全成功。产品没有增加这些重试。对应包装器 controlled-clipboard-1791433345645、1791433500720.json 均完整通过，4 格式恢复/字节校验。

前两轮保留失败：1791433051769 完成 60 次延迟后因驱动误用 unlock 参数而失败；1791433250867 完成延迟后遇真实 clipboardBusy，未完整做完私密复制。第一轮还与编译部分重叠，不用于最终配对结论。修正参数、明确有界 busy 重试后，待编译停止完整重跑上表基线，再构建并测候选；两个失败轮包装器同样恢复/校验 4 格式，不当作全轮通过。

## 同 SHA 的系统输入与保存交接回归

`controlled-desktop-1791433548165.json` 通过实际便签复制路径/原文、物理 Ctrl+Shift+右键唤起、记住的专用目标真实 Ctrl+V 粘贴、默认系统采集后卡片收存，以及 Windows 中文 IME 组合超过 2 秒不保存、提交后正文/版本一致。包装器 controlled-clipboard-1791433545735.json 恢复/校验 4 格式。不是程序派发 composition 事件代替 IME。

备份首轮 backup-handoff-1791433566347.json 的失败由辅助脚本在 bundled .NET 加载 Framework UIAutomationTypes 失败引起（包装器 controlled-clipboard-1791433563526.json）；失败稿/设置拒绝已执行，但不能算整轮通过。检查门槛实际只需确切 PID/hash 所属原生文件框，改用已有 Win32 控件枚举并检查文件名字段/取消按钮，未放宽作用域或改产品。失败轮恢复/校验 4 格式。

`backup-handoff-1791433630630.json` 完整重跑通过失败稿/无效设置拒绝、先保存再导出、原生文件框 lease 中 23 次读写/清理拒绝、取消恢复、成功导出后继续保存，以及认证导入证明导出正文准确且本机更新保留。包装器 controlled-clipboard-1791433628158.json 恢复/校验 4 格式。

再在 `backup-handoff-1791433694840.json` 的真实原生导出文件框期间，通过自有合成窗口实际改系统剪贴板；**等待 1,050ms 覆盖事件及 watchdog，记录仍为 0**。取消导出后监听恢复，只产生一个完全一致的记录，观察恢复延迟 559ms；它属于排他暂停后的 watchdog 补读，不冒称暂停期间仍满足 <100ms。随后整轮成功导出/认证导入仍通过，自有剪贴板记录已移除。包装器 controlled-clipboard-1791433692307.json 恢复/校验 4 格式。

多 DPI、图片/文件采集延迟、持续系统负载、空闲 CPU 与剩余 S/N/O 验收仍依 [TODO](../TODO.md)。不据普通文本 60 样本宣布整体产品性能达标。
