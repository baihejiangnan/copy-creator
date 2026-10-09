# 推送与 Release 发布规则

本规则供接手提交、推送和发布的 Agent 使用。通用约束见 [AGENTS.md](../../AGENTS.md)，验收状态以 [TODO](../TODO.md) 为准；用户在当次任务中明确指定的仓库、分支、版本或发布范围优先。

## 1. 历史依据与默认方式

2026-10-07 只读核对本地 Git 历史及 GitHub API：个人仓库目前只有一次公开 Release。以下区分已经发生的做法和补充的执行要求，不把一次发布推断成多次惯例。

| 项目 | 已核实的历史事实 |
| --- | --- |
| 个人仓库 | `origin`：`https://github.com/baihejiangnan/copy-creator.git` |
| 上游仓库 | `upstream`：`https://github.com/hu-qi-jia/copy-creator.git` |
| 主分支 | `main`；核对时本地 HEAD 与远端 main 均为 `2fca6982357dc604de640b0e35056873fac6390f` |
| 个人版发布 | [Copy Creator 0.2.24 个人增强版](https://github.com/baihejiangnan/copy-creator/releases/tag/v0.2.24-baihejiangnan.1)，2026-09-24 发布 |
| 标签与源码 | `v0.2.24-baihejiangnan.1` 指向 `d467aa2ec4d3f6a0df3c4c19f6cb1eaf54059453`；后续 README/截图提交 `2fca698` 未另发 Release |
| 附件 | 仅 `Copy-Creator-0.2.24-portable.exe`，73,967,616 字节 |
| 发布说明 | 中文描述个人增强内容、便携用法和实际检查结果 |
| 提交风格 | `feat:`、`fix:`、`perf:`、`refactor:`、`docs:`、`chore:`；版本提交已有 `chore: release v0.2.24` 示例 |
| 自动化 | 本地无 `.github/workflows/`；远端 Actions workflows 数量为 0，不能假设推送或打标签会自动编译发布 |

默认延续：源码更新到个人仓库 `origin/main`；需要发布时在本地通过 Tauri CLI 构建 Windows 便携 EXE，再上传个人仓库 Release。历史记录不足以确认当时的具体构建命令、签名状态和全部桌面验收结果；后续步骤属于本规则补充的执行要求。

## 2. 先判断授权范围

| 用户任务 | 应执行的范围 |
| --- | --- |
| “提交并推送”“更新远端仓库” | 检查、验证、提交并推送对应源码/文档；不自动改版本、打发布标签或创建 Release |
| “编译”“构建便携版/安装包” | 生成并验证本地产物；不自动推送或公开发布 |
| “推送并发布新版 Release” | 完成版本更新、检查、源码提交、构建验证、推送、标签和 Release 发布 |
| “创建草稿 Release”或“发布预览版” | 保持草稿或设置 prerelease，不自行转正式版 |

完整发布已得到授权时，连续完成常规步骤，不重复请求确认；目标、范围或版本策略实质变化时才澄清。仅更新源码时可以推送仍在开发中的进度，但须保留 TODO 中的验收缺口，不能报告成正式发布验收通过。

## 3. 提交与推送

1. 在仓库根目录检查分支、`git status --short`、`git diff`、`git diff --cached`、远端 URL、最近提交和 TODO；检查未跟踪文件，保护用户及其他 Agent 的修改。
2. 查询 `gh release list --repo baihejiangnan/copy-creator`；`git fetch origin --prune` 后比较本地与远端。未完成的开发工作区不直接 pull、切分支或 rebase，避免混入或改写他人修改。
3. 默认将本次授权范围内、整理且验证过的修改更新到 `origin/main`。当前在功能分支时先核对集成方式，不误推为 main；需要新建开发分支时沿用 `codex/` 前缀。历史既有直接 main 提交，也有上游 PR 合并，不据此强制个人仓库更新都走 PR。
4. 按职责组织提交，沿用既有前缀，中文英文均可；版本调整可独立提交为 `chore: release v<应用版本>`。逐项审查后暂存，避免未审查的 `git add .` / `git add -A`。字体移出 public 等成组变化要同时纳入原路径删除和新文件。
5. 不提交 `node_modules/`、`dist/`、`target/`、根目录 `releases/`、优化快照、临时日志、用户数据库、备份或真实密钥；需要版本管理的原始素材和隔离测试脚本应保留。
6. 推送前检查暂存 diff 和 `git diff --cached --check`，运行与改动相应的检查。确认 main 与最新 origin/main 的关系后正常快进推送 `git push origin main`；不向 upstream 推送，不默认强推、改写历史或绕过分支保护。
7. 非快进或远端有新提交时重新 fetch、核对并安全集成，重新运行受影响检查；不能用强推解决。推送后查询远端 SHA，确认包含预期提交。

## 4. 版本与标签

- 同步维护 `copy-creator/package.json`、`copy-creator/src-tauri/tauri.conf.json`、`copy-creator/src-tauri/Cargo.toml` 和 `Cargo.lock` 中本项目包的版本，不误替换依赖版本。`pnpm-lock.yaml` 的工具生成变化一并审查；当前格式没有独立根项目 version 字段。
- 默认沿用标签 `v<应用版本>-baihejiangnan.<发布序号>`、标题 `Copy Creator <应用版本> 个人增强版`、附件 `Copy-Creator-<应用版本>-portable.exe`。如应用 `0.2.25`、标签 `v0.2.25-baihejiangnan.1`，仅作格式示例，不代表已指定下次版本。
- **每次发布新的可升级二进制，都必须提高应用基础版本。** 当前更新逻辑取运行中的 Tauri 版本，与 Release 标签做语义版本比较。`0.2.24-baihejiangnan.2` 低于已安装的 `0.2.24`，单独递增个人版尾缀不会提示升级；`+build` 元数据也不能触发升级。依据见 [updates.rs](../../copy-creator/src-tauri/src/updates.rs) 与 [更新说明](updates.md)。
- 沿用历史命名时，应用使用基础版本，Release 使用对应个人版后缀。后缀具有 SemVer 预发布排序含义，但 GitHub 正式发布状态由 `draft` / `prerelease` 标记决定。
- 发版前查询远端相关标签及正式 Release，确认标签不存在、新版本高于已分发的应用版本。用户指定版本若无法触发预期升级，先指出具体冲突。
- 不移动既有发布标签，不覆盖已公开的同名二进制。源码修复或重新构建导致二进制变化时发布更高基础版本；纯说明/链接勘误可编辑原说明，不换附件。

## 5. 构建与验证

应用工程在内层 `copy-creator/`。从明确、已提交且可追溯的 SHA 构建；共享工作区仍在变化时使用干净的隔离检出，不能混入未提交修改，也不能清理他人的工作区来制造“干净”。

记录源码 SHA、Windows 版本、CPU 架构/目标 triple、Node/pnpm/Rust/Tauri 版本和实际命令。依赖以锁文件为准，使用 `pnpm install --frozen-lockfile`；不为发布顺手升级依赖或改 identifier。Cargo 使用现有锁文件，确认构建无意外锁文件变化。

应用源码 Release 的基本检查从内层目录执行；每条成功后继续，失败不能被后续成功掩盖：

```powershell
pnpm exec tsc -b
pnpm test:unit
pnpm lint
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

历史失败须记录具体输出，不得写“全部通过”；未解决失败说明对本次发布的影响，缺乏发布依据时保持草稿。仅文档推送按 AGENTS.md 检查链接、事实和 diff，无需完整构建。

默认只发布便携 EXE，可执行：

```powershell
pnpm exec tauri build --no-bundle -- --locked
```

本地 CLI 已确认支持 `--no-bundle` 和向 Cargo 传参；仍执行 `beforeBuildCommand` 中的 `pnpm build`，生成嵌入前端资源的生产 EXE。需要安装包时执行：

```powershell
pnpm exec tauri build -- --locked
```

当前 `bundle.targets = "all"`，Windows 可生成 NSIS/MSI；仅任务要求发布安装包时上传这些附件。`pnpm build` 的 dist、debug EXE 或直接 `cargo build --release` 的未核实资源产物，不能替代正式桌面构建。

默认 EXE 路径为 `src-tauri/target/release/copy-creator.exe`，安装包在其 `bundle/`；指定 target 或 `CARGO_TARGET_DIR` 后路径会变化，以日志确认。将本次新生成的 EXE 复制到根目录 `releases/<标签>/` 并按规则命名，不从旧目录挑同名产物。记录字节数和 SHA-256，可用 `Get-FileHash -Algorithm SHA256 -LiteralPath <产物绝对路径>`。

发布前验证待上传的最终 EXE，使用临时数据库、合成内容和隔离测试环境，不访问真实用户资料。覆盖启动/托盘、主窗/轮盘、快捷键/粘贴、图片、设置/更新入口及本次相关功能；涉及便签/保存/备份/搬迁时按 TODO 和设计收齐联合验收。生产构建通过不能替代桌面检查。

便携表示无需安装程序，不承诺数据在 EXE 同目录，也不承诺免除 WebView2 等运行依赖。未验证的安装包/架构不宣称已支持。性能发布分别报告前端资源、EXE/安装包和 Release 运行指标，不将前端缩减量直接写成 EXE 或内存收益。

## 6. 发布顺序与说明

1. 确定范围、应用版本、标签和说明，同步 TODO/验证记录及受影响文档。README 中英文的版本、附件名、链接一致，不把旧版附件描述成新版。
2. 完成源码及版本提交、固定完整 SHA，从该 SHA 构建验证并记录产物大小/哈希。后续改变源码、版本、配置或资源时重新构建验证；只补验证记录/下载文档时可另作文档提交，明确二进制仍对应原构建 SHA。
3. 推送整理后的 main，确认远端包含构建 SHA；标签指向实际构建 SHA，不随手标在后来的 HEAD。默认新建带说明的标签；历史个人版为轻量标签，附注标签属于补充追溯要求。只推本次标签，不用 `git push --tags` 批量上传其他标签。
4. 使用 `gh release create` 创建草稿，显式指定 `--repo baihejiangnan/copy-creator`、`--verify-tag`、实际目标 SHA 和准备好的说明文件，上传本次验证的附件。`--verify-tag` 避免 CLI 自动创建错误标签；多行说明使用 UTF-8 文件与 `--notes-file`。
5. 核对草稿标签解析后的源码 SHA、正文、附件名/大小/摘要及下载目标。已授权正式发布且验收满足时转公开正式版（`draft=false`、`prerelease=false`），确认是仓库 Latest；草稿/预览版不作为正式更新源。
6. 发布后核对 Release 页面、附件状态及 `/releases/latest` 的标签/URL；对照本地 SHA-256 与远端资产摘要，摘要缺失时实际下载校验。验证旧版能发现新版、新版不误提示升级、下载入口正确。完成后才报告“已发布”；部分成功分别报告源码、标签、草稿和附件状态。

README 下载区使用本次确定的标签和附件名；发布前链接属于待生效。发布失败时及时说明并修正文档，不能长期把不可用链接标为最新版。

发布说明延续中文、面向使用者的形式，包含：

- 本次新增/修复/优化及具体影响，只写进入本次二进制的功能。
- Windows/架构要求、附件名和使用方式；涉及迁移、兼容或不可逆数据升级时说明升级要求。
- 实际检查和桌面验证范围、影响使用的已知问题，不照抄上次测试数量。
- 来源完整 SHA、产物字节数和 SHA-256。

未完成的首发可靠性验收不能靠写“待验证”绕过。开发源码可先推送；未满足发布门槛的构建保留本地、草稿，或按明确授权发布预览版。

## 7. 异常与交付

- 推送/上传失败先查询远端实际状态，避免重复创建。同名标签须解析到 commit SHA 再比较，附注标签对象 SHA 不能直接当源码 SHA。
- 标签已指向其他源码时停止复用并报告，不删除、强推或重新指向。公开版本有问题优先发更高版本修复；撤回/删除 Release 不默认执行。
- 构建中断、安装包失败、桌面验证未做如实记录；便携版成功与安装包成功分别判断。
- 交付包含仓库/分支、已推送 SHA、应用版本/标签、构建命令/平台、附件路径或下载链接/大小/哈希、验证和剩余问题、Release URL 及草稿/预览/正式状态。未执行步骤明确注明。

## 8. 可直接转交给执行 Agent 的指令

> 请先阅读 AGENTS.md、docs/TODO.md 和 docs/features/release-rules.md，检查工作区、远端 main 和历史 Release，保留用户及其他 Agent 的修改。按我本次指定范围整理提交并更新 `origin/main`，不要向 upstream 推送。仅要求推送源码时，完成对应验证、提交、推送和远端 SHA 核对；同时要求发布 Release 时，按规则提高基础版本、从固定源码 SHA 构建并验证 Windows 便携 EXE，将标签绑定实际构建 SHA，创建并检查草稿后完成已授权的正式发布。不得用旧产物替代，不得仅递增个人版尾缀，不得把未验收功能写成已完成；最后报告真实提交、产物、验证和发布状态。
