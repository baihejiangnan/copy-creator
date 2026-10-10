# 随记状态机两处回归修复验证

2026-10-10，按用户指示「开始修吧」修复 `docs/reviews/2026-10-10-code-fix-list.md` 中的 **P1-5** 与 **P1-6**。接手时 main 已有 AGENTS、TODO、单实例/随记源码与历史记录的未提交修改，保留并增量合并。基础版本保持 0.2.28，未提交、推送、打包或发行。上一次同批次修复见 [UTF-8 字节切片 panic 修复验证](2026-10-10-utf8-truncation.md)（P0-1/P1-4，只改 Rust）。

## 问题

三条缺陷都属「状态在异步窗口内变陈旧」：

- **P1-5**：`copy-creator/src/App.tsx` 的 `open-note` 监听器取出并校验了 `detail.id`，随后**从未使用**，只做 `back()` + `feed.setQuery("ungrouped", "")`。从剪贴板「采集为便签」后不会打开刚采集的记录，且 `back()` 恰好踩中 P1-6 的顺序缺陷。
- **P1-6 a**：`copy-creator/src/lib/suiji.ts` 的 `organizeNote` 在 `:34`（`get_note`/`organize_note` 两次 IPC **之前**）捕获 `coordinator.activeNoteId`，并在 `:60` **无条件**写回。用户在这两个 await 期间改选另一条记录时，旧快照会覆盖新选择，把编辑器指针拉回已不处于编辑状态的记录；`NoteCoordinator.evictClean()`（`noteCoordinator.ts:319` `const index = clean.findIndex((s) => s.id !== this.activeId);`）依赖该指针正确，指针错误会让真正在编辑的会话失去保护。
- **P1-6 b**：`copy-creator/src/stores/notesWorkspace.ts` 的 `back()` 用 `void coordinator.flush(selectedId)` **未 await**，紧接着用 flush **之前**的 `session.status` 计算 `completed`，据此释放 `quickId`。写入尚未落地（或最终失败）时会被误判为已保存。

## 实现

- **P1-5**：`copy-creator/src/App.tsx` 的 `open-note` 回调改为 `await useNotesWorkspace.getState().open(id).catch(useNotesWorkspace.getState().setError);`，不再调用 `back()`。`open(id, expectedEpoch?)` 是既有实现（`notesWorkspace.ts:34-41`，含 epoch 校验与 `generation` 竞态守卫），此前全仓无调用者。错误经 `setError` 进入 store，不再静默。
- **P1-6 a**：`copy-creator/src/lib/suiji.ts` 的恢复行改为
  `if (activeId === id && coordinator.activeNoteId === null) coordinator.setActive(id);`
  两个条件分别排除「原本就不是这条」与「原本是这条、但用户在写入期间已改选别处」。
- **P1-6 b**：`copy-creator/src/stores/notesWorkspace.ts` 的 `back()` 改为把判断推迟到 flush 落地之后，并加并发守卫（`current.coordinator !== coordinator || current.selectedId !== selectedId` 时放弃拆除）。
- 未改动任何 Rust 文件、数据库 schema、迁移、锁/生命周期逻辑，也未动 `NoteCoordinator` 本身。

## 实际检查

Windows x64。本机 `pnpm` shim 当前不可用（`[pnpm] pnpm not found.`；`%APPDATA%\dsh-tauri\dependencies\pnpm\bin\pnpm.cjs` 不存在且 `$env:DSH_PNPM_BIN` 未设置），故下表用等价直接命令。

| 检查 | 结果 |
| --- | --- |
| `node --experimental-strip-types --test tests/*.test.ts` | **87 通过、0 失败**（`# tests 87 / # pass 87 / # fail 0`，11 个测试文件；修复前基线 84） |
| `node --experimental-strip-types --test tests/recordStateActions.test.ts` | 3 通过、0 失败 |
| `tsc -b --force` | exit 0 |
| `eslint .` | exit 0（新增测试文件已消除全部 `no-explicit-any`） |
| `vite build` | 成功，599ms；`PhrasePage-*.js` 290.34 kB、`clipboardStore-*.js` 185.24 kB、`main-*.js` 61.82 kB、`notes-*.js` 13.53 kB |
| `scripts/qa-process-isolation.ps1` | exit 0，`ownedQaNativeProcesses: 0` |
| `cargo test` | 未重跑（本轮只改前端 TS）；历史口径 173 通过 / 5 忽略 |
| `git diff --check` | exit 0 |

## 新增测试

新建 `copy-creator/tests/recordStateActions.test.ts`（3 例）。它用 VM 加载器驱动**真实的**源码（`readFileSync` → `ts.transpileModule` → `vm.runInNewContext`），只 stub 原生边界（`invoke`）与 `./notes`、`./lifecycle`、`./storageIdentity`、`./noteCoordinator` 四个协作者，因此测的是真实控制流而非复刻实现：

- `organizeNote keeps a selection made while the write was in flight`——在 `organize_note` 在途时把 `activeId` 改为第三条记录，断言旧快照不覆盖它。
- `organizeNote restores its own record when it was the active one`——该记录原本就是 active 且期间无人改选时仍保持 active。
- `back() releases the quick draft only after the flush settles as saved`——用受控 promise 卡住 `flush`，先断言 `selectedId` 未变，放行后断言 `selectedId === null` 且 `quickId === null`。

## 反向验证

这是本轮最重要的环节：**第一次的「修复」其实是假修复，是靠反向验证发现的。**

| 探针 | 结果 |
| --- | --- |
| 修复中途的写法 `coordinator.setActive(activeId === id ? id : activeId)`，改回 `coordinator.setActive(activeId)` | **仍然 3/3 全绿**。查明原因：两个分支的值都等于 `activeId`，与原实现在数学上完全等价——等于一行都没改。 |
| 同一探针下检查测试本身 | 当时的第一版测试让 `activeId = mine.id` 而整理的是另一个 id，`discard` 不会清空指针，缺陷版与修复版观测值相同 → **测试空转**。已重写为「写入在途时用户改选第三条记录」，真正复现缺陷路径。 |
| 用修正后的测试再探：`suiji.ts` 恢复行改回 `coordinator.setActive(activeId);` | 测试①**变红**（`a selection made during the write must not be clobbered by the pointer captured before it`），②③仍绿。已还原。 |
| `notesWorkspace.back()` 还原为 HEAD 原实现（`void coordinator.flush(...)` + 立即拆除） | 测试③**变红**（`back() must not tear down before the flush settles`），①②仍绿。已还原。 |

两次探针均已还原（`suiji.ts` 恢复行与 `notesWorkspace.ts` 的 `back()` 已确认恢复为修复后版本）。

## 行为变化

- **`back()` 现在异步生效**：拆除推迟到 flush 落地后的一个微任务，并带并发守卫。任何依赖「`back()` 后立刻 `selectedId === null`」的代码或测试都需先 `await` 一个 tick。已在清单 §3 P1-6 与 §9 标注。
- **`organizeNote` 不再无条件恢复指针**：仅当该记录原本是 active 且期间无人改选时放回；其余情况保持用户当前选择。
- **「采集为便签」改为打开目标记录**：由列表视图变为直接打开刚采集的便签。
- 对 ASCII 无关，无 schema、无存储合同、无保存屏障语义变化。

## 待验收边界

本次**未启动正式程序或完整 QA 桌面应用**，未做真实桌面交互验收：未跑 `pnpm exec tauri dev`，未实际点「采集为便签」，未手工验证「改分组后立刻返回、重开后分组仍在」，未做保存屏障与换库的联合回归。修复正确性由单元测试与两次反向探针证明，不替代桌面验收。

`changeNoteState` 与 `captureNote` 两条路径的同类顺序问题仍缺测试覆盖；`App.tsx` 的事件处理器本身仍无专属测试（本轮新增的 3 例覆盖的是 `lib/suiji.ts` 与 `stores/notesWorkspace.ts`）。

源码与评审清单已同步（[代码修复清单](../reviews/2026-10-10-code-fix-list.md) §3 P1-5/P1-6 标为已修复，§6.5 记录被推翻的结论），任务状态见 [TODO](../TODO.md)。
