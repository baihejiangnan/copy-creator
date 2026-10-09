# 2026-10-07：保存核心与生命周期交接

本记录是实施中证据，任务状态以 [TODO](../TODO.md) 为准。持续执行目标已创建；界面、v3 备份、联合搬迁及最终功能/优化验收仍需继续。

## 已接入

- [noteCoordinator.ts](../../copy-creator/src/lib/noteCoordinator.ts)：500ms 空闲、2s 最长触发；中文 IME 不提交半成品；每个便签一个不可变在途快照；旧确认只清除对应序列；未知结果重试原请求，再发最新稿；失败/冲突保稿，显式副本重映射 ID。干净 LRU 5 条，dirty 最多 4 会话；原始 UTF-8 字段预留 16 MiB、已接受快照另预留 16 MiB，不等于整个 JS 堆或 IPC 峰值上限。精确字节校验在保存时运行，每次输入先做有界长度检查。
- [notes.ts](../../copy-creator/src/lib/notes.ts)：页面外惰性原生适配；初始化后注册保存屏障与存储身份失效，未使用便签不请求列表或正文。
- [saveBarrier.ts](../../copy-creator/src/lib/saveBarrier.ts)、[lifecycle.ts](../../copy-creator/src/lib/lifecycle.ts)：冻结所有写入者后确认保存；保存阶段超时不会因晚确认启动操作；已开始原生操作等待结果后才恢复。设置屏障不能把吞掉错误的 `commitAll` 返回当成成功，需检查错误/清理确认。
- [lifecycle.rs](../../copy-creator/src-tauri/src/lifecycle.rs)：主 WebView session/request 绑定；15s 未确认原生请求失败关闭；前端 10s 保存上限，后端 5s 排空上限。托盘退出、原生退出与自定义重启统一交接；移除不经过交接的 process 默认权限。Tauri 本地 2.11.1 源码确认 RESTART_EXIT_CODE 不受 `prevent_exit` 取消，因此先确认再调用 `request_restart`。
- 后端先暂停并等整轮生产者及保存接受入口关闭，再排空便签 32 个写槽、密码箱异步 16 个操作槽和 DB 锁。采集 guard 覆盖序列号更新、图片/文件处理及插入/清理；暂停期间不吞掉剪贴板变化。同步变更有生产者 guard；翻译异步结果持锁复核原 epoch 和暂停状态。
- 备份导出/导入和目录切换使用 kind/session/epoch/token lease，实际 worker 完成前不能恢复。前端先生成 token，开始确认丢失仍能结束；结束响应丢失可原 token 重试，旧 token 不能结束新操作。重载新 session 标记旧 lease 结束，等实际 worker 退出后恢复。导入后提升 epoch；事件之外还读取最终身份，避免仅依赖通知。
- 隐藏、最小化、原生关闭/失焦、托盘及快捷键隐藏发保存提示；模块不随页面销毁。它们不是退出确认，后台保存继续。

## 验证

环境沿用[第一批](2026-10-07-notes-foundation.md)。测试使用合成夹具；没有启动真实应用、读取或更改用户数据库。

| 检查 | 命令与结果 |
| --- | --- |
| 前端保存/屏障 | `node --experimental-strip-types --test tests/*.test.ts`，23/23 通过：16 项保存、7 项屏障 |
| Rust 全量 | 正常 Windows 用户上下文 `cargo test --offline --lib`，88/88 通过，含原 85 项与最初 3 项协议测试 |
| 补充 lease 协议 | `cargo test --offline --lib lifecycle::tests`，当前 6/6 通过；新增错误 kind/token、worker 持有、过期结束请求等测试，不能把此局部运行写成当前 91 项全量运行 |
| 类型 | `node node_modules/typescript/bin/tsc -b` 通过 |
| 代码检查 | 新增 lib、便签类型、生命周期组件、受影响设置组件/编辑 store 及 tests 的 ESLint 通过 |
| 中间生产构建 | Vite 8.0.12，输出 `output/optimization/R2-wip-20261007/frontend`；JS 512.60 kB、CSS 83.87 kB（Vite 显示值）；仍有主 JS 超 500 kB 提示，分包待处理 |

R0/R1 字体独立对照未被覆盖；R2-wip 仅为当前可构建证据，不能用其归因最终优化收益。

## 仍需验收

原生窗口退出/重启与主窗未 ready/重载、故障注入、恢复按钮、后台图片工作跨切换和旧模块缓存失效尚无桌面证据。便签文件操作与页面恢复状态、备份 v3、联合搬迁/失败重试、Release FULL/NORMAL、运行性能/体积及视觉回归继续进行。S-01/N-03 暂不勾选；不以纯协议测试替代桌面验证。
