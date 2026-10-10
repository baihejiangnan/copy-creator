# 轮盘随记与原生 Key 标记：继续修复验证

## 基线与范围

2026-10-10，在 `0746faa` 上保留接手时的 9 个已修改文件和未跟踪接手记录，继续处理清单 P1-1、P1-2，以及直接涉及的 P2-16/P3。应用四处版本仍为 **0.2.28**，schema 6、备份 v4；没有新增迁移或依赖。执行 `git fetch origin --prune` 后，修复前本地 main 比 origin/main 领先 1，落后 0。本次只交付本地源码提交，不推送、打包或发行；`output/` 中的日志、临时库和反向验证脚本不提交。

先读取 AGENTS、TODO、第五版修复清单、上一轮接手记录、随记状态机验证和相关设计，再审查已有 diff。上一轮接手补丁的来源与验证仍由[接手记录](2026-10-10-agent-handoff.md)维护；本记录新增其反向验证结果，不改写历史测试数字。

## 实现与原因

| 范围 | 实际变化 |
| --- | --- |
| P1-1 数据源 | [RadialMenu](../../copy-creator/src/components/RadialMenu/index.tsx) 不再导入 phraseStore。[只读模型](../../copy-creator/src/lib/radialNotes.ts) 使用与 useRecordGroups 相同的 `get_suiji_groups` 命令、`list_suiji` 摘要游标和按需 `get_note`。`phrase_groups` 保持 live；包含全部、未分组和自建组，活动记录按最近编辑排序，每页 50，最多 2000，去重；每类查询一活动/一可替换等待。隐藏清空摘要，旧查询/存储代次结果不能回填。 |
| P1-1 保存与粘贴 | [主窗](../../copy-creator/src/App.tsx) 接收 `radial-note-flush`，初始化主窗 coordinator，执行已有 saveBarrier 的暂停/flush/恢复，再回 `radial-note-flushed`。[握手](../../copy-creator/src/lib/radialNoteFlush.ts) 在发请求前订阅，匹配 requestId 和 storageEpoch，总超时 11 秒（主屏障默认 10 秒），注册迟到也释放句柄。事件只携带 ID、代次和错误码，不携带正文。失败/超时不读取旧正文、不粘贴；成功后重新 get_note，保留空白和换行，再 invokeStorage 调 paste_text/paste_file。仅文件且无正文时粘贴文件，其他无正文记录沿用引用目标拼接语义。 |
| P1-1 UI/并发 | 粘贴按当前分类分派，避免同 ID 的剪贴板记录抢先命中；保存/粘贴未完成时不接受下一次手势。失败保留可关闭的中英文提示。完整正文不放进轮盘编辑会话、也不长期缓存。 |
| P1-2 | [db.rs](../../copy-creator/src-tauri/src/db.rs) 在同一连接锁内读取 type/content，只允许 text/link，返回 clipboard.invalidRecordType/recordNotFound/updateFailed/apiKeyTooLong。手动标记上限为 **16 KiB UTF-8 原文**，支持长 token/JWT/PEM，不采用自动识别的 200 字节启发式；受保护内容先限制密文规模、再解密校验原文。重复标记不二次加密，超长旧文本仍能取消手动标记，原有 DPAPI 保护保持。 |
| P2-16 纠错与修复 | 原组件的 effect 依赖稳定，setup 仅在挂载时调用；“每次显示重复注册”不成立。实际缺口是异步 listen 在 effect cleanup 后才完成时泄漏。[句柄所有权 helper](../../copy-creator/src/lib/eventSubscriptions.ts) 覆盖轮盘及新增主窗监听，迟到注册立即释放。组件测试验证反复显示不增加监听、卸载后全退订。 |
| P3 | 删除轮盘只写不读的 lastFocusRef、不可达 hidden 分支、两处 console.log；[剪贴板卡片](../../copy-creator/src/pages/ClipboardPage/ClipboardCard.tsx) 的展开/加载文案中英文同步，删除按钮增加已存在的 common.delete 可访问名称，Key 标记错误由现有 alert 显示。其余 P3 未批量删除。 |

使用独立只读模型，而不是在轮盘导入 useRecordGroups 的值依赖：后者会引入 notesWorkspace、保存协调器和设置依赖。RecordGroup 仅为 type-only 引用；主窗协调器只在主窗响应握手时初始化。两 WebView 的 JS 状态与预算继续独立。

## 自动检查

命令均在内层 `copy-creator/` 执行。Rust 子进程的 TEMP/TMP 指向仓库 `output/tmp-rust`；全部数据为合成夹具、内存库或临时库。没有启动 Tauri 桌面应用，没有访问真实用户库、密码箱、备份或系统剪贴板。

| 实跑命令 | 结果 |
| --- | --- |
| `pnpm test:unit` | **104 passed / 0 failed**（接手基线 90，新增 14）；包括真实 TSX 的 VM 接线测试、只读模型/握手和静态文案检查 |
| `pnpm exec tsc -b` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm build` | exit 0；Vite 543ms，仅前端产物 |
| `$env:TEMP = Join-Path (Resolve-Path ..) 'output/tmp-rust'; $env:TMP = $env:TEMP; cargo test --manifest-path src-tauri/Cargo.toml` | **178 passed / 0 failed / 5 ignored**；main/doc-tests 各 0 项。新增 3 项手动 Key 测试和 1 项真实旧短语提升→随记分组/未分组/完整正文查询测试 |
| `pnpm exec vite build --manifest`（改动前/后同方法） | 均 exit 0；后测 625ms。只用于下面的入口依赖闭包比较 |
| `pwsh -NoProfile -File ../scripts/qa-process-isolation.ps1` | 开始与最终收尾均 exit 0、ownedQaNativeProcesses=0。中途一次在 cargo 尚未结束时检查，脚本正确拒绝，报告 PID 156376；未停止进程，等待 cargo 完成后重跑为零 |
| `git diff --check` 与文档本地目标检查 | 通过；仅核对文件目标，不验证外网或 Markdown 锚点 |

Rust 编译有 linker 创建 import library 的提示；本轮首次定向编译暴露缺失 OptionalExtension 导入，补齐后定向和全量均通过。没有把编译失败当作行为反向验证。

### 入口体积对照

在同一工作区、同一依赖与 Vite 配置，用 manifest 从 radial.html 递归遍历 **静态 imports**，去重求和 `.js` 原始字节。改前 **332,807 B**，改后 **336,065 B**，增加 **3,258 B（0.98%）**，均为 8 个 JS 文件。改后闭包不包含 notes/notesWorkspace、NoteBodyEditor/CodeMirror 或 lifecycle 编辑依赖。改前是接手工作区而非旧发行二进制。此数不含 CSS、字体或动态页面，不代表 EXE/安装包体积、内存、延迟或整体性能验收。

## 反向验证

每次从当前文件保存原始字节，只回退一个缺陷行为，运行对应测试，要求出现实际失败（不能用编译失败冒充）；finally 恢复原字节并校验相等。全部恢复后执行上面的全量绿灯。临时脚本与日志保存在未提交的 output/。

| 实际临时回退 | 捕获结果 |
| --- | --- |
| list_suiji 改为已退役 get_phrases | 前端 3 项失败 |
| 去掉轮盘 await 主窗 flush | 前端 2 项失败，能捕获提前读取/保存失败仍继续 |
| 去掉 requestId/epoch 回执匹配 | 1 项失败 |
| 主窗 await flush 改为不等待 | 1 项失败，未落盘时提前确认 |
| 注册改为无超时 await | 1 项失败，注册超时/迟到释放用例捕获 |
| 去掉迟到监听立即释放 | 1 项失败 |
| 将实际 RadialMenu 整体临时还原到 HEAD 旧组件 | 2 项失败（真实分类接线与旧死代码检查） |
| 去掉粘贴期间拒绝新手势的守卫 | 1 项失败 |
| 将实际 ClipboardCard 临时还原到 HEAD | 2 项失败（文案/删除名称与实际 Key 错误 handler） |
| 去掉上一轮 back 的导航代次守卫 | 2 项失败（同 ID 与不同 ID） |
| 去掉原生类型和两处长度校验 | Rust 2 项失败、1 项通过；不是编译错误 |
| 去掉上一轮迁移颜色元数据准入 | Rust 1 项失败；不是编译错误 |

监听测试最初在断言前调用了第二次 cleanup，缺陷实现也会绿；反向验证当场发现，已改为**一次 cleanup 后迟到句柄必须立即释放**，再验证第二次 cleanup 幂等，重新回退确认为红。P1-7 的锁内 epoch 复核属于已纠正推断后的加固，不冒称可复现的生产换库竞态修复；两处错误类型适配是编译修正，来源见上一轮记录。

## 单独评估与待验收边界

任务状态与下一顺序仅维护在 [TODO](../TODO.md)，这里记录为何没有批量改动：

- **P2-6**：重读 migrate_storage 与 prepare_target，源路径、目标准备、写 storage_path、连接替换及 epoch 推进构成连续提交段；失败保留旧连接，有暂存 receipt 才允许恢复重试。入口已经 spawn_blocking 并使用排他保存交接。没有本轮长锁收益测量，不能直接移出锁。
- **P2-12**：嵌入托盘 PNG 的 expect 是构建不变量；OwnedGlobalMemory 的 expect 是所有权已转移断言，Drop 只释放仍持有的句柄；便签 Trash 游标的非空性由 SQL 谓词保证、Vec<i64> JSON 序列化不是环境失败。中心连接锁、路径解析、其他全局状态锁必须逐类确认一致性，不能统一 into_inner 恢复。此前 UTF-8 panic 修复保留。
- **P2-14**：重读 TTL 回收、迁移事件与启动路径。clipboard-deleted/storage-changed 是落库后的通知，失败不应逆转已提交事务；迁移还有主动 epoch 确认。临时图片 unlink 和 GlobalFree 是清理/析构，不能一律改为传播错误；自动启动修复失败可能影响注册状态，需要隔离注册项与故障夹具。没有直接给 109 处统一加原始错误日志，以免引入内容/路径泄露或改变失败语义。
- **其他 P2**：P2-1/2 是挂载/HMR 句柄维护，P2-3 是图标模块副作用，P2-4 是同代次通知计时，P2-18 是父子重复分组订阅，仍需各自独立回归；本次 helper 不代表这些调用点已修。P2-5/8/9/10 牵涉兼容命令、图片读取身份、旧短语写入口与迁移归属；P2-7/13 需热点测量；P2-11 需模型/API 地址缓存失效合同；P2-15/20 是前缀/哨兵一致性。逐项保留，未靠编号机械改造。
- **其他 P3**：旧 phraseStore 与其兼容测试、5 个旧短语文件未删除；其他 i18n、选择器完整键盘交互、样式归属和类型清理保留。删除兼容命令/测试必须有独立淘汰依据。
- **桌面验收**：VM 组件测试不是真实 React/StrictMode/WebView、Tauri event/ACL 或外部应用插入验收。需要隔离实例验证主窗隐藏时的保存握手、未落盘/冲突/超时、目录切换中粘贴、连续手势、文件引用、主题/缩放和外部焦点。原生 paste 成功仍没有目标应用插入确认；不据本轮测试消除既有第 17 次空粘贴边界，不勾选 N/O 整体完成。
