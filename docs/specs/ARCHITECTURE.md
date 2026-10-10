# Copy Creator — 产品架构文档

2026-10-10 生命周期续接：剪贴板 store 统一拥有五个原生监听和存储身份订阅，在 WebView unload/HMR 释放，身份读取迟到不得继续查询；普通页面卸载保持共享 store。便签编辑器 groups 由父页面提供，不创建第二组订阅。密码箱复制/填入提示共用可取消计时器并保留 epoch 守卫。自动证据及桌面权限边界见[P2 验证](../verification/2026-10-10-p2-lifetimes.md)。

2026-10-10 轮盘接手：独立 WebView 使用只读 RadialNotes，通过 get_suiji_groups/list_suiji 有界读取摘要，命中前请求主窗 saveBarrier flush，匹配 requestId/epoch 后重新 get_note 并带 epoch 原生粘贴。握手 11 秒总上限，注册迟到也释放；失败不降级读取旧稿。轮盘不导入 notesWorkspace/coordinator 值依赖，事件不携带正文。原生手动 Key 标记只接受 text/link、最多 16 KiB UTF-8 原文，密文重试不重复加密。见[继续修复验证](../verification/2026-10-10-radial-notes-and-key.md)。

2026-10-10 接手复核：`notesWorkspace.back()` 在等待保存后同时校验导航代次、coordinator 和选中 ID，避免旧返回回调取消正在读取的新导航。分组命令保留 lifecycle producer 许可，并在连接锁内复核/返回实际 storage epoch；适配 notes 的结构化错误为既有字符串命令错误码。存储迁移空目标判定包含 `note_group_colors`，已验证暂存凭据的重试路径保持。源码、回归与验收边界见[接手记录](../verification/2026-10-10-agent-handoff.md)。

2026-10-10 随记整合：`PhrasePage/SuijiPage` 复用 `NoteEditor`、`NoteCoordinator`、有界 `NoteFeed` 和原生粘贴，不再新增独立便签侧栏。schema 6 新增 `note_organization`/`note_group_colors`，旧 `phrases` 在同一迁移事务中提升为 notes，旧分组沿用；`list_suiji` 提供摘要分页、分组过滤及可选 `sort=updated|created`；原生白名单选择对应时间列，与 ID 一起倒序构建游标，前端切换排序重置分页/代次并保留过滤范围，未传排序的旧接口行为保持，`organize_note` 使用 mutation ID、revision CAS 和存储代次。分组删除推进记录 revision，保留正文与常用。全局新建快捷键与窗口快捷键分别注册，设置失败回滚。 `RecordPreview` 通过独立 `LatestQuery` 按需读取一个完整预览，不占用编辑草稿缓存，迟到响应按挂载状态和存储代次拒绝；菜单样式集中到 `context-menu.css`。编辑分组使用 `RecordGroupSelect` 包装通用 `SelectMenu`，定位、滚动、焦点及动效样式由共享组件维护，通过 portal 渲染并按可视窗口定位，限制宽高、内部滚动、键盘及关闭时焦点处理；随记搜索直接复用剪贴板的 `SearchInput`，新增可选长度和组合事件参数以保留查询合同。默认灰色分组的显示色由 ID 稳定派生，用户自选颜色继续来自组织数据，数据库协议未变。协议与实测见[随记设计](../features/notes-design.md#2026-10-10-随记整合当前交互)、[随记验证](../verification/2026-10-10-suiji.md)。

收尾补充：O-01 基线与 O-02 字体集合验收已收回；连续粘贴补查获得外部剪贴板占用证据，默认已加入有界等待、焦点/序列校验与失败可见提示；最终连续 20 次复验第 17 次仍空，整体粘贴验收未通过，保留外部目标无确认协议的边界。最终 Release 46,393,856 字节，NSIS/MSI 32.19/33.94 MB；20MB 按用户指示为尽力参考。详见[粘贴等待与失败提示收尾](../verification/2026-10-08-closeout.md#粘贴等待与失败提示收尾)，整体状态以 TODO 为准。

首次 ready 前真实托盘退出已在最新默认通过：根节点尚空时不提前退出，恢复脚本/首次交接后实际结束。S-01 及其 N-03/N-06 依赖验收收回；新原生进程自动检查关/开为 0/1、关于 UI/焦点和最终静态依赖图补齐 O-07，详见[归并与边界](../verification/2026-10-08-closeout.md#首次-ready-与依赖验收收回)。

后继默认 Release 修复隐藏主窗缩略图占位动画仍转：同图片驱动约 30 秒单核 CPU 18.418→0.574%，双窗持续 110 图片、缓存/并发与隐藏停止通过，O-03 收回；O-04 真实查询 IPC 100→1 和插入期间分页无漏重已收回。EXE 仍为 46,369,280 字节，JS 增 51 字节，字体/CSS/原生摘要保持；全树内存未达标，不宣称内存下降。见[新默认证据](../verification/2026-10-07-images-query-entry.md#默认动画修复复验)。

滚动条主题修复、满容量/只读回归、异常结束后的同 EXE 原生重开及旧托盘命令跨迁移已补验；前端 74/74、Rust 137 通过/3 忽略、类型/完整 lint/生产构建通过。整小时核心及失败恢复分开记录；核对已有源码/报告后 S-01～S-04、N-03/N-06、O-03/O-04/O-05/O-06/O-07/O-09 验收已收回。最新 NSIS/MSI 为 32.19/33.94 MB；用户明确接受体积尽力优化，20MB 作为参考目标、不再作为收尾门槛。当前版补完 30 次启动观察和常用页/显隐采样，包含显式显示控制，不与旧轮直接计算启动收益。200% 实际缩放、剩余旧功能/故障矩阵及严格同方法运行比较仍待补；全进程树内存约 494/490MB，80MB 未达标。完整范围见[本轮收尾](../verification/2026-10-08-closeout.md)，状态以 [TODO](../TODO.md) 为准。0.2.25 已在用户明确接受已知问题后正式发布，剩余验收缺口保持，原 goal 仍暂停；见[发布记录](../verification/2026-10-09-release-025.md)。


2026-10-08：便签、共享保存与性能优化开发中；连接已统一 WAL/FULL，schema 5 有界搜索索引经用户批准接入，默认 50k 压力已复验。256 KiB 单段布局卡顿已通过纯文本视口绘制修复；真实 Windows 中文 IME 的组合停留/提交保存、物理快捷键及专用窗口粘贴已补验，其余联合验收未收齐。状态见 [TODO](../TODO.md)，最新证据见[受控桌面记录](../verification/2026-10-08-controlled-desktop.md)。

## 1. 技术栈

短语 store 的读取和六类写响应均按存储代次检查；创建确认按 id 去重，创建短语还需当前选中组一致。实际发现旧目录已提交的创建响应在切换后污染新界面，已以真实回调延迟/目录迁移对照修复，前端 46 项回归通过，见[迟到响应证据](../verification/2026-10-08-vault-phrase-regression.md#短语跨目录迟到响应的真实发现与修复)。

系统集成隔离不能只依赖 identifier：自动启动插件的 Windows Run 项按名称识别。正式 `com.copycreator.app` 保留既有 Copy Creator 名称，其他标识由同一 Tauri context 派生 `产品名 (identifier)`，启动修复和设置开关使用同一插件实例。旧 QA 同名污染已恢复并禁止重放，真实开关隔离已通过，见[边界与恢复证据](../verification/2026-10-08-autostart-isolation.md)。

验收进程隔离还需实时清单：单个所选 `process.json` 不能覆盖遗留搜索/profile/基线实例。启动默认/基线或创建剪贴板助手前只读测试根目录全部实际可执行路径，有存活实例则拒绝重复启动；旧搜索实验入口停用。历史漏停实例已核验保存后关闭，未知共享临时文件影响与性能环境限制保留，见[实例补查](../verification/2026-10-08-autostart-isolation.md#遗留实例补查与实时进程准入)。

可选 `db_metrics` 诊断对便签、周期清理及备份输出数值聚合；备份单列后台排队/执行和快照/冲突读取/密码箱配置/提交等 DB 范围的等锁、持锁、SQL profile。默认构建不安装 profiler，事务/lease/后台槽及原错误码保留；近上限实际样本和默认功能复验已补，SQL profile 生命周期可重叠，聚合不代表互斥 CPU 时间，见[备份计时边界](../verification/2026-10-08-rich-backup.md#近上限备份分项实测与默认复验)。

| 层        | 选型                            | 理由                                        |
| -------- | ----------------------------- | ----------------------------------------- |
| 桌面框架     | **Tauri 2.x**                 | 剪贴板监听、全局快捷键、系统托盘等需原生系统调用，Rust 层天然胜任；包体积极小 |
| 前端框架     | **React 19 + TypeScript**     | 生态成熟，组件化开发效率高                             |
| UI 组件库   | **纯 CSS + CSS Variables**     | iOS 风格设计，轻量无依赖，主题切换便捷                     |
| 状态管理     | **Zustand**                   | 轻量，无模板代码，适合中等复杂度                          |
| 本地存储     | **SQLite** (Rust: `rusqlite`) | 嵌入式关系数据库，零配置，Tauri 原生支持                   |
| 剪切板      | Tauri clipboard API + 原生扩展    | 文本和图片监听与写入                                |
| HTTP 客户端 | Rust: `reqwest`               | 翻译 API 调用，异步高性能                           |
| i18n     | `react-i18next`               | 前端国际化，支持多语言                               |
| 构建工具     | Vite                          | 快，React 官方推荐                              |
| 包管理      | pnpm                          | 磁盘高效，速度快                                  |

图片粘贴临时文件也按系统实例隔离：正式标识保留旧根目录，非正式标识的 CF_HDROP 写入和过期清理共享 `copy_creator_paste_instances/<identifier SHA256>` helper，不能与正式版或其他 QA 共用回收目录。默认实际启动的双非正式身份合成文件回归及旧产物拒绝已通过；历史共享目录影响范围不可追溯，见[系统隔离补查](../verification/2026-10-08-autostart-isolation.md#图片粘贴临时文件的共享目录补查)。

## 2. 系统架构

主窗口已有会话被重载后的新 session 替换时，未确认的退出/重启请求必须取消，不能重新绑定给新 JS 并由它确认旧草稿。首次尚无前端的请求仍等待初次 ready；已进入最终排空/退出阶段的新 ready 拒绝，存储 lease 仍随实际 worker 持有。实际重载已复现旧重绑定，新单元回归先失败后修复；默认版重载拒绝新旧确认/提示及 dirty 稿实际重启/同哈希替换进程/原文保持通过，见[会话重载证据](../verification/2026-10-08-lifecycle-reload.md)。

`NoteCoordinator` 惰性初始化并存活于页面之外，保存不可变快照与请求身份，区分已确认序列和最新输入序列。`SaveBarrier` 同步冻结所有已注册写入者、等待设置/便签确认，再执行原生操作；超时后的保存结果不能启动已放弃操作。`lifecycle.rs` 绑定主 WebView session 与 request/token，暂停完整生产周期，先关闭接受入口，再排空便签/异步密码箱/普通复制粘贴及数据库锁。数据操作 lease 随实际 worker 保留，重载或结束请求不能提前恢复生产者。重启使用自定义入口，因为 Tauri 的重启退出码不可通过普通退出拦截取消。Windows 在自有交接/排空和敏感资料清理完成后排入主线程执行 Tauri 直接重启，避免实际发现的已批准退出但循环未结束；默认 Release 已验证新草稿保存及替换进程打开迁移目标。完整退出与其他故障验收继续；见[交接设计](../verification/2026-10-07-save-handoff.md)及[实际迁移/重启证据](../verification/2026-10-07-file-backup-desktop.md#目录迁移源路由故障与原生重启)。

便签正文的 `NoteBodyEditor` 在惰性页面中使用 CodeMirror 纯文本状态与视口绘制，避开原 textarea 的边界长段布局开销；无语言解析器或格式化。原文、UTF-8 限额与恢复仍归协调器，编辑器不接管保存协议。LF 分隔规则保留已存 CRLF/单独 CR；只读和文案通过 compartment 更新，不因保存状态重建编辑器/撤销栈。真实输入跟踪和惰性 JS 成本见最新证据。

惰性页面的侧栏、设置和 open-note 导航使用 React.startTransition，便签复用外层已显示的 Suspense 边界；保留当前页面至目标模块就绪，避开实测首次重试节流。保存协调器仍在页面外，文本输入状态不进入 transition。相同默认 Release 的 30 次新进程，便签列表 P95 380.2→92.0ms，侧栏进入至新建可输入 168.8ms；各页 100 次预热无明显回退，字体/CSS 不变，JS 增 22 字节。见[调度与范围](../verification/2026-10-08-page-transition.md)。

便签、备份及目录选择的原生对话框绑定主窗口，共用 `NativeDialogScope` 门闸；实际回调持有到窗口结束，请求超时不提前释放。自动隐藏同时检查此作用域与所属前台弹窗，防止选择文件前提前保存仅标题草稿。文件定位使用 Shell PIDL 接口而非拼接 Explorer 参数；引用与便签删除均不修改外部文件。真实选择/定位、唯一门闸并发拒绝及 v3 桌面往返已部分通过，其他范围见[桌面补验](../verification/2026-10-07-file-backup-desktop.md)。

网站资料模块使用 `VaultPage`、`vaultStore` 和根组件 `VaultSession` 管理界面与锁定事件，Rust `vault.rs` 执行会话权限、加密记录 CRUD 和主密码轮换，`vault_crypto.rs` 提供 Argon2id、AES-256-GCM 与随机密码生成。SQLite 新增 `vault_config` / `vault_entries`，资料内容不进入剪贴板历史表。模块详情见 [网站资料功能说明](../features/website-vault.md)。

网站资料与随记共用 `components/SelectMenu.tsx`（`RecordGroupSelect` 仅包装分组数据），菜单经 portal 避免编辑容器裁剪，视口限制、滚动及键盘/焦点逻辑只维护一份。搜索共用 `SearchInput`，网站资料局部表单 CSS 排除搜索输入。`VaultPage` 按模式重建入场容器，不保留退场页面；锁定由既有 store/session 立即清空并卸载资料，未改原生命令、存储身份或权限边界。实现/浏览器检查见[样式同步验证](../verification/2026-10-10-vault-style.md)。

`backup.rs` 默认导出 v4 并读取 v0/v1/v2/v3，包含活动/归档随记、引用、来源、分组与常用状态；`note_backup.rs` 处理语义冲突与独立恢复来源去重，schema 3 新增 `note_import_origins`。API Key 可移植保护和密码箱主密码合并规则保留；全部导入对象共用事务。长度聚合预检、累计 JSON 预算和精确有界 writer 保持 100/74 MiB 上限；图片准备移出锁，提交前复核，见[加密备份与恢复](../features/encrypted-backup.md)。

主窗口和隐藏 `radial-menu` WebView 使用独立 HTML/TSX 入口，各有 JS 状态和图片队列；业务页与 CSS 按需加载，只挂载活动主页面。缩略图与完整预览分别有界，轮盘隐藏时不挂图片；每 WebView 的预算不能当作全应用预算。SQLite 维持单个 `Mutex<Connection>`，统一 WAL/FULL；部分旧同步命令仍需按实际热点改造。依赖闭包、体积与运行证据见 [优化方案](../features/performance-design.md)。

Windows 开发源码的 `single_instance.rs` 在 `wait_for_update_parent` 完成后、Tauri Builder 和数据库初始化前取得命名锁，以 `Local` 会话命名空间及用户 SID/identifier 摘要区分正式应用、不同用户和 QA；同 identifier 的安装版、便携版及不同版本共用锁。第二进程即使遇到首实例尚未初始化也不能继续建立托盘或读写存储。一个自动复位事件合并手动唤起，一个休眠线程转发到主线程且至多保留一个待执行回调，主窗口执行恢复/显示/聚焦而非 toggle；`--hidden` 不发信号。IPC 仅允许当前用户，保留系统完整性保护，失败直接终止本次启动。普通重启只在保存屏障、后台排空和敏感资料清理完成后释放锁，再执行已有 Tauri 主线程重启；更新/管理员新进程继续等待旧 PID 退出。异常退出由内核关闭句柄回收锁。当前为源码实现，桌面与跨权限验收边界见[单实例验证](../verification/2026-10-10-single-instance.md)。

### 已落地的第一批基础

`notes.rs` 提供独立数据层与异步命令，`notes`/`note_refs` 随 `user_version=2` 建表；正文/引用/摘要/revision 同事务，CAS 和幂等测试通过，列表无正文。便签后台最多接受 4 读/32 写任务，写待处理时新查询返回 busy；前端查询合并/代次与队列已接入。默认关闭的 diagnostics 分别记录排队、等锁、持锁和粗粒度 SQL 时间，不记录语句/参数；2,000 条便签并发保存已测，清理/备份联合压力仍待验。

启动与目标库共用 `db::initialize_connection`：WAL/FULL、8 MiB cache、外键和 5s busy timeout；schema 1/2/3/4/5/6 逐步事务迁移，持久连接核对 WAL 返回值。FULL 每 WAL 提交同步后确认，依赖系统/设备遵守 sync，真实断电未测。schema 4 的 `clipboard_usage`/`clipboard_assets` 由事务触发器维护内容字节、收藏与共享图片尺寸/引用；容量读取不扫描全库正文/文件，超限与 TTL 每批最多 100 条。图片创建/提交与回收协调，回收前写保留复核；缩略图解码在锁外，写回前检查引用，失败回收有界重试。统计是剪贴板逻辑预算，实测边界见[容量记录](../verification/2026-10-07-accounting-desktop.md)。

`storage.rs` 用一致源事务、目标联合提交及可校验暂存凭据替换了临时拒绝保护，源路由失败不切连接/epoch。设置、密码箱、随记/引用/恢复来源及分组/常用/颜色随迁移；剪贴板/应用图片保留原目录，目标原数据不覆盖。默认 Release 已通过普通目标冲突、目标提交后的源路由故障及期间编辑的重试、原目标设置/协议身份保持和多级路由重启；旧模块缓存与密码箱等桌面联合验收继续。见[事务测试](../verification/2026-10-07-backup-relocation.md)及[原生桌面补验](../verification/2026-10-07-file-backup-desktop.md)。

`maintenance.rs` 以单个专用线程/单调 deadline 调度周期 TTL：默认一小时，到期被 producer 暂停、待保存或 DB 竞争挡住时保留工作，不积累周期队列。SQL 失败退避 60 秒并保留到期工作；周期剪贴板/最近删除便签每批最多 100 条，批间释放 producer；保存排队时让出清理，已持锁事务不抢断。显式 diagnostics 的非正式标识才允许 QA 周期覆盖；普通构建/正式标识固定默认。诊断只记数值批次/队列/等锁/持锁/SQL，实际暂停与保护边界见[周期验证](../verification/2026-10-08-cleanup-profile.md#周期-ttl-的暂停重试与分项指标)。

### 实现与待验合同

用户在隔离成本/迁移/IPC 证据后明确批准 schema 5 便签搜索索引。普通 notes/ref 的 contentless trigram 候选与稳定映射由事务触发器维护，不索引密码箱/受保护 Key；最多 1,000 个候选，短于 3 个 Unicode 字符、NUL 或常见词超限回退原查询，最终保留字面 LIKE/状态/游标校验。schema 4→5 单事务回填，失败不留半套索引；派生表不进入备份/搬迁数据合同，目标库触发器随恢复重建。52,100 项隔离升级约 6.55–7.40 秒至原生可用、库增约 5.03%；旧 schema 4 应用拒绝打开升级库。默认全量 Rust 127 通过/3 基准忽略，完整默认 Release 的 50k 联合保存 P95 28.9ms、分页无漏重；普通保存索引成本和剩余联合验收仍分别记录，见[默认复验](../verification/2026-10-07-images-scale.md#完整默认配置索引复验)。

Windows 终止路径在统一保存确认、接受入口关闭、原生任务/DB 锁排空与密码箱/敏感剪贴板清理后，排到 Tauri 主线程执行终止：重启调用框架 restart；退出执行 cleanup_before_exit 后立即结束进程。避免原生 RequestExit 已受理但事件循环仍存活、前端停留 terminal busy 的实际故障。故障/超时取消不能进入终止路径；无效设置、失败稿、10s 超时/晚确认、隐藏联合保存及随后真实托盘退出已在默认 Release 复验，见[联合交接证据](../verification/2026-10-08-controlled-desktop.md#设置与便签联合交接发现)。

主窗可见性独立于网页 document.hidden 与焦点：原生主窗显隐成功后发送 main 目标事件，焦点/尺寸变化触发有界 visible/minimized 核对，旧核对响应不得覆盖新显隐事件。剪贴板查询/图片和便签摘要在原生隐藏时暂停，页面外保存仍继续；固定失焦窗口保持工作。实际 WebView2 隐藏差异、双窗口请求边界与剩余运行范围见[图片与压力证据](../verification/2026-10-07-images-scale.md)。

第九批补验：真实托盘退出保存 dirty 稿并实际结束进程。资产目录现跟随已打开 SQLite 连接，启动转发设置不用于回退库的图片路径；失败图片回收以随 epoch 失效的游标循环，每轮最多 100 项。近容量备份编码后释放快照、外层 payload 借用解析、读取按已预检文件长度有界预留，保留格式认证及事务合同；默认 Release 的原生/进程树内存对照见[本批证据](../verification/2026-10-07-capacity-exit.md)。

- **便签独立生命周期**：`NotesPage`/`notesWorkspace`/`NoteCoordinator`/`notes.rs` 使用 `notes`/`note_refs`，不进入剪贴板清理集合。编辑只订阅当前草稿，正文/引用/摘要/revision 同事务，摘要分页与全文接口分开；请求幂等和 CAS 冲突保留草稿。详细接口见 [便签设计](../features/notes-design.md)。
- **页面之外的保存协调器**：首次使用便签后激活，属于主 WebView；切页/隐藏不销毁待保存稿。退出/重启/备份/迁移走保存屏障，协调设置队列与后台写入者；失败或超时取消交接，不能视为已保存。
- **存储身份**：统一连接配置/版本迁移并维护后端 `storage_epoch`；旧响应/事件/写入不能跨连接切换污染状态。切换成功更新身份并刷新干净缓存，失败恢复原连接/身份和暂停的生产者。
  - 剪贴板/短语/设置/标签/快捷键以及密码箱实际变更入口通过 invokeStorage 绑定交付前身份，原生取得生产者/异步接受许可后检查 expectedStorageEpoch；清理确认绑定预览时身份，不能在新目标执行旧确认。密码箱私密读取在延长活动前检查，主密码在提前拒绝时仍以 Zeroizing 清理。
  - 普通复制/粘贴六入口强制 expectedStorageEpoch，所有前端复制/粘贴使用身份封装，异步全文读取前捕获身份。实际 blocking worker 的接受许可覆盖解码、剪贴板事务、焦点恢复与最终按键释放，忙/失败不返回成功；退出/备份/迁移排空它们。worker 完成只确认原生操作与按键发送，并无外部目标插入确认协议；修复前连续卡片点击曾复现空文本；现普通粘贴恢复目标后稳定等待 100ms、发送 V 前最多等待剪贴板可用 200ms，同时核验序列/焦点/修饰键，失败不发 V 且释放 Ctrl。失败固定事件由 worker 许可标记存储身份，主窗仅接受当前事件并提示重试，身份切换清除。检查与外部读取仍有竞态，不无条件重发，也不用 IPC 成功代替目标内容验收，见[后继证据与边界](../verification/2026-10-08-closeout.md#粘贴等待与失败提示收尾)。托盘动作由同一 DB 锁取得行与 epoch，旧 ID 不能重解释为新库记录，复制图片缓存按 epoch 清理。默认旧复制真实竞态与排空、lease 拒绝已验，托盘焦点补查见[证据](../verification/2026-10-08-copy-handoff.md)。
  - 翻译也绑定交付前身份；引擎设置、缓存和两类供应商配置在各自 DB 锁内检查同一 epoch，避免段间切换后读取新目标 Key。网络返回仍核对旧 epoch 后才写历史；36 命令拒绝矩阵及真实本机 HTTP 跨目录/新请求/缓存已在默认 Release 复验。
  - 密码箱锁定事件也携带来源身份，来源在会话操作时捕获；后台超时循环参与生产者屏障。前端拒绝旧锁定事件，活动/复制剪切/自动锁定设置及填入错误回调不得影响新会话。默认 Release 旧锁定和活动错误跨实际迁移、当前锁定，以及不同主密码合并/旋转均已复验，见[会话证据](../verification/2026-10-08-vault-phrase-regression.md#密码箱旧请求与会话事件补查)。
  - 剪贴板完整正文与受保护 Key 的显式读取携带 expectedStorageEpoch，原生锁内校验；前端在身份取得、读取返回和粘贴发起前检查 generation。旧全文不能在迁移后交给展开/复制/粘贴调用者，当前全文权限与完整内容保留。
  - 剪贴板删除/收藏/备注的成功确认也捕获独立存储 generation；迁移后的旧确认不得删除目标同 ID 记录/图片缓存或覆盖其收藏/备注。事件身份与响应代次各自校验，真实两类竞态分别复验。
  - 剪贴板变更/刷新/未读、短语组与 Key 提示事件采用 `{storage_epoch,value}`，生产者或排他交接存续期间标记身份；前端拒绝旧或无身份事件，切换清除旧提示。未读初读和清零确认也核验身份，避免旧结果覆盖新目录。真实同 ID 旧收藏事件已复现并修复，见[竞态证据](../verification/2026-10-08-vault-phrase-regression.md#剪贴板旧事件的真实发现)。
- **有界后台执行**：便签和确认的重命令避开主线程，查询合并、队列有界，保存与搜索/维护有明确调度规则。保持单连接起步，先缩短锁；备份图片解码/准备文件移到锁外，提交前复核身份/冲突，不用连接池掩盖锁内重工作。
- **备份与恢复**：v4 纳入随记分组与常用，保留 v3 便签和更旧版本兼容及原子导入；恢复副本重新分配便签/引用/创建请求身份。保留容量上限，预检与读取/序列化有界，测拒绝路径内存，不先加载超大集合。
- **双入口与页面按需加载**：主窗/轮盘拆分，纯 UI/CSS 延迟加载，权限/会话与更新检查语义保留；隐藏轮盘暂停图片和无效列表工作。依赖图、首次切页和总 chunks 都需验收。

S 项只交付一次；N 的可靠性与自身有界运行必需，O 中其他旧模块改造按证据推进，不把整套全应用重构设为便签前置。

```Markdown
┌─────────────────────────────────────────────────────┐
│                  Copy Creator                        │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────────────┐                           │
│  │    React 前端         │  ← TypeScript + 纯 CSS    │
│  │  ┌────┬────┬────┬──┐ │                           │
│  │  │剪切│短语│翻译│设置│ │                           │
│  │  │板页│页  │页  │页 │ │                           │
│  │  └────┴────┴────┴──┘ │                           │
│  │  ┌──────────────────┐ │                           │
│  │  │ Zustand Store    │ │  ← 前端状态               │
│  │  └──────────────────┘ │                           │
│  └──────────┬───────────┘                           │
│             │ invoke / event                          │
│  ┌──────────▼───────────┐                           │
│  │    Tauri 桥接层       │  ← IPC (Tauri Commands)    │
│  └──────────┬───────────┘                           │
│             │                                         │
│  ┌──────────▼───────────┐                           │
│  │    Rust 后端          │                           │
│  │  ┌──────────────────┐ │                           │
│  │  │ 剪切板监听模块    │ │  ← 系统剪切板 Hook         │
│  │  │ 系统托盘模块      │ │  ← 托盘图标与右键菜单      │
│  │  │ 全局快捷键模块    │ │  ← 唤起/隐藏悬浮窗         │
│  │  │ 数据库模块        │ │  ← SQLite CRUD            │
│  │  │ 翻译服务模块      │ │  ← HTTP 客户端            │
│  │  │ 粘贴执行模块      │ │  ← 模拟键盘输入            │
│  │  └──────────────────┘ │                           │
│  └──────────┬───────────┘                           │
│             │                                         │
│  ┌──────────▼───────────┐                           │
│  │    SQLite 本地数据库   │                           │
│  └──────────────────────┘                           │
│                                                      │
└─────────────────────────────────────────────────────┘
```

## 3. 模块详设

### 3.1 Rust 后端模块

#### 剪切板监听模块 `clipboard_monitor`

事件唤醒在完整默认 Release 同前端/合成库中将 60 次普通文本提交事件 P95 从 761ms 降至 36ms，最大 87ms；私密复制及实际备份排他暂停/恢复通过。后台暂停时事件不得绕过生产者门闸，恢复后 watchdog 补读另报。保留 1.6 秒启动抑制，未声称空闲 CPU 或图片/文件延迟达标，见[延迟与交接证据](../verification/2026-10-08-clipboard-events.md)。

```
职责:
  - 启动时开始监听系统剪切板变化
  - 检测文本/图片类型变化
  - 写入 clipboard_records 表
  - 通过 Tauri Event 推送新记录到前端

技术:
  - Windows: Windows Clipboard API
  - macOS: NSPasteboard
  - 通过 Tauri event system 向前端推送

频率:
  - Windows: WM_CLIPBOARDUPDATE → 容量 1 唤醒队列 → 原单 worker；800ms watchdog/失败回退
  - 先取得生命周期生产者许可，再比较序列号；无变化/私密序列跳过读取，复制事务与文本快照互斥
  - 写入去重: 连续相同内容不重复记录
```

#### 系统托盘模块 `tray_manager`

```
职责:
  - 创建托盘图标（亮/暗色跟随主题）
  - 右键菜单: 显示窗口 / 退出
  - 单击托盘图标: 显示/隐藏悬浮窗
```

#### 全局快捷键模块 `shortcut_manager`

```
职责:
  - 注册全局快捷键
  - 用户可在设置中自定义快捷键组合
  - 按下快捷键 → 切换悬浮窗显示/隐藏

默认快捷键: Alt + Shift + V
```

#### 数据库模块 `db`

```
职责:
  - SQLite 初始化与迁移
  - 各表 CRUD 操作
  - 过期数据定时清理（每小时检查一次）

表:
  - clipboard_records
  - phrase_groups
  - phrases
  - translation_history
  - settings
  - 后续扩展: api_key_labels、vault_config / vault_entries 已实现；notes / note_refs 待实现

数据库路径:
  - Windows: %APPDATA%/copy-creator/data.db
  - macOS:   ~/Library/Application Support/copy-creator/data.db
```

#### 翻译服务模块 `translator`

```
职责:
  - 调用 AI 翻译（用户配置的 OpenAI 兼容 API）
  - 调用内置免费翻译（百度翻译 / 有道翻译）
  - 翻译结果缓存（同文本+同语言+同引擎命中即返回）

接口封装:
  trait Translator {
    async fn translate(text: &str, source_lang: &str, target_lang: &str) -> Result<String>;
  }

  impl AITranslator    // OpenAI 兼容 API
  impl BuiltinTranslator // 百度/有道免费 API
```

#### 粘贴执行模块 `paste_executor`

Windows 原生层查询已捕获目标进程与本进程的提升令牌；确认「本进程未提升、目标已提升」时，在隐藏窗口和注入按键前拒绝。普通内容已复制，返回 `clipboard.pasteRequiresElevation`，通过带存储身份的固定原因事件显示主窗提示；私密填入则在复制资料前返回 `vault.pasteRequiresElevation`。令牌查询失败不冒称权限不对等。提示提供用户主动点击的管理员重启入口，主窗命令复用统一保存屏障及后端排空，随后 `ShellExecuteExW(runas)` 请求 UAC；新进程使用同一 EXE 并等待旧进程退出后再打开数据库/注册系统集成。UAC 取消或启动失败恢复原应用，锁定后的密码箱不自动解锁；不改启动权限默认值，也不自动重放粘贴。实测与剩余 UAC 验收见[终端权限记录](../verification/2026-10-09-terminal-permissions.md)。

```
职责:
  - 将文本写入剪切板
  - 模拟 Ctrl+V / Cmd+V 粘贴操作
  - Phase 2: 终端特殊适配
```

### 3.2 React 前端模块

```
src/
├── main.tsx                        # 入口
├── App.tsx                         # 主窗口布局 + 面板路由（React state）
├── components/                     # 通用组件
│   ├── GlassIcons.tsx              # 玻璃拟态图标按钮栏（左侧导航）
│   ├── GlassIcons.css              # 按钮栏样式（3D 玻璃拟态效果）
│   ├── Icons.tsx                   # 自定义 SVG 图标集（SF Symbols 风格）
│   ├── SearchInput.tsx             # 搜索输入组件
│   ├── IosSelect.tsx               # iOS 风格选择组件
│   ├── SettingsContent.tsx         # 设置表单主组件
│   ├── SettingsDialog.tsx          # 设置弹窗模式
│   └── settings/                   # 设置子组件
│       ├── index.ts                # 导出文件
│       ├── LanguageSection.tsx     # 语言设置（语言切换 + 快捷键录制 + 剪切板保留时长）
│       ├── StorageSection.tsx      # 存储设置（存储位置显示 + 自定义文件夹选择）
│       └── TranslationSection.tsx  # 翻译引擎设置（百度/Google/AI 配置）
├── pages/                          # 页面组件
│   ├── ClipboardPage/              # 剪切板页
│   │   ├── index.tsx               # 主组件（搜索 + 分类筛选 + 列表）
│   │   ├── ImageThumb.tsx          # 图片缩略图组件（支持悬浮预览）
│   │   └── utils.tsx               # 剪切板类型工具（分类图标 + 预览组件）
│   ├── PhrasePage/                 # 快捷短语页
│   │   ├── index.tsx               # 主组件（搜索 + 场景组 + 短语列表）
│   │   ├── GroupChips.tsx          # 场景组标签组件
│   │   ├── GroupDialog.tsx         # 新建/编辑场景组弹窗
│   │   ├── PhraseList.tsx          # 短语列表组件
│   │   ├── PhraseDialog.tsx        # 新建/编辑短语弹窗
│   │   └── ManageGroupsDialog.tsx  # 管理场景组弹窗
│   └── TranslationPage.tsx         # 翻译页（输入 + 结果展示）
├── stores/                         # Zustand 状态管理
│   ├── clipboardStore.ts           # 剪切板状态
│   ├── phraseStore.ts              # 快捷短语状态
│   ├── translationStore.ts         # 翻译状态
│   └── settingsStore.ts            # 设置状态
├── styles/                         # CSS 模块化样式
│   ├── index.css                   # 主入口（导入所有模块）
│   ├── base.css                    # 基础样式 + CSS 变量（主题色 + 动画）
│   ├── layout.css                  # 布局样式（容器 + 侧边栏 + 面板）
│   ├── components.css              # 通用组件样式（弹窗 + 按钮 + 表单）
│   ├── clipboard.css               # 剪切板页面样式
│   ├── phrases.css                 # 快捷短语页面样式
│   ├── translation.css             # 翻译页面样式
│   └── settings.css                # 设置页面样式
├── utils/
│   └── paste.ts                    # 粘贴操作工具函数
├── i18n/                           # 国际化
│   ├── index.ts
│   ├── zh-CN.json
│   └── en.json
└── types/
    └── index.ts                    # 公共类型定义
```

## 4. 数据流

### 4.1 剪切板记录流程

```
用户 Ctrl+C 复制文本
  → 系统剪切板更新
  → Rust 剪切板监听器检测到变化
  → 去重判断（与上一条相同则跳过）
  → 写入 SQLite clipboard_records 表
  → 通过 Tauri Event 推送到前端
  → React 通过 useTauriEvent 接收
  → Zustand store 更新
  → 列表 UI 重渲染
```

### 4.2 粘贴短语/剪切板记录流程

```
用户点击列表条目
  → 前端调用 Tauri Command: paste(text)
  → Rust 将文本写入系统剪切板
  → Rust 模拟 Ctrl+V / Cmd+V
  → 文本粘贴到当前光标位置
  → 悬浮窗自动隐藏（可配置）
```

### 4.3 翻译流程

```
用户粘贴文本到输入框 → 点击翻译按钮
  → 前端调用 Tauri Command: translate(text, target_lang)
  → Rust 读取 settings 判断默认引擎
  → Rust 调用对应的翻译服务
    ├─ AI 翻译: POST 用户配置的 API 端点
    └─ 内置翻译: POST 百度/有道免费 API
  → 翻译结果写入 translation_history（缓存）
  → 返回结果到前端
  → React 显示翻译结果
```

## 5. 窗口架构

```
当前窗口设计:
  - 无边框透明窗口（decorations: false, transparent: true）
  - 主窗口默认 520×600，最小 440×420；左侧可调整宽度的导航，右侧活动页面
  - 主页面通过 React state 切换（clipboard / phrases / translate / vault / settings）
  - 剪贴板保持主入口依赖，其余主业务页按需加载，仅活动页面挂载
  - 启动时创建隐藏 radial-menu WebView，使用 radial.html / src/radial.tsx 独立入口
  - 两个 WebView 各自拥有前端 store、图片缓存和队列，不共享 JS 内存
  - 窗口支持拖拽调整尺寸（resizable: true）
  - 置顶模式通过 toggle_always_on_top 命令切换
  - 未固定主窗可在约 250ms 失焦交接后隐藏；关闭请求转为隐藏，程序驻留托盘

后续便签/优化:
  - 便签复用主窗，不增加常驻 WebView；导航和捕获不依赖瞬时事件碰巧被收到
  - 入口分包与隐藏轮盘运行优化分别验收，分包不自动停止已经挂载的工作
  - 隐藏/最小化/退出/重启/迁移接入保存协调，不依赖页面 cleanup 发异步请求
```

## 6. 构建与打包

| 目标         | 工具                   | 命令                 |
| ---------- | -------------------- | ------------------ |
| 开发调试       | Vite + Tauri CLI     | `pnpm tauri dev`   |
| Windows 打包 | Tauri Bundler → .msi | `pnpm tauri build` |
| macOS 打包   | Tauri Bundler → .dmg | `pnpm tauri build` |
| 检查与签名更新 | 自定义 Tauri commands、reqwest、minisign-verify、Windows Installer | GitHub Latest 的公开元数据，两种运行模式均下载签名 MSI，统一保存后调用系统 msiexec；原生按 MSI 语法只引用属性值，以 raw_arg 传入并拒绝命令分隔符，避免 CRT 整体引用。安装版保留目录并显示进度，便携版首次显示向导；主窗口共享新版红点。0.2.28/0.2.29 仍含旧引号缺陷，修复已随 0.3.0 发行，实际安装验收待补；见 [更新说明](../features/updates.md) |

体积按前端发布内容、Rust Release EXE、便携包/安装包分别报告。当前前端构建与发布集合实验见 [优化方案 §2](../features/performance-design.md)；现用 5 个字体保留，37 个未引用字体已移至 `assets-source/fonts/`，前端产物减少 51,515,212 字节。WOFF2 与 strip/LTO/依赖 features 按真实产物和视觉/性能回归决定。构建成功不能替代运行测量；尚未改变 Cargo release profile/Vite 分包配置。

## 7. 项目目录结构

```
copy-creator/
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── main.rs
│   │   ├── lib.rs              # Tauri 命令注册
│   │   ├── clipboard.rs        # 剪切板监听
│   │   ├── tray.rs             # 系统托盘
│   │   ├── shortcut.rs         # 全局快捷键
│   │   ├── db.rs               # 数据库
│   │   ├── translator.rs       # 翻译服务
│   │   └── paste.rs            # 粘贴执行
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                        # React 前端
│   ├── components/             # 通用组件
│   │   └── settings/           # 设置子组件
│   ├── pages/                  # 页面组件
│   │   ├── ClipboardPage/      # 剪切板页
│   │   └── PhrasePage/         # 快捷短语页
│   ├── stores/                 # Zustand 状态管理
│   ├── styles/                 # CSS 模块化样式
│   ├── utils/                  # 工具函数
│   ├── i18n/                   # 国际化
│   └── types/                  # 类型定义
├── docs/                       # 项目文档
│   ├── PRD.md                  # 产品需求文档
│   ├── ARCHITECTURE.md         # 产品架构文档
│   └── project_process.md      # 开发日志
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
└── tsconfig.json
```

