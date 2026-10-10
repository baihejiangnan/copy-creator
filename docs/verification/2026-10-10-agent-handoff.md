# 2026-10-10 Agent 接手复核

## 基线与范围

接手时本地 `main` 为 `0746faa`（`feat: add jot records, single instance, and code-review fixes`），比本地跟踪的 `origin/main` 领先 1 个提交；未联网刷新远端。应用四处版本保持 0.2.28，schema 6、v4 备份已进入源码。提交共涉及 76 个文件；本次重点复核 UTF-8 修复、随记异步状态与分组/迁移身份保护，并重跑自动检查，不宣称已逐项完成全提交或桌面验收。

已有未提交修改为 `notes.rs`/`suiji.rs` 的锁内代次校验，以及未跟踪的 `output/`。保留既有修改和产物，在此基础上接手补丁；未提交、推送、调整版本或发行。

## 发现与接手修改

1. **遗留补丁不能编译。** `notes::check_epoch` 返回 `Result<u64, NoteError>`，两个随记分组命令返回 `Result<_, String>`；直接 `?` 导致两处 E0277。保留锁内复核和真实 epoch 回包，显式映射 `error.code.to_string()`，不引入泛化转换或输出内部错误。
2. **较早的返回回调取消新导航。** 原 `back()` 等待 flush 后只比较 coordinator 与 selectedId；新 `open()` 仍在读取时，selectedId 尚未变化（重新打开同一条时亦相同），旧回调会递增 generation、清除 opening，使新读取被当作过期响应。返回动作捕获导航代次，完成后必须仍为同一代才能拆除。新增同 ID/不同 ID 两条测试，并补一条保存失败时保留 quickId 与正文的测试。
3. **颜色元数据未参加迁移准入。** 目标仅有 `note_group_colors` 时旧准入检查会通过；同 ID 的 INSERT 约束失败返回 `notes.storageMigrationFailed`，不同 ID 会接受非空目标。现在提前返回 `notes.storageConflict`，保留目标摘要、颜色及原连接；有效暂存凭据的恢复重试不走此空库分支，原合同不变。新增内存数据库测试，分别覆盖同 ID 与不同 ID，检查完整目标 digest 不变。
4. **修正评审推断。** 分组命令从校验到操作结束持有 lifecycle producer 读许可；`drain_backend` 在切库前等待 producer 写许可，不能据“先验 epoch、后取连接锁”直接推断生产换库竞态。P1-7 降为一致性加固。P2-19 的同 ID 颜色不会被普通 INSERT 覆盖，事务会回滚；记录其真实准入缺口。
5. **修正文档交接。** TODO 当前交付位置更新为实际提交、schema/备份和测试基线；旧 QA 数字归入历史背景。随记设计同步实际打开捕获记录、导航守卫和目标颜色保护。

## 验证

命令在内层 `copy-creator/` 执行。Rust 的 TEMP/TMP 仅在子进程内指向仓库 `output/tmp-rust`；使用合成数据与内存/临时数据库。当前 pnpm 为 `C:\Users\ABD18\dev\nodejs\pnpm.ps1`，本轮可正常运行，旧 shim 故障记录仍属历史环境。

| 检查 | 实际结果 |
| --- | --- |
| 修复前前端定向测试 | 6 项中 4 通过、2 失败：同 ID/不同 ID 新导航均被旧 back 回调取消 |
| 修复前 Rust 定向测试 | 首先复现两处 E0277；修正错误类型后，颜色同 ID 用例复现错误分类 `storageMigrationFailed` 而非 `storageConflict` |
| `node --experimental-strip-types --test tests/*.test.ts` | 90 通过、0 失败（原 87，新增 3） |
| `cargo test --manifest-path src-tauri/Cargo.toml` | lib 174 通过、0 失败、5 忽略（原 173，新增 1，内部覆盖两种 ID）；main/doc-tests 0 项通过 |
| 最终迁移定向回归 | `storage::tests::target_with_only_group_colors_is_rejected_without_changes` 1/1 通过 |
| `pnpm exec tsc -b` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm exec vite build` | exit 0，384 modules，683ms；仅前端产物，不是桌面 Release |
| `scripts/qa-process-isolation.ps1` | exit 0，全部已知 QA 根目录 `ownedQaNativeProcesses=0`，未停止任何进程 |
| `git diff --check` | 通过 |
| 本轮五份文档的本地链接 | 232 个目标检查通过，无缺失文件；未检查远端 URL 或章节锚点 |

Rust 有一条 linker 创建 import library 的提示，不影响检查通过。新增前端测试先在原实现失败、修复后通过；无需靠修改共享工作区回退他人补丁证明缺陷。

## 待接手边界

- **下一优先项为 P1-1**：轮盘仍通过 phraseStore/get_phrases 读取已由 schema 6 提升并清空的旧短语表，主窗新随记不会进入轮盘。需将轮盘接到随记的有界摘要读取和既有粘贴/存储身份合同，保留分组；随后做隔离桌面回归。
- P1-2 原生 API Key 类型限制及其他清单项继续按实际调用链逐项复核；不因清单编号直接采纳行为变更。
- `App.tsx` 的 open-note 处理器仍缺专属事件测试；本轮导航用例驱动真实 workspace 源码，不覆盖整个 React 事件入口。分组代次补丁已通过编译及 Rust 全量回归，仍缺真实 IPC 换库联合验收。
- 本轮未启动应用、未访问真实用户数据库/密码箱/备份，未进行系统剪贴板、快捷键、焦点、DPI、MSI 或 UAC 交互验收；未重新测量性能、内存、EXE/安装包体积。原 TODO 未完成项保持。
