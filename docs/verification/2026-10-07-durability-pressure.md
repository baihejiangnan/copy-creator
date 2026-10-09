# 持久性、原生压力与长正文绘制检查

更新：2026-10-07。仅使用独立 QA 标识、合成内容与临时数据库。整体首发仍在验收，状态见 [TODO](../TODO.md)。

## 环境和产物

参考设备：Intel Core i7-13650HX，Windows 10.0.22631（Windows 11），NVMe SK hynix BC901 HFS001TEJ9X108N。WebView2 安装目录当前最高版本 154.0.4258.53，QA UA 为 Edge/Chrome 154；没有将目录版本当作精确的运行进程文件版本。Node 24.19.0、Cargo 1.98.1，bundled SQLite，x86_64 Windows MSVC。

已留存的嵌入前端 Tauri CLI 生产 EXE（没有启动生产标识）：

| 构建 | 字节 | SHA-256 |
| --- | ---: | --- |
| R0 原工作区基线 | 74,983,424 | `3ad0366aa118c9fd8363c77e33935171fd5b0b89bd40e598b5b3b7eb629927d6` |
| R1 仅精简字体，应用代码与 R0 相同 | 44,725,248 | `cd26107d4258ff5674ce3f902af8fe9933aeccafdf45b658118ab48166b11a3c` |
| R2 中间版本，便签与共享优化、最小窗修复 | 46,024,704 | `69a4a095e8b8b6dddf021fafe522c40f3463b1b5dbb91423fe5dc6ecdea90eee` |

字体单因素 EXE 减少 30,258,176 字节。R2 比 R1 增加 1,299,456 字节，包含便签及其他代码改动，不能全部归为便签成本。R2 是本批变更前中间版本，不是最终发行验收；安装包和发布配置实验仍待做。

QA 原默认 Release 使用 `frontend-min-window-fix`、NORMAL，SHA `895e07e1123597d9170ea99d46442717d25de3ab6ae097590e081d0016d92faf`。本批 FULL + opt-in diagnostics QA EXE 为 46,231,552 字节、SHA `48a5b77f51962a3f0260b103f2cb176f8ed01ceac0c132033a7894730ba10b2c`，同前端。诊断特性默认关闭，不能拿此变体作为最终包体积。

## FULL/NORMAL 与增量台账写入成本

命令：`cargo test --release --manifest-path copy-creator/src-tauri/Cargo.toml disk_durability_release_benchmark -- --ignored --nocapture`。两轮交替 FULL/NORMAL 顺序，各组合单独的本地磁盘临时库；相同 schema/索引，仅切换同步级别和容量触发器。每项预热 10、保留 100 个样本。

覆盖 4 KiB 剪贴板插入/计数读取、4 KiB/256 KiB 便签更新和正文回读、设置、短语、翻译记录及密码箱密文列的存储写入。密码箱夹具只测存储成本，没有执行加密、解密或密码箱业务 API。所有事务成功后重新打开并检查完整性及记录数。

原始完整结果：`output/optimization/disk-durability-release-20261007.json`，对应 stdout 日志同名 `.log`。保留触发器时，两轮 P95：

| 操作 | NORMAL ms | FULL ms |
| --- | ---: | ---: |
| 剪贴板 4 KiB | 0.12–0.20 | 1.03–1.32 |
| 便签 4 KiB | 0.04–0.08 | 0.59–0.72 |
| 便签 256 KiB | 0.43–0.83 | 1.14–1.18 |
| 设置 | 0.03–0.05 | 0.76–0.87 |
| 短语 4 KiB | 0.06 | 0.90–1.07 |
| 翻译记录 4 KiB | 0.08–0.13 | 1.07–21.78 |
| 密码箱密文列 4 KiB | 0.06–0.14 | 0.86–0.88 |

FULL 第二轮翻译存在约 22ms 的尾部波动；NORMAL 剪贴板最大值也有 16–25ms 的 checkpoint/系统噪声，保留原结果，不以平均值掩盖。触发器开启后的剪贴板 NORMAL P95 增量约 0–0.05ms，FULL 轮次间噪声大于该增量，不能据此声称触发器加速写入。这是磁盘事务微基准，排除 IPC、摘要/哈希、加密和界面。

已统一采用 **WAL/FULL**：启动、新建和迁移目标连接同配置，不在业务命令间切换同步等级；检查 SQLite 返回的 journal mode，持久连接无法使用 WAL 时拒绝继续。FULL 在每个 WAL 提交同步后确认，依赖系统和设备遵守 sync。NORMAL 在断电/系统崩溃后可能回退已提交事务；依据 [SQLite synchronous](https://sqlite.org/pragma.html#pragma_synchronous) 与 [WAL 说明](https://sqlite.org/wal.html#performance_considerations)。本批没有进行真实断电实验，也不将干净重开检查写成断电证明；未确认草稿仍需恢复/保存屏障，备份不可省略。

## 独立 SQL 指标和真实 IPC 压力

`diagnostics` Cargo feature 默认关闭，只对便签持锁操作设置有作用域的 profiler。退出、错误及 panic 后移除；线程本地计数不混入其他 worker。SQL 回调忽略语句文本，只累计语句数与耗时。日志只输出固定操作名、成功标记、后台排队/等锁/持锁微秒、SQL 语句数与粗粒度毫秒；只向专用目标写日志，单文件 2 MB、保留一份轮转。不记录正文、参数、Key、记录 ID 或路径。SQLite profile 为约毫秒分辨率，零不代表无成本，不能与高分辨率持锁时间直接相减推算 Rust 开销。

实际 QA DB 用原生命令创建 2,000 条独立便签，正文约 1–4 KiB，中文/代码/URL；合成前缀含 `%_`。数据准备可凭固定不可变请求重试。该轮尚未同时准备 2,000 条剪贴板，因此是便签侧常规夹具，不能标为设计要求的全应用常规夹具。

每操作预热 10、保留 100；混合场景同时发送 8 个读取和一个 single-flight 保存，busy 重试计入端到端时间。FULL 诊断构建结果：

| 原生 IPC | P95 ms |
| --- | ---: |
| 第一页摘要 | 1.5 |
| 不命中搜索（扫描正文） | 5.6 |
| 含 `%_` 字面搜索 | 1.6 |
| 全文读取 | 0.7 |
| 保存确认 | 2.1 |
| 混合保存 | 10.5 |
| 混合读取，800 个样本 | 17.6 |

458 次 busy 均有界重试成功。摘要最大 21,542 字节，无 body 字段；40 页恰好覆盖 2,000 个夹具 ID，无漏项/重复。完整日志区间中保存持锁 P95 1.633ms、等锁 7.748ms；列表持锁 P95 4.704ms，存在 162.576ms 最大值，包含预热与 UI 刷新，不应删去。端到端样本与所有原生日志的范围不同，不能一一等同。

前一 NORMAL 默认 Release 结果：不命中搜索 P95 9.5ms、混合保存 10.4ms。两次有缓存/构建特性/系统负载差别，不能推导 FULL 比 NORMAL 更快。原始报告 `QA-notes-20261007/reports/performance-stress-1791347909172.json` 与 `performance-stress-1791348290951.json` 保存产物身份、样本与原生指标。驱动：[verify-notes-performance.cjs](../../scripts/verify-notes-performance.cjs)。

## 长正文发现与修复

同一真实 Release WebView、每场景 110 次 CDP 键盘派发，排除前 10。普通输入从 input capture 到对应 Paint 结束 P95 1.835ms、无长任务；接近 256 KiB 的单段 `中A` 交替文本为 17.124ms，且每次键入存在约 1.2 秒的原生文本布局，最长任务 2,075ms。

主开销发生在 `textInput`/`keypress` 的浏览器 Layout，早于 input capture；仅统计 React/input 回调后的绘制会严重低估按键延迟。全跟踪 Layout 合计约 135 秒，而 FunctionCall 合计约 320ms。该场景当时**未达输入预算**。隔离 DOM 样式探针关闭拼写检查、连字或改变断词均未解决；关闭软换行仍约 95–109ms/键，且会改变使用体验，没有采用。

完整证据：`QA-notes-20261007/reports/performance-input-1791348470853.json` 及对应 `input-trace-1791348470835.json`。当前是 CDP 键盘，真实 Windows IME 另验。

改用 CodeMirror 的纯文本状态与视口绘制，保留软换行、字体、主题、拼写检查和完整正文；未引入语言解析器、格式化或富文本。先以隔离实验核验单长段与多段，再接入便签惰性页面。设置 LF 分隔规则以保留已存正文内 CRLF/单独 CR；协调器仍负责草稿、UTF-8 限额、保存与恢复，编辑器不代替可靠性边界。

默认 FULL、无 diagnostics 的 Release QA EXE 为 **46,109,696** 字节，SHA `b22511fd897e79440d612ef106db6931d4472315e233645637d67d1102f75c6f`，使用 `frontend-editor`。同一设备、相同 110 键/排除前 10 的跟踪：普通正文按键到 Paint P95 **3.392ms**、最大 7.172ms；262,134 UTF-8 字节的单长段 P95 **10.960ms**、最大 13.603ms，两个场景均 110 个对应 Paint、无超过 50ms 的长任务。原 input capture 后指标另存，不能代替按键指标。报告 `performance-input-1791367095362.json`、跟踪 `input-trace-1791367095347.json` 位于同一 QA 目录。该输入场景已通过，真实 Windows IME 仍待验。

代价单独核算：当前前端 40 个文件 **46,293,872** 字节，总 JS **817,439**（gzip 257,963）字节；CSS 90,798 字节，5 个字体 44,422,196 字节。编辑器位于惰性便签 chunk，主入口/轮盘静态 JS 闭包仍为 450,429/319,199 字节。相对上一中间前端增加 JS，不能称总 JS 优化。当前总前端仍低于方案的 46.5 MB 阶段预算。资源报告 `frontend-editor-inventory.json`；此 QA EXE 标识不同，不能与生产 R2 的差值全部归于编辑器。

默认 Release 已复验新建/保存/归档/删除/恢复、确认丢失重试、冲突副本、四份失败稿及上限、正文边界、440×420/125% 中英文浅暗界面。新增原生 CRLF/单独 CR/Unicode/空白的编辑保存、Ctrl+Z/Ctrl+Y、Ctrl+Enter、270,000 字节超限稿保留并修正保存、257 字符搜索错误后恢复均通过。Chromium `insertText` 会将新插入的 CR/CRLF 归一为 LF，驱动按此行为断言；已存原文的保持由末尾编辑用例单独核验，不混淆二者。

## 自动检查与剩余边界

正常 Windows 用户上下文完整 Rust（含 diagnostics）**120 通过、0 失败、2 个显式 Release 基准忽略**，15.62 秒；磁盘基准另行运行通过。前端 **38/38**、类型、完整 lint 与双入口生产构建通过。新回归覆盖原文换行/空白保持，以及超长 Unicode 搜索返回可捕获的 Promise rejection、保留上页且不发 IPC；256 个 emoji 可查询。超长查询的原生桌面页面复验已通过。

真实 IME、复制路径/剪贴板捕获、近上限/含图片备份、搬迁/完整退出及其他 DPI、10k/50k 压力、双窗口图片、全进程树、启动 30 次与安装包/发布实验仍待收齐。后续真实文件选择/定位、对话框竞态修复及约 7.59 MB v3 往返的补验见[第八批记录](2026-10-07-file-backup-desktop.md)。
