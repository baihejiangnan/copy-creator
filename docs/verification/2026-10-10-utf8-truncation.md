# UTF-8 字节切片 panic 修复验证

2026-10-10，按用户明确授权的范围修复 `docs/reviews/2026-10-10-code-fix-list.md` 中的 **P0-1** 与 **P1-4** 两类缺陷。接手时 main 已有 AGENTS、TODO、单实例/随记源码与历史记录的未提交修改，保留并增量合并。基础版本保持 0.2.28，未提交、推送、打包或发行。

## 问题

`copy-creator/src-tauri/src/db.rs` 的 `make_key_preview` 与 `copy-creator/src-tauri/src/translator.rs` 的三处错误截断都用**字节长度**做**字符切分**：

- `db.rs:43`（修复前）`format!("{}...{}", &c[..8], &c[c.len() - 4..])`——`c.len()` 是字节数。
- `translator.rs:142`/`:211`/`:245`（修复前）`&x[..x.len().min(80)]`。

当内容含多字节字符且切点落在字符内部时 panic。密钥预览的 panic 发生在 `get_clipboard_records` 持有 `Mutex<Connection>` 的查询回调内（`db.rs:1012` 取锁 → `db.rs:1024` `stmt.query_map(..., clipboard_record_json)`），会毒化连接互斥锁，使之后所有需要该锁的命令失败。

`make_key_preview` 有 **5 个调用点**（`db.rs:189`、`db.rs:211`、`db.rs:2040`、`clipboard.rs:1065`、`tray.rs:30`）。其中 `db.rs:211`（`clipboard_record_json`）与 `tray.rs:30`（托盘菜单标题）的输入由 `user_api_key != 0` 判定，**不受 `is_api_key` 约束**——用户手动把任意记录标为 API Key 后，含中文的内容同样会走到该函数。故在函数内部做字符安全切分是唯一能一次覆盖全部调用点的位置。

## 实现

- `db.rs:43-53` `make_key_preview` 改为按字符计数与切分：`c.chars().count()` 判定门槛（`:45`），`chars().take(8)` 取头、`chars().skip(char_count - 4)` 取尾。**5 个调用点全部自动受益，未逐个改动**。
- `translator.rs:262-264` 新增 `fn truncate_chars(value: &str, max_chars: usize) -> String { value.chars().take(max_chars).collect() }`，三处错误提示统一改用。
- **未改动 `is_api_key`**（用户明确选择不做该独立行为变更）：收紧为 ASCII 会改变「以 `sk-` 开头的中文串」是否被 DPAPI 加密、是否显示 API Key、是否被便签采集拒绝，属独立语义变更，且对修 panic 无贡献（只能覆盖 5 个调用点中的 2 个）。
- 未改动任何前端文件、数据库 schema、迁移或锁/生命周期逻辑。

## 实际检查

Windows x64。`cargo test` 需把 `TEMP`/`TMP` 指向仓库内可写目录，否则系统 Temp 会拒绝访问（既有环境限制，见 `docs/problems_and_solutions.md`）。

| 检查 | 结果 |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml`（修复后） | **173 通过、0 失败、5 忽略**；main 与 doc-tests 也通过 |
| 同上（修复前基线） | 166 通过、0 失败、5 忽略（本次新增 7 例） |
| `cargo test --lib key_preview` | 3 例全部通过 |
| `cargo test --lib truncate_chars` | 4 例全部通过（`translator.rs` 此前**没有任何测试模块**，本次新建） |
| `pnpm test:unit` | 84 通过、0 失败（本次未改前端，数字与修复前一致） |
| `pnpm exec tsc -b --force` | exit 0 |
| `pnpm lint` | exit 0 |
| `cargo build` | 成功，仅 1 条 `linker_messages` 提示（链接器输出，非代码告警） |
| `git diff --check` | exit 0，无空白错误 |
| 残留字节切片普查 | `src-tauri/src` 内 `[..`/`split_at`/`as_bytes()[` 命中 5 处，全部作用于 `Vec<u8>`/`&[u8]`（`clipboard.rs:458`、`clipboard.rs:843`、`db.rs:2717`、`update_signature.rs:68`、`vault_crypto.rs:97`），`&str` 上已清零 |

## 新增测试

`db.rs` 的 `mod tests` 新增 3 例：

- `key_preview_never_splits_a_multibyte_character`——`"sk-" + 6 个汉字`（21 字节 / 9 字符，`is_api_key` 判定为 true）与 14 字符长样本。
- `key_preview_keeps_ascii_behaviour_byte_identical`——7 个 ASCII 样本，含 11/12 字符边界、空串、两端空白、真实 Key 格式。
- `key_preview_handles_emoji_and_wide_characters`——12 个 emoji（每个 4 字节）、12 与 11 个汉字。

`translator.rs` 新建 `mod tests`，4 例：多字节不切开、按字符而非字节计数（12 个 emoji = 48 字节）、ASCII 行为逐字节一致（80/200 边界、空串、短串）、混合宽度文本（82 字符 / 246 字节）。

## 反向验证

仅「测试通过」不足以证明测试拦得住该缺陷，故把实现临时改回字节切片后重跑：

| 探针 | 结果 |
| --- | --- |
| `make_key_preview` 改回 `&c[..8]`/`&c[c.len()-4..]` | `key_preview_never_splits_a_multibyte_character` 与 `key_preview_handles_emoji_and_wide_characters` **FAILED**，复现 `end byte index 8 is not a char boundary; it is inside '二' (bytes 6..9 of string)`；ASCII 用例仍 ok |
| `truncate_chars` 改回 `value[..value.len().min(max_chars)]` | 4 例中 3 例 **FAILED**，复现 `end byte index 80 is not a char boundary; it is inside '一'`、`... inside '中'`、`end byte index 5 is not a char boundary; it is inside '🔑'`；ASCII 用例仍 ok |

两次探针均已还原，工作区无 `TEMP-REVERT-PROBE` 残留（已 grep 确认）。

## 行为变化

- **ASCII 输入逐字节不变**（已有回归用例覆盖）。
- **非 ASCII 预览按字符对齐 ASCII 语义，因而变长**：12 个 emoji 由旧实现的 `"🔑🔑...🔑"`（按字节切出 2 个头 + 1 个尾字符）变为 8 个头 + 4 个尾字符。
- **翻译错误提示的截断上限由 80 字节变为 80 字符**（CJK 下最长 240 字节）。三处均为错误提示文案，已确认可接受。

## 待验收边界

本次未启动正式程序或完整 QA 桌面应用，未做真实粘贴/翻译失败路径的端到端验收，未检查托盘菜单在中文 Key 下的实际渲染。修复正确性由单元测试与反向探针证明，不替代桌面验收。

`is_api_key` 的检测语义（ASCII 限定、`\r`/`\t`、200/201 字节边界）**仍未测试**——本次按用户决定不改其行为，若将来要收紧需先补这些用例。

源码与评审清单已同步（[代码修复清单](../reviews/2026-10-10-code-fix-list.md) §2 P0-1、§3 P1-4 标为已修复），任务状态见 [TODO](../TODO.md)。
