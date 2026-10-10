# Copy Creator 代码修复清单（2026-10-10，第五版）

> **继续修复复核**：P1-1 已按用户方案 A 接入随记摘要/详情与主窗保存握手；P1-2 已补原生 text/link 和 16 KiB 原文校验。P2-16 的“每次显示累积监听”推断不成立，实际迟到注册泄漏已修。P3 本轮仅处理轮盘残留、剪贴板卡片文案/删除名称。前端 104、Rust 178 通过/5 忽略；12 类临时反向回退均变红并恢复。其余项未批量关闭，桌面待验收。证据见[继续修复验证](../verification/2026-10-10-radial-notes-and-key.md)，任务状态仅见 [TODO](../TODO.md)。

> **接手复核（2026-10-10，基线 `0746faa`）**：第五版及以下统计保留为历史证据；相关源码已进入本地提交，不能继续据“未提交”推断当前状态。本轮修复了遗留分组代次补丁的 `NoteError`/`String` 编译错误，补齐 `back()` 对新导航代次的校验，以及 P2-19 的目标颜色元数据冲突检查。P1-7 的原竞态推断不成立：命令完整持有 producer 读许可，迁移先排空 producer，不能在校验与取锁之间切库；锁内复核与真实 epoch 回包作为一致性加固保留。P2-19 原文“覆盖颜色行”亦需纠正：同 ID 的普通 INSERT 会触发约束错误并事务回滚；真正缺口是未在准入阶段拒绝已有颜色元数据，不同 ID 时还会接受并合入非空目标。当前结果、复现与后续顺序见[接手复核记录](../verification/2026-10-10-agent-handoff.md)与 [TODO](../TODO.md)。

> 本清单是一次**只读代码评审**的产出：逐条列出当前工作区（`HEAD 8fd2bd1`，含 52 个已修改文件与 20 个未跟踪条目）中已核实的缺陷、风险与清理项，并给出可直接定位的文件与行号。
>
> **第五版说明**：按用户指示「开始修吧」，本轮**实际落地了 P1-5 与 P1-6 三处代码修改**（§3 内均标为「已修复（2026-10-10）」），并新增 `copy-creator/tests/recordStateActions.test.ts`（3 例）。**两条修复都做了反向验证**（把实现改回缺陷写法必须让新测试变红），其中反向验证推翻并修正了本清单第四版对 P1-6 的问题描述——详见 P1-6 的「第四版描述修正」行。修复后：前端 **87 passed / 0 failed**、`tsc -b --force` exit 0、`eslint .` exit 0、`vite build` 成功 599ms、`scripts/qa-process-isolation.ps1` exit 0。**未提交、未推送、未打包、未发布。**
>
> **第四版说明**：本轮按用户要求「再次查看项目代码」，派发两个只读子代理（前端、后端）逐条复核，并由本人在其基础上**独立重测全部行号**（子代理所报行号多处偏移已修正，另修正/推翻其若干结论，见 §6.4）。**全部行号已按本轮工作区重新锚定**（P0-1 修复插入行导致 `db.rs` 全面下移，旧版行号已失效，映射见下表）。新增条目集中在：**P1-5/P1-6（随记状态机真实回归）**、**P1-7（`get_suiji_groups` 回显请求 epoch）**、**P2-16…P2-19**。
>
> **第三版说明**：按用户确认的范围，**已修复 P0-1 与 P1-4 两类 UTF-8 字节切片 panic**（§2、§3 内标为「已修复」的条目）。修复只改字符切分方式，未改动 `is_api_key` 的检测语义（用户明确选择不做该独立行为变更）。其余条目仍为待办。
>
> **第二版说明**：第一版发布后，用户逐条复核并指出若干条目的描述、严重度或影响推断不成立。第二版按该反馈重写：**核对属实且需修复的条目保留并修正细节**，**描述有误的条目改写为经核实的真实问题**，**不成立的条目移入 §6 并注明原因**，**已过时的条目删除**。所有结论均以 2026-10-10 的工作区源码为准，并重新实跑验证命令。
>
> 本文件登记问题、建议与**已完成的修复**；任务状态仍以 [TODO](../TODO.md) 为唯一清单。行号以评审时点的工作区内容为准，修改后需重新核对（`docs/prompts/open_issues_prompt.md` 中的旧行号已失效，见 §6）。

## 1. 评审基线与方法

| 项目 | 内容 |
| --- | --- |
| 代码基线 | `HEAD 8fd2bd1`（docs: record 0.2.28 MSI update release），工作区 **52 个已修改文件**（1245 insertions / 604 deletions）+ **20 个未跟踪条目**（`single_instance.rs`、`suiji.rs`、`SelectMenu.tsx`、`recordColors.ts`、`suiji.ts`、`useRecordGroups.ts`、`GroupManager.tsx`、`RecordGroupSelect.tsx`、`RecordMenu.tsx`、`RecordPreview.tsx`、`SuijiPage.tsx`、`context-menu.css`、`suiji.css`、`docs/reviews/`、`docs/verification/2026-10-10-*.md` 四份、`output/`、`previews/`） |
| 评审范围 | `copy-creator/src/`（前端全部源码与测试）、`copy-creator/src-tauri/src/`（全部 Rust 模块）、`copy-creator/tests/`、相关文档 |
| 方法 | 逐文件通读 + 全仓 grep 交叉验证 + 独立最小程序复现；第四版另派两个只读子代理交叉复核，并由本人逐条重测行号 |
| 未执行 | 真实桌面交互验收、200% DPI、MSI 安装/升级/卸载、UAC 端到端（这些属于 TODO 中的待验证项，不在本清单范围） |

本版评审时点的检查结果（供修复后对照）：

| 检查 | 命令 | 评审时点 | 修复 P0-1/P1-4 后（第四版复测） | 修复 P1-5/P1-6 后（第五版复测） |
| --- | --- | --- | --- | --- |
| 前端单元测试 | `node --experimental-strip-types --test tests/*.test.ts`（在 `copy-creator/`） | **84 passed / 0 failed**（10 个测试文件） | **84 passed / 0 failed** | **87 passed / 0 failed**（11 个测试文件，含新增 `recordStateActions.test.ts` 3 例） |
| Rust 单元测试 | `cargo test --manifest-path src-tauri/Cargo.toml` | **166 passed / 0 failed / 5 ignored** | **173 passed / 0 failed / 5 ignored**（`running 178 tests`，新增 7 例） | 未重跑（本轮只改前端 TS；历史口径 173/5） |
| 类型检查 | `tsc -b --force` | exit 0 | exit 0 | exit 0 |
| Lint | `eslint .` | exit 0 | exit 0 | exit 0 |
| 生产构建 | `vite build` | 成功 743ms | 未重跑（本次只改 Rust） | 成功 599ms（`PhrasePage-*.js` 290.34 kB、`clipboardStore-*.js` 185.24 kB、`main-*.js` 61.82 kB、`notes-*.js` 13.53 kB） |
| 进程隔离 | `scripts/qa-process-isolation.ps1` | — | — | exit 0，`ownedQaNativeProcesses: 0` |

> **工具链注意（第五版实测）**：本机 `pnpm` shim 当前不可用（`[pnpm] pnpm not found.`）——`C:\Users\ABD18\AppData\Local\deepseek-harness\bin\pnpm.ps1` 的回退路径指向 `%APPDATA%\dsh-tauri\dependencies\pnpm\bin\pnpm.cjs`，该文件不存在，且 `$env:DSH_PNPM_BIN` 未设置。上文表格改用等价的直接命令（`node --experimental-strip-types --test`、`node_modules\.bin\tsc.CMD`、`node_modules\.bin\eslint.CMD`、`node_modules\.bin\vite.CMD`）。

> **行号映射（第三版 → 第四版）**：P0-1 `db.rs:40-47`→`:43-53`、调用点 `:189/:211/:2040`→`:195/:217/:2046`；P1-2 `:2393-2411`→`:2400-2417`；P1-1 `:1493/:1507`→`:1499/:1513`、`db.rs:706`→`:710`；P2-5 `:107-112`→`:113-118`；P2-6 `:1921-1949`→`:1927-1954`、锁区 `:1930-1945`→`:1936-1951`；P2-7 `clipboard.rs:991-1028` 不变（锁区 `:1005-1028`、lock `:1007` 不变）；P2-8 `:1717-1740`→`:1724-1747`、`:1742-1745`→`:1749-1752`、`:1955-1958`→`:1962-1965`；P2-9 `:1448-1463`→`:1455-1469`、`:1457/:1458`→`:1463/:1464`；P2-10 `db.rs:706`→`:710`、`:663`→`:669`、`:704-709`→`:710-715`；P2-12 `:222/:267/:274`→`:228/:273/:280`；P2-13 async 属性 `:1001/:1305/:1717/:1742/:1955`→`:1007/:1311/:1723/:1748/:1961`、`change_storage_directory` `:1907/:1909`→`:1913/:1915`；P2-15 `:40-47/:12-22/:49-69`→`:43-53/:12-22/:55-75`（apikey 分支 `:63-65`→`:69-72`）；§5.1 `settingsStore.ts:126-128` 与 `db.rs:1849`→`:1855`；§5.4 `NotesPage/index.tsx:37/:47` 不变、默认导出 `:163`→`:170`。

### 严重度定义

| 级别 | 含义 |
| --- | --- |
| **P0** | 用户可正常触发，造成进程/命令崩溃、数据损坏或敏感信息泄露 |
| **P1** | 特定路径可触发，造成功能失效、数据被错误处理或安全边界被削弱 |
| **P2** | 可靠性、资源或一致性问题：可能造成重复处理、状态错乱、锁内重工作或难以察觉的行为偏差 |
| **P3** | 死代码、文案、可访问性、命名与文档一致性等清理项，不影响正确性 |

---

## 2. P0 — 崩溃级

### P0-1 粘贴或手动标记含中文的 `sk-` 开头文本会导致 panic，且发生在持有连接锁的查询路径上 —— **已修复（2026-10-10）**

| 项目 | 内容 |
| --- | --- |
| 状态 | **已修复**。`make_key_preview` 改为按字符计数与切分，`is_api_key` 的检测语义未改动（见「实际修复」）。 |
| 位置 | `copy-creator/src-tauri/src/db.rs:43-53`（`make_key_preview`），判定函数 `copy-creator/src-tauri/src/db.rs:12-22`（`is_api_key`） |
| 调用点 | `copy-creator/src-tauri/src/db.rs:195`、`copy-creator/src-tauri/src/db.rs:217`（均在 `clipboard_record_json`，`db.rs:182-222` 内）；`copy-creator/src-tauri/src/db.rs:2046`（`check_api_key`，定义 `:2043`）；`copy-creator/src-tauri/src/clipboard.rs:1065`（采集时发 `api-key-detected` 事件）；`copy-creator/src-tauri/src/tray.rs:30`（托盘菜单标题，`record.user_api_key` 同样计入） |
| 问题 | `db.rs:43-53` 原先使用**字节切片**：`format!("{}...{}", &c[..8], &c[c.len() - 4..])`（`c.len()` 是字节长度）。**两条触发路径**：<br>① **自动识别**——`is_api_key`（`db.rs:14`）按**字节**判定 `content.len() < 20 \|\| content.len() > 200`，`db.rs:17` 只排除 `\n` 与 ASCII 空格，不排除中文，于是「`sk-` + 6 个汉字」= 21 字节被判为 Key，随后在 `&c[..8]` 处切开字符边界；<br>② **手动标记**——`set_user_api_key`（`db.rs:2400`）把任意记录标为 Key 后，`clipboard_record_json`（`db.rs:217`）同样对该内容调用 `make_key_preview`，**与 `is_api_key` 的判定无关**。故只给自动检测加 ASCII 限制并不足以修好本条。 |
| 影响 | panic。`db.rs:1008` `get_clipboard_records` → `db.rs:1018` `state.conn.lock()` → `db.rs:1020` `query_clipboard_records` → `db.rs:1030` `stmt.query_map(..., clipboard_record_json)` 的守卫存活期内 panic，会**毒化 `Mutex<Connection>`**，之后所有需要该锁的命令全部失败，需重启应用。 |
| 复现证据 | 用 `rustc --edition 2021 -O` 编译独立最小程序（1:1 复刻 `is_api_key` + `make_key_preview`），两条路径分别复现：<br>① 自动识别：输入 `"sk-" + "一二三四五六"` → `bytes=21 is_api_key=true`，随后 `panicked at ...: end byte index 8 is not a char boundary; it is inside '二' (bytes 6..9 of string)`；<br>② 手动标记：断言 `is_api_key(s)` 通过后直接调用 `make_key_preview(s)`，同样 panic 于 `end byte index 8 is not a char boundary`。 |
| 实际修复 | 只改 `make_key_preview` 内部（现为 `db.rs:43-53`），在函数内做字符安全切分，**一次覆盖全部 5 个调用点**：<br>`let char_count = c.chars().count();`（`:45`） → `if char_count >= 12 { let head: String = c.chars().take(8).collect(); let tail: String = c.chars().skip(char_count - 4).collect(); format!("{}...{}", head, tail) } else { c.to_string() }`<br>**未改动** `is_api_key`——收紧为 ASCII 是独立的行为变更（会改变以 `sk-` 开头的中文串是否被 DPAPI 加密、是否显示 API Key、是否被便签采集拒绝），且对修 panic 无贡献（只能覆盖 2 个调用点），经用户确认不做。 |
| 新增测试 | `copy-creator/src-tauri/src/db.rs` 的 `mod tests`（`:2420`）新增 3 例：`key_preview_never_splits_a_multibyte_character`（`:3077`，21 字节 / 9 字符的中文样本 + 14 字符长样本）、`key_preview_keeps_ascii_behaviour_byte_identical`（`:3094`，7 个 ASCII 样本，含 11/12 字符边界、空串、两端空白、真实 Key 格式）、`key_preview_handles_emoji_and_wide_characters`（`:3108`，12 个 emoji、12 与 11 个汉字）。 |
| 修复验证 | ① 正常跑：**173 passed / 0 failed / 5 ignored**（原 166，新增 7 例）。② **反向验证**：临时把实现改回字节切片，`key_preview_never_splits_a_multibyte_character` 与 `key_preview_handles_emoji_and_wide_characters` 立刻 FAILED 并复现 `end byte index 8 is not a char boundary; it is inside '二'`，而 ASCII 回归用例仍 ok——证明测试确实拦得住该缺陷。③ ASCII 行为逐字节不变。 |
| 已知可见变化 | 非 ASCII 预览按字符对齐 ASCII 语义，故会变长：12 个 emoji 由旧实现的 `"🔑🔑...🔑"`（2 个头 + 1 个尾字符）变为 8 个头 + 4 个尾字符。ASCII 完全不变。 |

---

## 3. P1 — 功能失效与安全边界

### P1-1 升级后轮盘「短语」为空 —— 已修复代码，桌面待验收

| 项目 | 内容 |
| --- | --- |
| 修复前问题 | schema 6 把 phrases 提升为 notes 并清空，轮盘仍经 phraseStore/get_phrases 读取，所以升级与新建随记不可见。phrase_groups 继续是 live 表，不能删。 |
| 当前位置 | `copy-creator/src/components/RadialMenu/index.tsx:20`、`src/lib/radialNotes.ts:38`、`src/lib/radialNoteFlush.ts:8`、`src/App.tsx:114`（后三个路径亦位于内层 copy-creator/）。 |
| 实际修复 | 方案 A：get_suiji_groups/list_suiji/get_note，全部/未分组/自建组，50 条分页、2000 摘要上限；轮盘保持只读，不引入独立编辑 coordinator。保存握手由主窗既有 saveBarrier 执行，匹配请求/代次、11 秒总上限，失败不粘贴；成功读最新全文，通过 invokeStorage 原生粘贴。记录/存储变化拒绝旧响应，按当前分类分派并阻止重复在途手势。 |
| 验证 | 真实内存库旧短语提升→分组/未分组查询；真实 TSX 的 VM 接线、保存顺序/错误、分页上限、代次、文件引用及监听清理。旧数据源和整份旧组件回退均变红，保存/回执/在途守卫分别反向验证。轮盘静态 JS 闭包仅增 3258 B（0.98%）。完整证据与桌面缺口见[本轮记录](../verification/2026-10-10-radial-notes-and-key.md)。 |
| 边界 | phraseStore 的兼容测试与旧命令/死文件暂保留，不再用于轮盘。原文关联的“每次显示重复注册”推断不成立，见 P2-16 的纠正。 |

### P1-2 `set_user_api_key` 缺原生类型与长度校验 —— 已修复

| 项目 | 内容 |
| --- | --- |
| 位置 | `copy-creator/src-tauri/src/db.rs:2400` 命令，`:2413` 校验 helper；前端 `copy-creator/src/pages/ClipboardPage/ClipboardCard.tsx:209` 显示失败。 |
| 修复前问题 | 正常界面只给 text 入口，但原生命令可把 image/file/explorer 的路径加密后写回，且没有手动标记长度预算。 |
| 实际修复 | 限 text/link，16 KiB UTF-8 原文；显式 invalidRecordType/apiKeyTooLong/recordNotFound/updateFailed 错误码。先限制受保护密文规模，再 reveal 校验原文；重复保护与旧超长文本取消标记保持。没有套用 is_api_key 的 200 字节启发式，没有降低 DPAPI 保护。 |
| 验证 | 3 项 Rust 测试覆盖非法类型不变、长文本/link/密文重试、ASCII/多字节超长拒绝及允许取消；回退类型/长度判断后 2 项失败、1 项通过。前端实际 handler 测试覆盖原生错误可见与异常细节隐藏。真实菜单与桌面验收另补。 |

### P1-4 翻译错误信息使用字节切片，响应含中文时 panic —— **已修复（2026-10-10）**

| 项目 | 内容 |
| --- | --- |
| 状态 | **已修复**。新增 `truncate_chars` helper 并替换三处调用。 |
| 位置 | `copy-creator/src-tauri/src/translator.rs:142` `&body_text[..body_text.len().min(80)]`；`copy-creator/src-tauri/src/translator.rs:211` `&body[..body.len().min(80)]`；`copy-creator/src-tauri/src/translator.rs:245` `&msg[..msg.len().min(80)]`（行号为修复前） |
| 问题 | 与 P0-1 同类：`min(80)` 是字节数，HTTP 错误响应体或错误消息含多字节字符时会切开字符边界。**触发条件**：响应长度需超过截断位置，且第 80 字节不是字符边界——并非所有中文响应都会触发（30 个汉字 = 90 字节，第 80 字节落在字符内部，构成稳定复现样本）。 |
| 复现证据 | 独立最小程序对 `"一".repeat(30)` 调用 `&s[..s.len().min(80)]`：`panicked at ...: end byte index 80 is not a char boundary; it is inside '一' (bytes 78..81 of string)`。 |
| 影响 | 命令 panic（不在持锁路径内，但该次翻译请求失败且可能影响调用线程）。 |
| 实际修复 | 新增 `fn truncate_chars(value: &str, max_chars: usize) -> String { value.chars().take(max_chars).collect() }`（`copy-creator/src-tauri/src/translator.rs:262-264`，位于 `fmt_reqwest_error`（`:266`）之前），三处统一改为 `truncate_chars(&x, 80)`。语义变化：由「最多 80 **字节**」变为「最多 80 **字符**」（CJK 下最长 240 字节）；三处均为错误提示文案，已确认可接受。 |
| 新增测试 | `copy-creator/src-tauri/src/translator.rs` **原先没有任何测试模块**，本次新建 `mod tests`（`:277`）含 4 例：`truncate_chars_never_splits_a_multibyte_character`（`:281`）、`truncate_chars_counts_characters_not_bytes`（`:294`，12 个 emoji = 48 字节）、`truncate_chars_keeps_ascii_behaviour_byte_identical`（`:304`，80/200 字符边界、空串、短串）、`truncate_chars_handles_mixed_width_text`（`:317`，82 字符 / 246 字节的混合文本）。 |
| 修复验证 | ① 正常跑：4 例全绿。② **反向验证**：临时把 helper 改回 `value[..value.len().min(max_chars)]`，3 例立刻 FAILED（`end byte index 80 is not a char boundary; it is inside '一'`、`... inside '中'`、`end byte index 5 is not a char boundary; it is inside '🔑'`），ASCII 用例仍 ok。 |

### P1-5 从剪贴板「采集为便签」后不会打开刚采集的便签（`open-note` 事件把 id 丢弃）——**已修复（2026-10-10）**

| 项目 | 内容 |
| --- | --- |
| 位置 | `copy-creator/src/App.tsx:97-110`（`open-note` 监听器）：原 `:99` `const id = (event as CustomEvent<{ id: string }>).detail?.id;`、`:100` `if (typeof id !== "string") return;`、`:101` `React.startTransition(() => setActivePanel("phrases"));`、`:102-106` `void import("./stores/notesWorkspace").then(async ({ useNotesWorkspace }) => { await useNotesWorkspace.getState().initialize(); const workspace = useNotesWorkspace.getState(); workspace.back(); await workspace.feed?.setQuery("ungrouped", ""); });` |
| 唯一派发点 | `copy-creator/src/pages/ClipboardPage/ClipboardCard.tsx:429-430`：`captureNote(record.id)` 成功后 `setCtxMenu(null); window.dispatchEvent(new CustomEvent("open-note", { detail: { id } }));` |
| 问题 | 事件里带了 `id`，接收端校验了 `id` 却**从未使用**。打开的是随记页的「未分组」列表，而不是刚采集的那条便签。更严重的是它调用了 `workspace.back()`——这正是 §4 P2-17 里「`back()` 用 flush 前状态判断是否清理 `quickId`」的触发点，于是刚采集的记录可能被当成"已完成草稿"而不出现在快速编辑区。 |
| 附带发现（第三版未记录） | `copy-creator/src/pages/PhrasePage/SuijiPage.tsx:48-52` 另有第二个 `open-note` 监听器，其回调 `captured`（`:49` `setSearch(""); setPicker(false); setContext(null);`）**同样不使用 id**，只做界面复位。两个监听器都用 `window.addEventListener("open-note", ...)`，不构成冲突，但「谁负责打开便签」在设计上悬空。 |
| 修法（已就绪） | `copy-creator/src/stores/notesWorkspace.ts:34-41` 的 `open: async (id, expectedEpoch)` 实现完整（`:35` `const current = ++generation; set({ opening: true, error: null });`、`:37` epoch 校验、`:38` `await readNote(id)`、`:39` `if (current === generation) { get().coordinator?.setActive(id); set({ selectedId: id, opening: false }); }`），只需把 `App.tsx:101-106` 改为取 epoch 后 `workspace.open(id, epoch)`。**全仓对 `open(` 的 grep 除定义外零命中**，即当前没有任何调用者。 |
| **实际修复（2026-10-10）** | `copy-creator/src/App.tsx` 的 `open-note` 回调改为：<br>`React.startTransition(() => setActivePanel("phrases"));`<br>`void import("./stores/notesWorkspace").then(async ({ useNotesWorkspace }) => {`<br>`  await useNotesWorkspace.getState().initialize();`<br>`  // Open the record that was just captured instead of dropping to the list.`<br>`  await useNotesWorkspace.getState().open(id).catch(useNotesWorkspace.getState().setError);`<br>`});`<br>不再调用 `back()`，改调 `open(id)`（`open` 内部自会取 `coordinator.storageEpoch` 作 epoch 契约）。错误经 `setError` 进入 store，不再静默。 |
| 修复验证 | 前端全量 **87 passed / 0 failed**（新增测试文件 3 例）；`tsc -b --force` exit 0；`eslint .` exit 0；`vite build` 成功。**未做真实桌面交互验收**（未跑 `tauri dev`、未点「采集为便签」）。 |
| 验证方式（待补） | 剪贴板卡片右键 →「采集为便签」，断言随记页打开的是新便签而不是列表；再加一条前端单测覆盖 `open-note` 处理器（当前 `App.tsx` 仍无测试，本轮新增的 3 例只覆盖 `lib/suiji.ts` 与 `stores/notesWorkspace.ts`）。 |

### P1-6 分组或星标变更后立即返回，会丢失该次变更并可能整段丢弃草稿——**已修复（2026-10-10）**

| 项目 | 内容 |
| --- | --- |
| 位置 | `copy-creator/src/lib/suiji.ts:27-69`（`organizeNote`）：`:34` `const activeId = coordinator.activeNoteId;`（在 `:40` `get_note` 与 `:49` `organize_note` 两次 IPC **之前**捕获）、原 `:60` `pending.delete(id); await coordinator.discard(id); coordinator.setActive(activeId); coordinator.load(result.value.note, epoch, false);` |
| **第四版描述修正（第五版实测推翻）** | 第四版称「`activeId` 是取值快照，`setActive(activeId)` 传回的恰好也是旧值，**不会引入错误的新值**」——**该判断错误**。真实缺陷是：`:60` 把**请求发起时**捕获的 `activeId` 无条件写回，而 `:40`/`:49` 两次 `await` 期间用户完全可能另选一条记录（`select()` 会 `setActive(id)`）。此时旧快照会**覆盖用户的新选择**，把编辑器指针拉回一条已不再处于编辑状态的记录；而 `evictClean()`（`noteCoordinator.ts:316-323`，`:319` `const index = clean.findIndex((s) => s.id !== this.activeId);`）依赖 `activeId` 正确，指针错误会让真正在编辑的会话失去保护。**该结论经反向验证确认**（见下）。 |
| 问题②（顺序缺陷） | `copy-creator/src/pages/NotesPage/index.tsx:107` 的 `RecordGroupSelect` 回调 `onChange={groupId => { void run(() => organizeNote(id, { groupId })); }}` 与 `:91` 的 `const state = (action: NoteAction) => run(async () => { await changeNoteState(id, action); useNotesWorkspace.getState().back(); });` 都是 `void` 后立即返回路径。`organizeNote` 内部有两次 `await invoke(...)`；若用户在此期间关闭草稿（`:111` / `:114` 的 `back()`），旧 `back()` 里 `notesWorkspace.ts:48` 的 `void coordinator.flush(selectedId)` **未 await**，`:50-51` 又用 flush 前的 `session.status` 计算 `completed`，于是「还没落地就关闭」被判为已保存，`quickId` 被释放而写入可能尚未成功。 |
| 影响 | 分组/星标改动的观感是「点了没反应，刷新后又对」；极端顺序下（改分组后立刻关闭）可能出现记录状态与预期不一致。属于用户可见的随记可靠性问题，与 `docs/TODO.md` 的便签首发可靠性要求直接相关。 |
| **实际修复 a（`suiji.ts`）** | 把无条件写回改为**条件写回且复核活指针**：<br>`pending.delete(id); await coordinator.discard(id);`<br>`// `discard` clears the active pointer only when this record held it. Re-point the`<br>`// editor at it exactly in that case: writing the captured id back unconditionally`<br>`// would clobber a record the user selected while this request was in flight, and`<br>`// `evictClean` would then be free to drop the session they are actually editing.`<br>`if (activeId === id && coordinator.activeNoteId === null) coordinator.setActive(id);`<br>`coordinator.load(result.value.note, epoch, false);`<br>**注意**：本轮中途曾先写成 `coordinator.setActive(activeId === id ? id : activeId);`——该写法与原来的 `setActive(activeId)` **在数学上完全等价**（两分支都等于 `activeId`），是个无效果的假修复，是靠反向验证才发现的。第二个条件 `coordinator.activeNoteId === null` 用于排除「该记录原本是 active、但用户在写入期间已改选别处」的情形。 |
| **实际修复 b（`notesWorkspace.back()`）** | 把「是否可丢弃草稿」的判断推迟到 flush 落地之后，并加并发守卫：<br>`const { coordinator, selectedId } = get();`<br>`const settle = selectedId ? coordinator?.flush(selectedId).catch(() => {}) ?? Promise.resolve() : Promise.resolve();`<br>`void settle.then(() => {`<br>`  const current = get();`<br>`  if (current.coordinator !== coordinator \|\| current.selectedId !== selectedId) return;`<br>`  if (selectedId && coordinator?.getSession(selectedId)?.status === "empty") void coordinator.discard(selectedId).catch(() => {});`<br>`  const session = selectedId ? coordinator?.getSession(selectedId) : null;`<br>`  const completed = !session \|\| session.status === "saved" \|\| session.status === "empty";`<br>`  generation++; coordinator?.setActive(null); set({ selectedId: null, opening: false, error: null, ...(get().quickId === selectedId && completed ? { quickId: null } : {}) });`<br>`});`<br>**行为变化**：`back()` 现在异步生效（拆除推迟到一个微任务），任何断言「`back()` 后立刻 `selectedId === null`」的代码或测试需先 `await` 一个 tick。 |
| **新增测试** | `copy-creator/tests/recordStateActions.test.ts`（新建，3 例）：<br>① `organizeNote keeps a selection made while the write was in flight` —— `organize_note` 在途时把 `activeId` 改为第三条记录，断言不被旧快照覆盖；<br>② `organizeNote restores its own record when it was the active one` —— 该记录原本就是 active 且期间无人改选时仍保持 active；<br>③ `back() releases the quick draft only after the flush settles as saved` —— 用受控 promise 卡住 `flush`，先断言 `selectedId` 未变，放行后断言 `selectedId === null` 且 `quickId === null`。<br>测试用 VM 加载器驱动**真实的** `src/lib/suiji.ts` 与 `src/stores/notesWorkspace.ts`（`readFileSync` → `ts.transpileModule` → `vm.runInNewContext`），只 stub 原生边界（`invoke`）与 `./notes`/`./lifecycle` 两个协作者。 |
| **修复验证（含反向验证）** | ① 正常跑：**87 passed / 0 failed**；`tsc -b --force` exit 0；`eslint .` exit 0；`vite build` 成功 599ms；`scripts/qa-process-isolation.ps1` exit 0（`ownedQaNativeProcesses: 0`）。<br>② **反向验证 a**：把 `suiji.ts` 的恢复行改回 `coordinator.setActive(activeId);` → 测试①**变红**（`a selection made during the write must not be clobbered by the pointer captured before it`），②③仍绿；已还原。<br>③ **反向验证 b**：把 `notesWorkspace.back()` 还原成 HEAD 原实现（`void coordinator.flush(...)` + 立即拆除）→ 测试③**变红**（`back() must not tear down before the flush settles`），①②仍绿；已还原。<br>④ 第一次反向验证（对中途那个**等价**写法）**仍然全绿**，由此发现假修复——这也是本清单记录该教训的原因：**未做反向验证的绿灯测试不可信**。 |
| 验证方式（待补） | 手工验证改分组后立刻返回，重开后分组仍在；尚未做真实桌面交互验收（未跑 `tauri dev`）。 |

### P1-7 `get_suiji_groups` 回显请求里的 epoch —— 接手复核降级为一致性加固

| 项目 | 内容 |
| --- | --- |
| 位置 | `copy-creator/src-tauri/src/suiji.rs:45-54`：`:48` `try_producer`、`:49` `crate::db::require_storage_epoch(&app, Some(expected_storage_epoch))?`、`:50` `let state = app.state::<crate::db::DbState>(); let conn = state.conn.lock().map_err(|_| "notes.databaseFailed")?;`、**`:53` `Ok(crate::notes::StorageResult { storage_epoch: expected_storage_epoch, value: rows })`** |
| 接手复核 | 原返回值确实回显请求参数，但完整命令持有 producer 读许可；迁移必须先排空该许可，不能在校验与取锁间切库。原先所述可触发换库竞态不成立。保留工作区的锁内复核和真实 epoch 回包，作为与 notes 命令一致的加固，并修复其 `NoteError` 到字符串错误码的适配；不作为已复现的数据串库缺陷。 |
| 正确范式（同仓已有） | `copy-creator/src-tauri/src/notes.rs:703-709` `fn check_epoch(state: &DbState, expected_epoch: u64) -> Result<u64>`（`:704` 读 `state.storage_epoch.load(Ordering::Relaxed)`、`:705-707` 不等即 `Err(error("notes.storageChanged"))`），使用点在 `notes.rs:752` 取锁之后、`:754` `let epoch = check_epoch(&state, expected_epoch)?;`、`:764` 返回真实 `epoch`。 |
| 验证边界 | 接手时补丁有两处 E0277 编译错误，修正后 Rust 全量 174 通过/5 忽略。未复现原文声称的分组串库，未做分组 IPC 换库桌面验收；不能用“照抄校验函数”替代返回错误类型与 lifecycle 许可审查。 |
| 建议修复 | 把 `suiji.rs:49` 的 `require_storage_epoch` 校验移到 `:50` 加锁之后，或改为调用 `notes::check_epoch` 并把返回的真实 epoch 放进 `StorageResult`；同时为 `get_phrase_groups`/`get_phrases`（`db.rs:1387`、`db.rs:1472`，二者连 epoch 参数都没有）补上同样的合同。 |
| 验证方式 | 新增 Rust 单测：构造「校验通过后、加锁前换库」的等价场景（或直接断言返回值等于加锁后读取的 epoch）。 |

---

### P1-8 MSI 升级只打开 Windows Installer 参数帮助页 —— 源码修复，尚未发行/安装验收

2026-10-11 根据用户的 0.2.28 → 0.2.29 实际反馈补查：两标签的 `update_package.rs` 无差异，旧 `Command::args` 把含空格的整个 MSI 属性作为 CRT 参数加引号，Windows Installer 要求只引用 `PROPERTY="value"` 的值。之前数组断言漏掉真实命令行编码。当前源码改为受限原生值编码与 `raw_arg`；完整 Windows 命令行捕获及三组反向回退已补。PowerShell 不存在包探测正常到达 1619，但原生测试进程的 Installer 服务访问返回 1601，未当作通过。源码与测试定位、原失败日志及完整边界见[专项验证](../verification/2026-10-11-msi-command-line.md)，任务状态统一见 TODO 的 U-01/当前接手顺序。

## 4. P2 — 可靠性、资源与一致性

> **重要**：本节的条目**不构成批量改造清单**。锁、后台执行与毒化恢复应按用户要求**单独设计**，避免为消除清单条目而破坏既有保存合同。凡属推测或语义依赖的条目，均标注「先测量 / 需单独设计」。

| 编号 | 位置 | 问题（已修正） | 影响与建议 |
| --- | --- | --- | --- |
| P2-1 | `copy-creator/src/stores/clipboardStore.ts:107`、`:157`、`:314` | 原五项监听中四项丢失句柄，身份订阅与 HMR 清理亦未持有 | **修复与证据**：统一拥有五个句柄；unload/HMR 释放身份订阅与 DOM 回调，迟到注册立即退订，失败捕获；身份 await 后拒绝已销毁 store 的查询。原 init 守卫避免单次生命周期重复注册，维护项定级保持。自动回归/反向红灯见 [P2 验证](../verification/2026-10-10-p2-lifetimes.md)，真实桌面仍待验。 |
| P2-2 | `copy-creator/src/lib/documentVisible.ts:40-43` | `visibilitychange` 监听未纳入 `:31` 的 `stops` 数组（`:33`/`:38`/`:39` 的 listen/onFocusChanged/onResized 已纳入），故无法解除；且 `:41` 先手动通知、`:42` 再 `refreshWindowVisibility()`（后者在 `:25` 会再 publish 一次） | **修正第一版的影响推断**：两次通知确实存在，但 `copy-creator/src/lib/documentVisible.ts:56` 用 `useSyncExternalStore`，它会比较快照，**不等于必然重复渲染**；`:41` 的即时通知还承担「立即反映 `document.hidden`」的职责，不能简单删除。第一版所称「失败重试重复注册」也**缺少可达路径**：`:46` 的重试分支只在整个 `try` 抛出时进入，而 `:44` 的刷新函数内部已 `catch`（`:26`），不会抛出。故本条降级为「监听未纳入清理数组」的维护项。 |
| P2-3 | `copy-creator/src/pages/ClipboardPage/utils.tsx:18`、`index.tsx:9` | 原页面模块加载时就地写入五项 TYPE_META 图标，依赖导入顺序 | **修复与证据**：图标在 utils 定义处初始化，元数据类型只读，页面不再赋值。独立导入测试通过，回退 null 初始化变红。 |
| P2-4 | `copy-creator/src/stores/vaultStore.ts:37`、`:144`、`:157` | 同 epoch 内旧提示计时器可能提前清除新提示；原 epoch 判断已阻止污染新代次 | **修复与证据**：复制/填入共用计时器，每次新提示计满 2500ms；锁定/清除选择/开始填入取消旧计时器，保留 epoch 守卫。四种连续操作与两种清理自动通过，原实现回退变红。 |
| P2-5 | `copy-creator/src-tauri/src/db.rs:113-118`（`require_storage_epoch`） | `None` 等于**跳过**校验：`:114` `if expected.is_some_and(\|epoch\| epoch != ...)` | 事实成立。**不能据此断言正常操作已发生跨库污染**——前端 `invokeStorage` 走 `copy-creator/src/lib/storageIdentity.ts` 时会携带身份。建议收紧写命令合同（要求 `Some`），同时逐一审查兼容调用点，避免把合法的内部调用误判为缺陷。 |
| P2-6 | `copy-creator/src-tauri/src/db.rs:1927-1954`（`migrate_storage`，锁区 `:1936-1951`） | 持 `conn.lock()`（`:1937`）期间完成 `Connection::open`（`:1942`）+ `initialize_connection`（`:1943`）+ `storage::prepare_target`（`:1944`）+ `*conn = destination`（`:1949`）+ `fetch_add`（`:1950`） | 长锁事实成立。**但第一版的「把拷贝移到锁外」不可直接执行**：该迁移已在 `spawn_blocking` 内运行（入口 `db.rs:1913` `change_storage_directory`，`:1915` `spawn_blocking`），并处于排他保存屏障内，释放连接锁会破坏快照一致性、连接身份与失败回滚（`:1945-1946` 的注释明确说明「失败时保留旧连接/epoch，已提交目标 receipt 只验证并刷新本次暂存数据」）。**是否需要优化应先测量**；若优化，必须保持上述三条不变量。 |
| P2-7 | `copy-creator/src-tauri/src/clipboard.rs:991-1030`（`insert_and_emit`；锁区 `:1005-1028`，`state.conn.lock()` 在 `:1007`，`UPDATE` 在 `:1011`） | 持锁做去重查询 + `UPDATE created_at`；`find_duplicate_id`（`:941`）会**逐条读取候选并解密**（`crate::secrets::reveal(&stored_content)` 比较） | **修正第一版的建议**：当前去重带时间窗口（`:998-1002`，白名单 `1/5/30/60/300/900/1800`，默认 900）且比较的是加密前明文，**不能直接换成普通 UPSERT**。真正值得关注的是解密开销随候选增长。建议先测量窗口内候选数量与解密耗时，再决定是否为受保护记录建立可比较的索引。 |
| P2-8 | `copy-creator/src-tauri/src/db.rs:1724-1747`（`get_image_base64`）对照 `:1749-1752`（`get_image_thumbnail`）、`:1962-1965`（`ensure_thumbnail`） | 三条图片读取路径对生命周期保护**不对称**：`get_image_base64` 只校验 epoch、**不取** `try_producer`，另两条取 | **修正第一版的概念错误**：`try_producer`（`copy-creator/src-tauri/src/lifecycle.rs:204` `pub fn try_producer(&self) -> Option<RwLockReadGuard<'_, ()>>`）是**生命周期读锁**，不是有限数量的计算名额——持它是为了让迁移/退出等待在途工作完成，不是「占住名额」。故「编码属重工作、占住 producer 名额」的表述错误。真实问题是**完整图片读取路径缺少该保护**，与缩略图路径不一致，需单独分析其后果。 |
| P2-9 | `copy-creator/src-tauri/src/db.rs:1455-1469`（`delete_phrase_group`） | 删除分组前先调 `note_backup::promote_phrases`（`:1463`），再走 `crate::suiji::delete_group`（`:1464`）；**第四版补充**：`promote_phrases`（`copy-creator/src-tauri/src/note_backup.rs:224-232`）是循环全表扫描（`:226` `SELECT ... FROM phrases ... LIMIT 100` → `:229` apply → `:230` 逐行 DELETE） | 命令命名与行为不一致，且与 `save_suiji_group` 分成两个命令族（前端 `copy-creator/src/pages/PhrasePage/GroupManager.tsx:18`/`:30` 用 `save_suiji_group`，`:43` 用 `delete_phrase_group`）。**新增事实**：即使用户从未用过短语，每次删除分组都会在持锁事务内跑一遍「提升 + 删除 phrases」的全表扫描（正常情况表为空，代价小；但升级用户首次删除分组时会同步完成全部短语提升，属可感知停顿）。建议统一为随记分组命令，并把提升动作从删除路径移出（迁移已完成该工作）。 |
| P2-10 | `copy-creator/src-tauri/src/db.rs:710`、`copy-creator/src-tauri/src/notes.rs:42` | `suiji::init_schema` 被两处调用（靠 `IF NOT EXISTS` 幂等）；`note_organization` 在 v2 就已建出，却到 v6 才推版本号（`db.rs:669` 拒 `version > 6`，`db.rs:710-715` 推 `user_version=6`） | 迁移边界不清，后续改 schema 容易漏。建议单一入口并加注释说明归属版本。 |
| P2-11 | `copy-creator/src-tauri/src/translator.rs:34-52`（SQL `:40`） | **修正第一版**：缓存查询**含 `engine` 条件**（`WHERE source_text = ?1 AND target_lang = ?2 AND engine = ?3`），故「换引擎仍命中旧缓存」不成立。真实缺口是**同一 AI 引擎更换模型或 API 地址后**仍可能命中旧结果 | 建议在缓存键中加入影响输出的配置维度（模型名/自定义 API 地址），或对配置变更显式失效。 |
| P2-12 | `copy-creator/src-tauri/src/db.rs` **3** 处（`:228`、`:273`、`:280`）；`copy-creator/src-tauri/src/notes.rs` **2** 处（`:275`、`:336`）；`copy-creator/src-tauri/src/lib.rs` **4** 处（`:144`、`:159`、`:169`、`:480`）；`copy-creator/src-tauri/src/tray.rs` **2** 处（`:149`、`:200`）；`copy-creator/src-tauri/src/paste.rs` **2** 处（`:730`、`:1036`）；`copy-creator/src-tauri/src/clipboard.rs` **14** 处（`LAST_CLIPBOARD_*` 的 `.lock().unwrap()`，行号 `:1116`/`:1121`/`:1124`/`:1157`/`:1162`/`:1170`/`:1233`/`:1251`/`:1277`/`:1349`/`:1356`/`:1361`/`:1362`/`:1377`） | 生产路径的 `unwrap()`/`expect()`（已用大括号匹配排除全部 `#[cfg(test)]` 模块；第四版剔除 `paste.rs:1385`——它在 `#[cfg(all(test, target_os = "windows"))] mod windows_clipboard_tests` 内） | **修正第一版的建议**：**不能统一吞掉毒化错误**。`unwrap_or_else(\|p\| p.into_inner())`（`copy-creator/src-tauri/src/clipboard.rs:1139` 的既有写法）只在「状态仍一致」时安全；对连接锁这类承载事务状态的对象，盲目恢复可能读到半提交状态。逐类处理：<br>• `tray.rs:149` `image::load_from_memory(include_bytes!("../icons/icon.png")).expect(...)`（`:147` 为编译时嵌入资源）——**不是环境异常**，属构建期不变量，可保留或改为 `expect` 带明确说明；<br>• `paste.rs:1036` `OwnedGlobalMemory::as_handle` 的 `.expect("global memory was already transferred")`——表达**所有权不变量**（`transfer_to_clipboard` 在 `:1041-1042` 置 `self.handle = None`），不是环境异常；<br>• **第四版新增两条**：`notes.rs:275` `let candidate_json = candidates.map(\|ids\| serde_json::to_string(&ids).unwrap());`（`Vec<i64>` 序列化实际不会失败，但 panic 发生在 `notes.rs:752` 取到的连接守卫存活期内 → 会毒化互斥锁）；`notes.rs:336` `None if matches!(filter, NoteFilter::Trash) => last.deleted_at_ms.unwrap(),`（由 `notes.rs:287-290` 的谓词 `n.deleted_at_ms IS NOT NULL AND n.deleted_at_ms > ?5` 保证非空，属不变量式断言，同样在守卫存活期内）；<br>• `db.rs:228`/`:280`（`.expect("failed to get app data dir")`）、`db.rs:273`（`get_storage_dir` 的 `state.conn.lock().unwrap()`——**全仓唯一对中心连接锁的 `unwrap`**）、`lib.rs:144`/`:159`/`:169`（`LAST_MINIMIZED_AT` 锁；`:169` 的 panic 落在 Tauri 事件循环内）、`lib.rs:480`（构建失败 `.expect`）、`tray.rs:200`、`paste.rs:730`、`clipboard.rs` 的 14 处——这些才是环境/毒化类，需按状态一致性分别决定是否恢复。 |
| P2-13 | 全仓 Rust | `#[tauri::command]` 共 **104** 个，按属性行 + 签名行重新普查为 **68 同步 + 31 `async fn` + 5 `#[tauri::command(async)]`**（异步属性 5 个均在 `copy-creator/src-tauri/src/db.rs`：`:1007`、`:1311`、`:1723`、`:1748`、`:1961`）；`db.rs` 内 `conn.lock()` 出现 54 次；注册表 `copy-creator/src-tauri/src/lib.rs:373-478` 共 104 条，**双向差集为空**（`shortcut::save_note_shortcut` 已在 `lib.rs:441` 注册，§6.4 有专条） | **修正第一版的统计错误**（原写「99 个同步」，是当时按属性行与 `fn` 关键字粗判、未区分 `pub async fn` 所致）。仍有具体重操作需检查，但**不能据错误的统计做批量改造**。正确示例见 `copy-creator/src-tauri/src/db.rs:1913` `change_storage_directory` 用 `tauri::async_runtime::spawn_blocking`（`:1915`）。 |
| P2-14 | 全仓 Rust | **109** 处 `let _ = ...`（`paste.rs` 22、`db.rs` 17、`shortcut.rs` 14、`single_instance.rs` 11、`lifecycle.rs` 10、`update_package.rs` 7、`lib.rs` 6、`backup.rs` 5、`clipboard_wake.rs` 5、`clipboard.rs` 4、`db_metrics.rs` 2、`notes.rs` 2、`updates.rs` 2、`tray.rs` 1、`vault.rs` 1） | 含 `db.rs:963` 丢弃 `clipboard-deleted` 发射失败、`db.rs:990` 静默删除临时粘贴图片、`db.rs:997` `refresh_tray_menu(app).ok()`、`lib.rs:307` `let _ = autostart.enable()`。**存在 `let _ =` 本身不证明运行缺陷**，按具体后果处理：对关键发射/持久化加 `log::warn!` 即可，其余可保留。 |
| P2-15 | `copy-creator/src-tauri/src/db.rs:43-53`、`:12-22`、`:55-75`（`category_sql`，`apikey` 分支 `:69-72`） | 三处各自维护前缀清单与保护前缀（`dpapi:v1:%`、`sk-`、`AIza`、`glpat-`、`ghp-`、`xai-`） | 清单漂移风险。建议抽常量集中维护。 |
| P2-16 | `copy-creator/src/components/RadialMenu/index.tsx:225`、`copy-creator/src/lib/eventSubscriptions.ts:2` | **原“每次显示重复注册”推断不成立**：原 effect 的两个 callback 依赖稳定，setup 只在挂载时执行。真实缺口为 cleanup 后才解析的 listen 句柄无法释放 | **已修真实清理缺口**：helper 为迟到句柄立即退订；反复显示不累积、卸载全退订由真实 TSX 的 VM 接线验证，去掉立即释放的反向回退使测试变红。真实 WebView/StrictMode 桌面另验。 |
| P2-17 | `copy-creator/src/stores/notesWorkspace.ts:46-53`（`back()`） | `:48` `if (coordinator && selectedId) void coordinator.flush(selectedId).catch(() => {});` —— **`flush` 是异步的（`copy-creator/src/lib/noteCoordinator.ts:227`）却没有 `await`**；紧接着 `:50-51` 用 `coordinator?.getSession(selectedId)` 的**当前** `session.status` 计算 `const completed = !session \|\| session.status === "saved" \|\| session.status === "empty";`，`:52` 据此决定是否清除 `quickId` | `status` 要等 flush 的 IPC 落地才会变成 `"saved"`，因此「刚编辑完立刻返回」会被判为未完成 → `quickId` 保留；而 `create()`（`notesWorkspace.ts:43`）在 `quickId` 仍指向存在会话时会**复用它**，于是下次新建草稿会接续上一段内容。反向顺序下（`status === "empty"` 时 `:49` 的 `discard` 也是 `void` 未等待）可能把「已写入但状态未刷新」的会话丢弃。属随记可靠性问题，与前端的保存屏障语义强耦合。 |
| P2-18 | `copy-creator/src/pages/NotesPage/index.tsx:68`、`:171`、`:178`；`PhrasePage/SuijiPage.tsx:84` | 原编辑器与随记父页面各调用一次 useRecordGroups，多一组查询及三项监听 | **修复与证据**：编辑器 groups 为必传参数，两个父入口均显式复用已有分组；实际父页面+编辑器 VM 回归验证单次订阅与同一数据，回退后变红。hook 自身的原生注册/事件失败矩阵和真实 IPC 次数仍待验，不声称全应用缓存共享。 |
| P2-19 | `copy-creator/src-tauri/src/storage.rs` 的 `prepare_target` 空库准入 | 原先只检查 notes 与 phrase_groups，未检查 note_group_colors。只含颜色元数据的目标会通过准入；同 ID 的普通 INSERT 会约束失败并事务回滚，不同 ID 则会接受并合入该目标，原文“直接覆盖颜色”推断有误 | **已修复（接手，2026-10-10）**：增加颜色元数据准入检查，提前返回 `notes.storageConflict`。新增内存库测试覆盖同 ID/不同 ID，拒绝后完整目标 digest、分组及颜色行保持；有效暂存凭据重试合同不变。 |
| P2-20 | `copy-creator/src-tauri/src/shortcut.rs:64`（`NOTE_SHORTCUT_ID.store(new_shortcut.parse::<Shortcut>().map(\|key\| key.id()).unwrap_or(0), Ordering::SeqCst)`）对照 `:27`（`if NOTE_SHORTCUT_ID.load(Ordering::SeqCst) == shortcut.id()`） | 解析失败时把便签快捷键 ID 存成 **0 哨兵**，而 `0` 是合法 ID：`global-hotkey-0.7.0` 的 `hotkey.rs:97` 用 `id: (mods.bits() << 16) \| key as u32`，且 `parse_hotkey` 支持单键热键（`mods` 为空）；`keyboard-types-0.7.0` 的 `Code` 首变体 `Backquote` = 0 | 第四版新发现，**当前不可达**：`copy-creator/src/components/SettingsContent.tsx:67` 的录制逻辑要求至少一个修饰键（无修饰键直接 return），正常 UI 无法产生「单键 Backquote」。属潜在（若将来支持单键热键或经配置直写该值）。建议改用 `Option<u32>`/`u32::MAX` 之类不会与合法 ID 冲突的表示。另：`copy-creator/src-tauri/src/db.rs:1398` 用 `row.get::<_, i32>(2)` 读 `sort_order`，而 `copy-creator/src-tauri/src/suiji.rs:16` 的 `NoteGroup.sort_order` 是 `i64`——同一字段两个宽度，属同类一致性问题（一并登记于此）。 |

---

## 5. P3 — 死代码、文案、可访问性与文档

### 5.1 死代码（全仓 grep 确认无引用）

| 位置 | 说明 |
| --- | --- |
| `copy-creator/src/pages/PhrasePage/PhraseList.tsx`、`GroupChips.tsx`、`GroupDialog.tsx`、`ManageGroupsDialog.tsx`、`PhraseDialog.tsx` | 五个文件只命中自身定义（`PhraseList.tsx:13`/`:22`/`:29`、`GroupChips.tsx:13`/`:22`/`:29`、`GroupDialog.tsx:3`/`:12`/`:19`、`ManageGroupsDialog.tsx:12`/`:24`/`:34`、`PhraseDialog.tsx:3`/`:15`/`:25`），无任何 import 方（`index.tsx:1` 已改为转出 `SuijiPage`） |
| `copy-creator/src/stores/phraseStore.ts:113-195` | 六个 CRUD（接口 `:37-40`/`:45`/`:50`，实现 `:113`/`:124`/`:137`/`:154`/`:169`/`:184`）在 `src/` 无调用者，仅 `copy-creator/tests/phraseStorage.test.ts:7,38,43,56,64` 引用。**处置取决于 P1-1 的方向选择**：若轮盘改读随记，则连同 5 个死文件一并处理；保留测试则不能删这些 CRUD |
| `copy-creator/src/lib/notes.ts:66` | `invalidateNoteStorage` 无调用者 |
| `copy-creator/src/stores/settingsStore.ts:39`、`:126-128` | `setSettingsBatch` 声明与实现均无调用者（原生命令 `copy-creator/src-tauri/src/db.rs:1855` 仍在） |
| `copy-creator/src/stores/settingsStore.ts:19-20`、`:52-53`、`:95-96` | `baiduAppId`/`baiduSecret` 只写不读 |
| `copy-creator/src/lib/noteCoordinator.ts:8-9` | `NOTE_DIRTY_BYTES_RESERVED`/`NOTE_INFLIGHT_BYTES_RESERVED` 零引用（全仓仅命中 `:8`/`:9` 两行定义）。**澄清**：这不代表草稿完全没有容量边界——现有约束是字段长度（`copy-creator/src/lib/noteCoordinator.ts:3` `NOTE_BODY_MAX_BYTES = 256 * 1024`）与会话数（`:4` `NOTE_DIRTY_SESSION_LIMIT = 4`，实际生效在使用点 `:164`）；未生效的只是注释（`:5-7`）所描述的**字节预算**。建议删除常量并把注释改为描述真实生效的约束 |
| `copy-creator/src/types/index.ts:43` | `TranslationRecord` 全仓唯一命中 |
| `copy-creator/src/components/Icons.tsx:21`、`:90`、`:146` | `logo`/`search`/`empty` 三个图标无引用（`notes` 图标 `:2` 仍被 `copy-creator/src/pages/PhrasePage/RecordMenu.tsx:53,65` 使用） |
| `copy-creator/src/App.tsx:28-34` | `PANEL_MAP` 的 `notes` 键（`:30`）不可达：`NAV_ITEMS`（`:36-41`）无该键，`setActivePanel` 全部调用点（`:101`、`:122`、`:161`、`:289`、`:347`）不传 `notes` |
| `copy-creator/src/components/RadialMenu/index.tsx:75`、`:317` | **本轮已移除**。原 `lastFocusRef` 只写不读 |
| `copy-creator/src/components/RadialMenu/index.tsx:393` | **本轮已移除恒空分支**。原 `` `radial-menu-overlay${visible ? "" : " radial-menu-hidden"}` `` 位于 `:391` `if (!visible) return null;` 之后，三元恒为空串，`radial-menu-hidden` 永不生效（样式见 `copy-creator/src/styles/radial-menu.css:8,12`） |
| `copy-creator/src/components/RadialMenu/index.tsx:234`、`:264` | **本轮已移除**。原两处 `console.log` 调试残留（发布构建会保留） |

### 5.2 文案与 i18n（`AGENTS.md` 要求中英文案同步）

| 位置 | 硬编码文案 |
| --- | --- |
| `copy-creator/src/pages/ClipboardPage/index.tsx:259` | 「显示更多」 |
| `copy-creator/src/pages/ClipboardPage/ClipboardCard.tsx:389`、`:392` | **本轮已修，反向验证通过**。原文案：「收起长文本」/「展开完整文本」/「加载」/「收起」/「展开」（该文件 `:309`、`:365`、`:379` 已有 `t()` 用法可对照） |
| `copy-creator/src/components/ApiKeyToast.tsx:60`、`:62`、`:63` | 「检测到 API Key」/「可能是 …」/「可右键标注来源」（文件内无 `useTranslation`） |
| `copy-creator/src/pages/PhrasePage/PhraseList.tsx:54`、`:62` | 「选择一个场景组查看短语」/「当前分组中无快捷短语」（文件本身已是死代码，随 §5.1 一并处理） |

### 5.3 可访问性

| 位置 | 问题 |
| --- | --- |
| `copy-creator/src/components/IosSelect.tsx:54-67` | 触发按钮（`<button type="button" onClick=...>`）无 `aria-haspopup`/`aria-expanded`/`role`/`tabIndex`/`onKeyDown`（全文件对 `aria-`/`role=`/`onKeyDown`/`tabIndex` 零匹配）。**澄清**：它是原生 `<button>`，因此已有**基本** Tab 聚焦与 Enter/Space 激活；缺的是**完整选择器**的键盘交互（上下箭头/Escape）与 ARIA 状态。可参照新组件 `copy-creator/src/components/SelectMenu.tsx:76-101`（`aria-haspopup="menu"`/`aria-expanded`/`aria-controls`/`role="menu"`/`role="menuitemradio"`/`aria-checked`，以及 Arrow/Home/End/Escape/Tab 处理）或 `copy-creator/src/components/IosMultiSelect.tsx:26-36`（Escape 监听）与 `:49-51`（`aria-label`/`aria-expanded`/`aria-controls`） |
| `copy-creator/src/pages/ClipboardPage/index.tsx:198-207` | 分类 chip 无 `aria-pressed`（该文件 `:270` 有 `aria-label` 可对照） |
| `copy-creator/src/pages/ClipboardPage/ClipboardCard.tsx:395-397` | **本轮已修**：增加 `aria-label={t("common.delete")}`，反向验证通过。原问题：删除按钮无 `aria-label`/`title`（相邻 `:379`、`:388-389` 均有）。**第三版误写为 `copy-creator/src/components/ClipboardCard.tsx`（该路径不存在），第四版已改正为 `pages/ClipboardPage/`** |
| `copy-creator/src/pages/TranslationPage.tsx:91` | 错误图标复用垃圾桶图标 `Icons.delete`（`copy-creator/src/components/Icons.tsx:96`） |
| `copy-creator/src/components/settings/ShortcutSection.tsx:79` | 使用 `className="notes-hint"`，但该文件（`:1-4`）**不导入任何 CSS**；`.notes-hint` 只定义在 `copy-creator/src/styles/notes.css:13`/`:15`（`styles/settings.css` 零匹配），而 `notes.css` 的唯一导入者是 `copy-creator/src/pages/NotesPage/index.tsx:10`。第四版核对构建产物确认：`dist/assets/PhrasePage-*.css`（24032 B）内含 `notes-hint`，即当前提示样式**只是碰巧**随懒加载 chunk 一并生效；一旦 `NotesPage` 的 CSS 不再被打进同一 chunk，提示就会失去样式。建议把该提示样式移到 `settings.css`（或在 `ShortcutSection.tsx` 内显式导入）。 |

> **已修复条目**：第一版列的 `SearchInput.tsx` 无障碍缺口**已过时**——`copy-creator/src/components/SearchInput.tsx:27` 现有 `aria-label={ariaLabel ?? placeholder}`、`:35` 图标容器为 `<label aria-hidden="true">`，并新增 `ariaLabel`/`maxLength`/`onCompositionStart`/`onCompositionEnd` 四个 props（`:7-10`）。

### 5.4 其他一致性

| 位置 | 问题 |
| --- | --- |
| `copy-creator/src/pages/VaultPage/EntryEditor.tsx:59`、`:65` | 字段上限规则不精确：套用模板按钮 `disabled={entry.fields.length >= 60}`，新增字段按钮 `disabled={entry.fields.length >= 64}`。**不构成缺陷**——`addTemplate`（`:26-30`）只追加模板中**尚不存在**的字段，`PERSONAL_TEMPLATES`（`copy-creator/src/types/vault.ts`）每个模板 5 项，故一次最多新增 5 个：59 个时套用后为 64（正好等于上限），60 个时禁用是**在防超限**。可改为按**实际新增数量**（`entry.fields.length + newFields.length > 64`）判断，让规则更精确、含义更直白 |
| `copy-creator/src/stores/clipboardStore.ts:84`、`:89`、`:227` | `throw "notes.storageChanged"` 抛的是字符串而非 `Error`，且命名空间错位（剪贴板模块抛便签错误码）。**存在本身不证明运行缺陷**，按具体捕获点的处理后果评估 |
| `copy-creator/src/pages/NotesPage/index.tsx:37`、`:47` | `feed.setQuery(...)` 只传 2 参（`copy-creator/src/lib/noteFeed.ts:33` 的第三参 `groupId` 默认 `null`）→ 会丢失分组筛选。**当前不可达**：该默认导出（`NotesPage/index.tsx:170`）无渲染点（`copy-creator/src/App.tsx:22-25` 的 `React.lazy` 列表不含 `NotesPage`，`:30` 的 `PANEL_MAP.notes` 死键也指向 `<PhrasePage />`），只有 `copy-creator/src/pages/PhrasePage/SuijiPage.tsx:5` 复用其具名导出 `NoteEditor`，而 `SuijiPage.tsx:56` 的同类调用已正确传参；但一旦启用 `NotesPage` 即成为 P1 |
| `copy-creator/src/components/UpdateCheck.tsx:60` | `import "../styles/updates.css";` 位于文件最后一行（共 60 行）；`copy-creator/src/components/AboutDialog.tsx:1` 也导入同一 CSS（跨文件重复导入）。**导入同一份 CSS 不会产生运行缺陷**——已核对构建产物：`updates.css` 的内容只在 `dist/assets/UpdateCheck-*.css`（3145 B）出现一次，未被复制成两份，故这只是位置与组织问题（把 CSS 导入放在组件定义之后不符合文件内惯例） |
| `docs/TODO.md`「当前接手顺序」段（`:209` 起） | 仍写「冻结原 profile/WAL FULL/schema 5」（`:211`），与当前源码（`user_version = 6`、单实例、随记）不符；`:219` 同样写 schema 5。**第四版补充**：该段的既有统计也已陈旧（写「前端 74/74、Rust 137 通过/3 忽略」，而本轮实测为前端 84、Rust 173 通过/5 忽略） |

---

## 6. 已核实**不成立**或需澄清的条目（避免按旧结论返工）

### 6.1 本版新修正（第一版描述有误）

| 原条目 | 核实结果 |
| --- | --- |
| P1-3「`get_clipboard_record_content` 是无类型判断的明文出口，构成泄密漏洞」 | **降级为加固项**。`copy-creator/src-tauri/src/secrets.rs:38-41` 的 `reveal` 以 `strip_prefix(PREFIX)` 开头（`PREFIX = "dpapi:v1:"`，`:8`），**非受保护内容原样返回**；且显式复制/粘贴 Key 本来就需要取得原文，故不能认定为独立泄密漏洞。命令（`copy-creator/src-tauri/src/db.rs:1106-1117`，定义 `:1106`）确实对任意 `id` 都返回 `reveal` 后的内容而**不校验类型**，补类型校验可作为加固（也顺带缓解 P1-2 的旁路），但**不是独立的安全边界缺口**；未发现它能读取密码箱或设置类密钥。 |
| P2-2「可见性重复通知造成重复渲染；失败重试重复注册」 | **影响推断不成立**（详见 §4 P2-2）。 |
| P2-4「定时器污染新代次状态」 | **影响描述不成立**（详见 §4 P2-4）。 |
| P2-6「迁移应把拷贝移到锁外」 | **建议不可直接执行**（详见 §4 P2-6）。 |
| P2-7「去重应改为 UPSERT」 | **建议不正确**（详见 §4 P2-7）。 |
| P2-8「编码占住 producer 名额」 | **概念有误**（详见 §4 P2-8）。 |
| P2-11「换引擎仍命中旧缓存」 | **不成立**，缓存 SQL 含 `engine` 条件（详见 §4 P2-11）。 |
| P2-12「统一恢复毒化锁、移除 expect」 | **不能一刀切**（详见 §4 P2-12）。 |
| P2-15（第一版编号）「99 个同步命令」 | **统计错误**，实为 68 同步 + 31 `async fn` + 5 异步属性（详见 §4 P2-13）。 |

### 6.2 已过时（问题已消失）

| 原条目 | 核实结果 |
| --- | --- |
| 「`SearchInput.tsx` 无无障碍名称」 | **已过时**。现已有 `aria-label={ariaLabel ?? placeholder}`（`copy-creator/src/components/SearchInput.tsx:27`）与 `aria-hidden` 图标容器（`:35`）。 |
| 「随记 QA 脚手架 `suiji-qa.html`/`suiji-qa.tsx` 残留在工程根目录」 | **已不存在**。两个文件均已删除（`Test-Path` 均为 False）。 |

### 6.3 第一版即已核实不成立

| 条目 | 核实结果 |
| --- | --- |
| 「`shortcut::save_note_shortcut` 未在 `lib.rs` 注册」 | **不成立**。已注册于 `copy-creator/src-tauri/src/lib.rs:441`，定义在 `copy-creator/src-tauri/src/shortcut.rs:54`；前端调用点仅两处：`copy-creator/src/stores/settingsEditorStore.ts:157` 与 `copy-creator/src/components/SettingsContent.tsx:94`。设置界面另有 `copy-creator/src/components/settings/ShortcutSection.tsx:32`（`note_shortcut_status`）、`:57-59`（录制与清除按钮）与 `:79`（不可用提示），均为读取/交互入口。`lib.rs:373-478` 注册 104 条与全仓 104 个 `#[tauri::command]` **双向差集为空**。 |
| 「`VaultGate.tsx:12`/`ChangeMaster.tsx:12` 使用 `React.SubmitEvent` 但未 import React」 | **不成立**。类型位置引用 UMD 命名空间合法（`@types/react` 的 `export as namespace React`），`tsc -b --force` exit 0。同一模式亦见 `copy-creator/src/pages/VaultPage/EntryEditor.tsx:31` 的 `React.FormEvent`。 |
| 「`notes.rs:320` `last.deleted_at_ms.unwrap()` 可能 panic」 | **不成立**（作为独立缺陷）。`copy-creator/src-tauri/src/notes.rs:287-290` 的 Trash 谓词为 `n.deleted_at_ms IS NOT NULL AND n.deleted_at_ms > ?5`，该分支内必然非空。**第四版补充**：该 `unwrap` 现在位于 `notes.rs:336`，且它与 `notes.rs:275` 的 `serde_json::to_string(&ids).unwrap()` 一样，执行时**连接守卫仍然存活**（`notes.rs:752` 取锁、`:756` 进 `db_metrics::measure`），一旦 panic 会毒化互斥锁——故它们不构成「会 panic 的缺陷」，但属于 §4 P2-12 里「不变量式断言」的一类，修复方式应是断言而非吞错。 |
| 「`vault.rs:563` `current.as_ref().unwrap()` 可能 panic」 | **不成立**。`copy-creator/src-tauri/src/vault.rs:554` 的 `if current.is_none()` 已排除 `None`。 |
| 「clipboardStore 5 处 `listen` 全部未保存句柄」 | **需修正**：5 处中 `:107` 已保存并在 `:313-314` 解除，未保存的是 `:109`/`:116`/`:128`/`:140`。 |
| 「RadialMenu 只有 1 处 `console.log`」 | **需修正**：实为 2 处（`:234`、`:264`）。 |
| 「`docs/prompts/open_issues_prompt.md:69-75` 的硬编码百度密钥仍在 `db.rs:78-79`」 | **行号已失效**。`db.rs` 的 `INSERT OR IGNORE INTO settings` 块在 `:770-787`，不含 baidu 键；`db.rs:122`、`copy-creator/src-tauri/src/backup.rs:23`、`copy-creator/src-tauri/src/secrets.rs:61` 仅以字符串名单提及 `baidu_secret`。该文档的其余旧行号同样不可直接使用。 |
| 全仓 `any`、`TODO`/`FIXME`/`unimplemented` | 均为 0 处（已 grep）。 |

### 6.4 第四版新增的修正（两个只读子代理的条目已逐条复核）

> 本轮派发两个只读子代理分别复核前端与后端。它们的**结论方向大体正确，但所报行号多处偏移**（评审期间 `db.rs` 因 P0-1 修复下移 6 行，且各自按不同修订取号）。下表只列**复核后需要修正或推翻**的部分；其余条目已并入 §3/§4。

| 子代理条目 | 复核结果 |
| --- | --- |
| 「`shortcut::save_note_shortcut` 未注册」 | **再次确认为不成立**（第二轮误报）。注册在 `copy-creator/src-tauri/src/lib.rs:441`，104 条注册与 104 个 `#[tauri::command]` 双向差集为空。子代理所称「`toggle_always_on_top` 同名比较假象」也已核实：定义在 `lib.rs:204`、注册在 `lib.rs:477`，不是重复项。 |
| 「`get_suiji_groups` 回显 epoch」 | **成立**，已升为 §3 **P1-7**（子代理报 `:49`/`:50`/`:53` 三行，与本轮实测一致）。 |
| 「`notes.rs:275`/`:336` 持锁 panic」 | **成立但降级**：两处均为**不变量式断言**（`Vec<i64>` 序列化不会失败；Trash 谓词保证非空），已在 §4 P2-12 内登记，不作为独立缺陷。 |
| 「`create_phrase_group` 不建 `note_group_colors` 行」 | **成立**：`copy-creator/src-tauri/src/db.rs:1421-1425` 只写 `phrase_groups`，`:1427-1433` 返回的 JSON **无 `color` 字段**；而 live 实现 `copy-creator/src-tauri/src/suiji.rs:66-68` 会同时 upsert 颜色行，读取侧 `suiji.rs:20-23` 用 `COALESCE(c.color,'#8e8e93')` 兜底。属 §4 P2-9 的同一族（命令族混用），建议随 P1-1 方向一并统一。 |
| 「`phrases` 与 `phrase_groups` 都是死表」 | **需澄清**（子代理自己已更正）：`phrases` 确已抽空，但 **`phrase_groups` 是 live 表**——`suiji.rs:23`/`:30`/`:66`/`:74`/`:84`、`notes.rs:809`、`storage.rs:182` 都在用。第一版与第三版均已按此口径书写（见 §3 P1-1）。 |
| 「`paste.rs:1385` 是生产 panic 点」 | **推翻**：该处在 `#[cfg(all(test, target_os = "windows"))] mod windows_clipboard_tests` 内（测试模块门 `paste.rs:1112`），已从 §4 P2-12 的计数中剔除（生产数由 3 降为 2）。 |
| 「`db.rs:1391` 用 i32 返回 `sort_order`」 | **成立**（行号实测确为 `db.rs:1398`，SQL 在 `:1391`）：`row.get::<_, i32>(2)` 与 `suiji.rs:16` 的 `i64` 宽度不一致，已并入 §4 P2-20。 |
| 「`RadialMenu` 每次显示都重复注册监听」 | **成立，但降级为 P2 并标注未做运行时验证**：证据是 `RadialMenu/index.tsx:246-287` 的 `setup()` 内含三次 `await listen(...)`、`:289` 自调用、`:286` 才把句柄存入 `unlisteners`，而 `:280` 的 `resetState()` 不做退订。**未真实驱动轮盘验证**，故只列为 §4 P2-16。 |
| 「`storage.rs:165` 未删 `note_import_origins` 是数据泄漏」 | **不成立**：`copy-creator/src-tauri/src/note_backup.rs:8` 对 `note_import_origins.restored_note_id` 声明了 `ON DELETE CASCADE`，且 `db.rs:679` 开启 `foreign_keys=ON`，删除 notes 时会级联清理。**（未做运行时验证，属静态判断。）** |
| 「`App.tsx:98-107` open-note 已丢失 id」 | **成立**（实测 `:97-110`），已升为 §3 **P1-5**；并补记 `SuijiPage.tsx:48-52` 的第二个监听器同样不处理 id。 |
| 「`ShortcutSection.tsx:79` 的 `notes-hint` 无 CSS」 | **需修正**：该文件确实不导入 CSS，但 `notes.css` 已被打进 `dist/assets/PhrasePage-*.css`，故当前**样式实际生效**；真实风险是这条样式依赖懒加载 chunk 的打包结果。已在 §5.3 记为组织问题而非缺陷。 |

### 6.5 第五版新增的修正（修复过程中被推翻的结论）

> 本节记录**在真正动手修 P1-6 时**被反向验证推翻的判断。它同时是本清单最重要的方法论提醒：**绿灯测试不等于有效测试**。

| 原判断 | 复核结果 |
| --- | --- |
| 第四版 P1-6 问题①：「`activeId` 是取值快照，`setActive(activeId)` 传回的恰好也是旧值，**不会引入错误的新值**，只是掩盖 `discard` 语义」 | **推翻（严重低估）**。`:34` 的快照在 `:40`/`:49` 两次 `await` **之前**取得；用户在这两个 await 期间完全可能通过 `select()` 改选另一条记录（`notesWorkspace.ts` 的 `select` 会 `coordinator.setActive(id)`）。此时 `:60` 把旧快照写回，会**直接覆盖用户的新选择**，把编辑器指针拉回已不处于编辑状态的记录，并使 `evictClean()`（`noteCoordinator.ts:319`）失去对真正在编辑会话的保护。这是**用户可见的状态错乱**，不是「写法不优雅」。 |
| 由上一行推出的修法：「`coordinator.setActive(activeId === id ? id : activeId)`」 | **该写法是假修复**。两个分支的值都等于 `activeId`，与原实现**在数学上完全等价**，等于一行都没改。**是靠反向验证发现的**：把这一行改回 `coordinator.setActive(activeId)` 后，当时写的测试**仍然全绿**，说明测试没有钉住任何行为。 |
| 第一版测试「`organizeNote` 保持用户自己的记录为 active」 | **空转测试，已重写**。原测试让 `activeId = mine.id` 而整理的是**另一个** id，于是 `discard` 根本不会清空指针，缺陷版与修复版观测值相同。重写后的测试改为**在 `organize_note` 在途时把 `activeId` 改成第三条记录**，从而真正复现缺陷路径。 |
| 修正后的实现 | `if (activeId === id && coordinator.activeNoteId === null) coordinator.setActive(id);`——两个条件分别排除「原本就不是这条」与「原本是这条、但用户在写入期间已改选别处」两种情形；只有「原本是这条且期间无人改选」时才把指针放回。 |
| 方法论结论 | **凡声称修好了竞态/顺序缺陷，必须做反向验证**：把实现改回缺陷写法，新测试必须变红；若仍绿，测试无效。本轮两次反向验证（`suiji.ts` 恢复行、`notesWorkspace.back()`）均按此执行并各自使对应测试变红。 |

---

## 7. 测试覆盖缺口

以下模块**没有**专属测试文件（`copy-creator/tests/*.test.ts` 第五版共 11 个文件、87 例；~~`src/lib/suiji.ts`~~ 与 ~~`src/stores/notesWorkspace.ts`~~ 已由新增的 `recordStateActions.test.ts` 覆盖，但它们仍**没有以自身命名的测试文件**，覆盖是通过 VM 加载器间接达成的）：

`copy-creator/src/lib/documentVisible.ts`、`copy-creator/src/lib/notes.ts`、`copy-creator/src/lib/noteActions.ts`、`copy-creator/src/lib/useRecordGroups.ts`、`copy-creator/src/stores/settingsEditorStore.ts`、`copy-creator/src/stores/vaultStore.ts`。

Rust 侧薄弱：`clipboard_wake.rs`、`note_files.rs`、`update_signature.rs`（仅由 `update_package.rs` 间接覆盖）、`storage_events.rs`、`suiji.rs`（仅 1 例）。~~`translator.rs`~~ 已在本次修复中新建 `mod tests`（4 例），不再是零测试模块。

**已完成**：P0-1 与 P1-4 属「字节 vs 字符」类缺陷，已各自补齐 Unicode 边界用例（`db.rs` 3 例、`translator.rs` 4 例），并做了反向验证（改回旧实现即失败）。

**剩余缺口（第五版更新）**：
- `is_api_key` 的检测语义（ASCII 限定、`\r`/`\t`、200/201 字节边界）**仍未测试**——本次按用户决定不改其行为，但若将来要收紧，需先补这些用例。
- **P1-5（open-note 丢弃 id）**：~~`copy-creator/src/App.tsx` 无任何测试~~ **代码已修（改为 `open(id)`），但仍缺针对 `App.tsx` 事件处理器的测试**——本轮新增的 3 例只覆盖 `lib/suiji.ts` 与 `stores/notesWorkspace.ts`。
- **P1-6 / P2-17（随记状态机）**：~~未覆盖~~ **已由 `copy-creator/tests/recordStateActions.test.ts` 覆盖 3 例**（`organizeNote` 的并发改选、`organizeNote` 的自身恢复、`back()` 的 flush 顺序），且两处均通过反向验证。仍缺：`changeNoteState` 与 `captureNote` 路径的顺序覆盖。
- **P1-7（epoch 回显）**：`copy-creator/src-tauri/src/suiji.rs` 的 `mod tests`（`:88-101`）只有 1 例，未覆盖 `get_suiji_groups` 的返回值。
- **P2-18（重复订阅）**：`p2Lifetimes.test.ts` 已用真实两个父页面及 NoteEditor 覆盖单次订阅/分组透传，并完成反向验证；hook 自身原生注册/事件失败矩阵与桌面 IPC 次数仍待补。
- **P2-19（换库闸门）**：接手已新增「只含 `note_group_colors` 的目标库」测试，覆盖同 ID 与不同 ID 两种情况；本模块共 6 例。真实目录切换桌面联合验收仍待补齐。
- **新增测试的驱动方式**：`recordStateActions.test.ts` 用 VM 加载真实源码，因此**依赖 `src/lib/suiji.ts` 与 `src/stores/notesWorkspace.ts` 的相对导入说明符**（stub 按 `./notes`/`../lib/notes` 等字面匹配）。若将来引入新的协作者模块，需在 `loadModules` 的 `require` 里补分支，否则会以 `Unexpected dependency <name>` 失败。

---

## 8. 环境注意事项（跑测试前必读）

- **Rust 测试的临时目录**：直接跑 `cargo test --manifest-path src-tauri/Cargo.toml` 时，若 `TEMP`/`TMP` 指向不可写目录，会出现 13 个失败：`SqliteFailure ... CannotOpen extended_code 14 "unable to open database file: ...\Temp\copy-creator-schema-<uuid>.db"` 与 `PermissionDenied PathError ...\Temp\.tmpl1j99U`。这是环境限制而非代码缺陷——把 `TEMP`/`TMP` 指向仓库内可写目录（例如 `output/tmp-rust`）后即 **173 passed / 0 failed / 5 ignored**（修复 P0-1/P1-4 前为 166，第四版复测输出为 `running 178 tests`）。
- **第四版的验证动作**：只做只读复核（`read`/`grep`/`Select-String`/构建产物检查）+ 实跑 `cargo test`（TEMP 重定向）与 `pnpm test:unit`，**未改任何源码、未运行 `pnpm exec tauri dev`、未安装包、未触碰数据库**。
- **隔离要求**：任何涉及剪贴板、快捷键、托盘、窗口焦点的验证，按 `AGENTS.md` 使用合成夹具与隔离标识，并在 QA 前与收尾运行 `scripts/qa-process-isolation.ps1`。
- **第五版的验证动作**：改动了 `copy-creator/src/App.tsx`、`copy-creator/src/lib/suiji.ts`、`copy-creator/src/stores/notesWorkspace.ts` 三个前端文件并新增 `copy-creator/tests/recordStateActions.test.ts`；实跑前端全量测试、`tsc -b --force`、`eslint .`、`vite build` 与 `scripts/qa-process-isolation.ps1`（均通过）。**未改任何 Rust 文件、未重跑 `cargo test`、未运行 `pnpm exec tauri dev`、未安装包、未触碰真实数据库**。反向验证的临时改动已全部还原（`suiji.ts:65`、`notesWorkspace.ts:back()` 已确认恢复为修复后版本）。
- **本次修复的范围**：只改动 `copy-creator/src-tauri/src/db.rs` 的 `make_key_preview` 与 `copy-creator/src-tauri/src/translator.rs` 的三处截断（+ 新增 helper 与测试），**未运行 `pnpm exec tauri dev`、未安装包、未触碰数据库**。复现与对照程序写在 gitignore 的 `output/tmp-repro/` 下。

---

## 9. 建议的修复顺序

按用户给出的方向整理（**第 1、3 项已完成**）：

1. ~~**两类 UTF-8 panic 一起修**：**P0-1**（`make_key_preview` 字符安全切分 + `is_api_key` ASCII 限定，**两条触发路径都要覆盖**）与 **P1-4**（三处翻译截断抽公共 `truncate_chars`）。改动小、风险低，补齐 Unicode 边界单测后再继续。~~ **已完成（2026-10-10）**：`make_key_preview` 改为字符安全切分（一次覆盖全部 5 个调用点）；`translator.rs` 新增 `truncate_chars` 并替换三处。**`is_api_key` 的 ASCII 限定按用户决定未做**——它是独立的行为变更，且对修 panic 无贡献。新增 7 例测试（`db.rs` 3 + `translator.rs` 4），Rust 由 166 增至 **173 passed**；两处都做了「改回旧实现即失败」的反向验证。
2. **P1-1 方案 A 已实现并通过反向回归**；真实桌面保存/粘贴与迁移联合验收继续，见 TODO。
3. ~~**修随记状态机的两个真实回归**：**P1-5**（`open-note` 用 `workspace.open(id, epoch)` 取代 `back()`+`setQuery`，改动只有几行，`notesWorkspace.ts:34-41` 的实现已就绪）与 **P1-6**（`organizeNote` 的 activeId 恢复条件 + `back()` 的 `flush` 未 await）。~~ **已完成（2026-10-10）**：`App.tsx` 的 `open-note` 改调 `open(id)`；`suiji.ts` 的恢复行改为 `if (activeId === id && coordinator.activeNoteId === null) coordinator.setActive(id);`；`notesWorkspace.back()` 改为 flush 落地后按并发守卫拆除。新增 `tests/recordStateActions.test.ts`（3 例），前端由 84 增至 **87 passed**；两处修复均通过反向验证。**遗留**：`back()` 行为变为异步生效，调用方若依赖「立即清空」需 `await` 一个 tick。
4. **P1-2 已补原生类型/16 KiB 上限；P1-7 已按接手结论降为一致性加固**。P2-5 兼容调用点与必填 epoch 合同继续逐项审查，不批量收紧。
5. **监听、缓存与清理项**按 TODO 继续；P2-1/3/4/18 代码及自动反向回归见 [P2 验证](../verification/2026-10-10-p2-lifetimes.md)，桌面受环境权限阻挡，未计通过。P2-16 已纠错、P2-19 已修，其余 P2/P3 未自动关闭。
6. **单独设计，不要为消除清单条目而动**：**P2-6**（迁移长锁，先测量，须保持快照一致/连接身份/失败回滚）、**P2-7**（去重解密开销，先测量候选规模）、**P2-8**（图片读取保护不对称，单独分析）、**P2-17**（`back()` 的 flush 顺序**主体已在 P1-6 中修掉**，剩余是 `changeNoteState` 路径的同类顺序问题，须与保存屏障一起回归）、**P2-12**（毒化恢复须按状态一致性分类处理）。用户明确要求：**避免为消除清单条目而破坏保存合同**。
7. **文档同步**：修复后更新 `docs/TODO.md`（含陈旧的「当前接手顺序」段，`:211`/`:219` 仍写 schema 5 与旧测试数）、受影响的功能设计与 `AGENTS.md` 入口。**第五版已同步**：本清单升为第五版、`docs/TODO.md` 增补条目、新建 `docs/verification/2026-10-10-note-state-regressions.md`。
