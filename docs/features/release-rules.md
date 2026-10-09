# 推送与 Release 发布规则

本规则供接手提交、推送和发布的 Agent 使用。通用约束见 [AGENTS.md](../../AGENTS.md)，验收状态以 [TODO](../TODO.md) 为准；用户在当次任务中明确指定的仓库、分支、版本或发布范围优先。

当前默认流程（2026-10-09 复核）：整理授权范围内的源码 → 固定提交与基础版本 → 从干净检出运行签名发行脚本 → 核验本地产物与相应桌面行为 → 按授权推送源码/标签 → 创建并核对草稿 → 已授权时公开并验证下载。包含新更新客户端的发行使用 §9 的 **EXE、MSI、两个签名、latest.json 和 SHA256SUMS.txt**；“推送并打包”只执行源码推送与本地构建，不自动创建或公开 Release。§1 为历史事实，§5/§8/§9 为当前执行入口。

## 1. 历史依据与默认方式

2026-10-07 的首次只读核对时，个人仓库只有 0.2.24 一次公开 Release；下表保留当时快照。2026-10-09 复核已有 0.2.24、0.2.25 两次公开 Release，当前 Latest 是 [0.2.25](https://github.com/baihejiangnan/copy-creator/releases/tag/v0.2.25-baihejiangnan.1)，构建源码 `8e76dabee6099ddd98c9a1fe475bf34d17eee5d5`，仅发布便携 EXE。详情见 [0.2.25 发布记录](../verification/2026-10-09-release-025.md)。这些历史发布不代表本轮签名客户端已经发布。

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

历史默认：源码更新到个人仓库 `origin/main`；需要发布时在本地通过 Tauri CLI 构建 Windows 便携 EXE，再上传个人仓库 Release。历史记录不足以确认当时的具体构建命令、签名状态和全部桌面验收结果。2026-10-09 已接入公开元数据与签名下载；后续发行带该客户端的新版本时，使用 §9 的六文件签名流程，发布授权范围仍按 §2 判断。

## 2. 先判断授权范围

| 用户任务 | 应执行的范围 |
| --- | --- |
| “提交并推送”“更新远端仓库” | 检查、验证、提交并推送对应源码/文档；不自动改版本、打发布标签或创建 Release |
| “编译”“构建便携版/安装包” | 生成并验证本地产物；不自动推送或公开发布 |
| “推送更新并打包” | 整理、验证、提交并推送源码，同时生成本地产物；不自动推送发布标签、创建或公开 Release |
| “推送并发布新版 Release” | 完成版本更新、检查、源码提交、构建验证、推送、标签和 Release 发布 |
| “创建草稿 Release”或“发布预览版” | 保持草稿或设置 prerelease，不自行转正式版 |

完整发布已得到授权时，连续完成常规步骤，不重复请求确认；目标、范围或版本策略实质变化时才澄清。仅更新源码时可以推送仍在开发中的进度，但须保留 TODO 中的验收缺口，不能报告成正式发布验收通过。

## 3. 提交与推送

1. 在仓库根目录检查分支、`git status --short`、`git diff`、`git diff --cached`、远端 URL、最近提交和 TODO；检查未跟踪文件，保护用户及其他 Agent 的修改。
2. 查询 `gh release list --repo baihejiangnan/copy-creator`；`git fetch origin --prune` 后比较本地与远端。未完成的开发工作区不直接 pull、切分支或 rebase，避免混入或改写他人修改。
3. 默认将本次授权范围内、整理且验证过的修改更新到 `origin/main`。当前在功能分支时先核对集成方式，不误推为 main；需要新建开发分支时沿用 `codex/` 前缀。历史既有直接 main 提交，也有上游 PR 合并，不据此强制个人仓库更新都走 PR。
4. 按职责组织提交，沿用既有前缀，中文英文均可；版本调整可独立提交为 `chore: release v<应用版本>`。逐项审查后暂存，避免未审查的 `git add .` / `git add -A`。字体移出 public 等成组变化要同时纳入原路径删除和新文件。
5. 不提交 `node_modules/`、`dist/`、`target/`（含独立验证器的 target）、根目录 `releases/`、优化快照、临时日志、用户数据库、备份或真实私钥；需要版本管理的原始素材和隔离测试脚本应保留。签名客户端的 `updater.pub`、签名合成夹具、`.gitattributes`、WiX fragment、验证器源码/锁文件和发行脚本是必要源码，须随授权改动提交；公开公钥与测试签名不属于私钥。
6. 推送前检查暂存 diff 和 `git diff --cached --check`，运行与改动相应的检查。确认 main 与最新 origin/main 的关系后正常快进推送 `git push origin main`；不向 upstream 推送，不默认强推、改写历史或绕过分支保护。
7. 非快进或远端有新提交时重新 fetch、核对并安全集成，重新运行受影响检查；不能用强推解决。推送后查询远端 SHA，确认包含预期提交。

## 4. 版本与标签

- 同步维护 `copy-creator/package.json`、`copy-creator/src-tauri/tauri.conf.json`、`copy-creator/src-tauri/Cargo.toml` 和 `Cargo.lock` 中本项目包的版本，不误替换依赖版本。`pnpm-lock.yaml` 的工具生成变化一并审查；当前格式没有独立根项目 version 字段。
- 默认沿用标签 `v<应用版本>-baihejiangnan.<发布序号>`、标题 `Copy Creator <应用版本> 个人增强版`，签名发行的六个附件见 §9。个人版后缀须为无前导零的正 32 位整数。下次版本由当次授权范围和最终改动确定，不复用已公开的 `0.2.25`；如采用下一补丁版本，仍须先核对远端没有占用对应版本/标签。
- **每次发布新的可升级二进制，都必须提高应用基础版本。** 已发布的旧客户端比较 Release 标签；本次新客户端比较 `latest.json.version` 与运行中的 Tauri 版本，`tag` 单独保留个人版标签。单独递增个人版尾缀或 `+build` 元数据不能让相同基础版本触发升级。新元数据的 `version` 必须与 EXE/MSI 的基础版本一致。依据见 [updates.rs](../../copy-creator/src-tauri/src/updates.rs) 与 [更新说明](updates.md)。
- 沿用历史命名时，应用使用基础版本，Release 使用对应个人版后缀。后缀具有 SemVer 预发布排序含义，但 GitHub 正式发布状态由 `draft` / `prerelease` 标记决定。
- 发版前查询远端相关标签及正式 Release，确认标签不存在、新版本高于已分发的应用版本。用户指定版本若无法触发预期升级，先指出具体冲突。
- 不移动既有发布标签，不覆盖已公开的同名二进制。源码修复或重新构建导致二进制变化时发布更高基础版本；纯说明/链接勘误可编辑原说明，不换附件。

## 5. 构建与验证

应用工程在内层 `copy-creator/`。从明确、已提交且可追溯的 SHA 构建；共享工作区仍在变化时使用干净的隔离检出，不能混入未提交修改，也不能清理他人的工作区来制造“干净”。本轮更新与终端权限改动仍有未提交文件，后继先审查和归并授权内容，不能复用 15:51 的签名验证产物作为后续完整工作区的新构建。两个任务的证据与剩余范围见 [签名更新验证](../verification/2026-10-09-signed-updates.md)、[终端权限验证](../verification/2026-10-09-terminal-permissions.md)。

记录源码 SHA、Windows 版本、CPU 架构/目标 triple、Node/pnpm/Rust/Tauri 版本和实际命令。依赖以锁文件为准，使用 `pnpm install --frozen-lockfile`；不为发布顺手升级依赖或改 identifier。Cargo 使用现有锁文件，确认构建无意外锁文件变化。

应用源码 Release 的基本检查从内层目录执行；每条成功后继续，失败不能被后续成功掩盖：

```powershell
pnpm exec tsc -b
pnpm test:unit
pnpm lint
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

历史失败须记录具体输出，不得写“全部通过”；未解决失败说明对本次发布的影响，缺乏发布依据时保持草稿。仅文档推送按 AGENTS.md 检查链接、事实和 diff，无需完整构建。

**当前默认打包入口是 §9 的 `pnpm release:windows`。** 它调用正式 Tauri 构建生成 MSI 与同次便携 EXE，再分别签名和校验；脚本本身不推送源码、不打标签、不创建 Release。正常签名打包已包含上述类型、前端测试、lint、Rust lib 单测及前端构建，无需在没有变化的情况下重复整套检查；需要完整 Cargo 默认测试目标或桌面检查时另按范围执行。

只有用户明确要求单独构建便携 EXE、且不准备六文件更新发行时，使用以下直接 CLI 命令作为本地构建：

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle --ci -- --locked
```

该命令仍执行 `beforeBuildCommand` 中的 `pnpm build`，生成嵌入前端资源的生产 EXE。本机 pnpm 11.7.0 的 `exec` 曾剥离 Cargo 分隔符并被 CLI 拒绝，因此文档和签名脚本均直接调用已安装的 Tauri CLI node 入口。依赖已缓存且任务需要离线构建时才添加 Cargo `--offline`，不以它代替冻结依赖。明确需要额外 NSIS 本地产物时，可执行：

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --ci --bundles nsis -- --locked
```

当前 `bundle.targets = "all"`，Windows 可生成 NSIS/MSI，但签名脚本显式选择 MSI；签名客户端的安装平台入口不支持用 NSIS 替换 MSI。NSIS 仅在用户要求时额外构建/发布，不混入六文件目录。`pnpm build` 的 dist、debug EXE 或直接 `cargo build --release` 的未核实资源产物，不能替代正式桌面构建。

默认 EXE 路径为 `src-tauri/target/release/copy-creator.exe`，安装包在其 `bundle/`；签名脚本会复制和校验本次产物到 `releases/<标签>-<唯一 ID>/`，以本次成功摘要中的 `directory` 为准，不从旧目录挑同名文件。指定 target 或 `CARGO_TARGET_DIR` 后路径会变化，当前脚本的环境限制见 §9。记录字节数和 SHA-256，可用 `Get-FileHash -Algorithm SHA256 -LiteralPath <产物绝对路径>`。

发布前验证待上传的最终 EXE，使用临时数据库、合成内容和隔离测试环境，不访问真实用户资料。覆盖启动/托盘、主窗/轮盘、快捷键/粘贴、图片、设置/更新入口及本次相关功能；涉及便签/保存/备份/搬迁时按 TODO 和设计收齐联合验收。生产构建通过不能替代桌面检查。

便携表示无需安装程序，不承诺数据在 EXE 同目录，也不承诺免除 WebView2 等运行依赖。未验证的安装包/架构不宣称已支持。性能发布分别报告前端资源、EXE/安装包和 Release 运行指标，不将前端缩减量直接写成 EXE 或内存收益。

## 6. 发布顺序与说明

1. 确定范围、应用版本、标签和说明，同步 TODO/验证记录及受影响文档。README 中英文的版本、附件名、链接一致，不把旧版附件描述成新版。
2. 完成源码及版本提交、固定完整 SHA，从该 SHA 构建验证并记录产物大小/哈希。后续改变源码、版本、配置或资源时重新构建验证；只补验证记录/下载文档时可另作文档提交，明确二进制仍对应原构建 SHA。
3. 推送整理后的 main，确认远端包含构建 SHA；标签指向实际构建 SHA，不随手标在后来的 HEAD。默认新建带说明的标签；历史个人版为轻量标签，附注标签属于补充追溯要求。只推本次标签，不用 `git push --tags` 批量上传其他标签。
4. 使用 `gh release create` 创建草稿，显式指定 `--repo baihejiangnan/copy-creator`、`--verify-tag`、实际目标 SHA 和准备好的说明文件，上传本次验证的附件。`--verify-tag` 避免 CLI 自动创建错误标签；多行说明使用 UTF-8 文件与 `--notes-file`。
5. 核对草稿标签解析后的源码 SHA、正文、六个附件名/大小/摘要、两个平台的独立签名及下载目标。已授权正式发布且满足当次交付条件时转公开正式版（`draft=false`、`prerelease=false`），显式设置为 Latest 并核对结果；草稿/预览版不作为正式更新源。不把额外日志、溯源或 QA 文件用通配符一并上传。
6. 发布后核对 Release 页面、附件状态及 `/releases/latest` 的标签/URL；对照本地 SHA-256 与远端资产摘要，摘要缺失时实际下载校验。验证旧版能发现新版、新版不误提示升级、下载入口正确。完成后才报告“已发布”；部分成功分别报告源码、标签、草稿和附件状态。

README 下载区使用本次确定的标签和附件名；发布前链接属于待生效。发布失败时及时说明并修正文档，不能长期把不可用链接标为最新版。

发布说明延续中文、面向使用者的形式，包含：

- 本次新增/修复/优化及具体影响，只写进入本次二进制的功能。
- Windows/架构要求、附件名和使用方式；涉及迁移、兼容或不可逆数据升级时说明升级要求。
- 实际检查和桌面验证范围、影响使用的已知问题，不照抄上次测试数量。
- 来源完整 SHA、产物字节数和 SHA-256。

开发源码与本地产物可以先交付，验收未完成默认保留本地或草稿。只有用户已明确接受本次列出的已知问题并授权相应公开发布时，才按该授权继续；如 0.2.25 的明确取舍，只代表那次发布，不自动延伸到新增签名升级/MSI/UAC 的未验收链路。公开状态不等于 TODO 验收通过，说明必须保留实际边界；授权范围已清楚时不重复询问。

## 7. 异常与交付

- 推送/上传失败先查询远端实际状态，避免重复创建。同名标签须解析到 commit SHA 再比较，附注标签对象 SHA 不能直接当源码 SHA。
- 标签已指向其他源码时停止复用并报告，不删除、强推或重新指向。公开版本有问题优先发更高版本修复；撤回/删除 Release 不默认执行。
- 构建中断、安装包失败、桌面验证未做如实记录；便携版成功与安装包成功分别判断。
- 交付包含仓库/分支、已推送 SHA、应用版本/标签、构建命令/平台、附件路径或下载链接/大小/哈希、验证和剩余问题、Release URL 及草稿/预览/正式状态。未执行步骤明确注明。

## 8. 可直接转交给执行 Agent 的指令

按实际授权复制下面对应的一段；模板本身不扩大用户的任务范围。

**推送源码并本地打包：**

> 请按 AGENTS.md、docs/TODO.md 和 docs/features/release-rules.md 整理本次授权改动，审查未跟踪文件与并行任务修改，验证后提交并推送到 origin/main。需要对外分发的新二进制时按 §4 确定未占用的新基础版本，并同步四处版本。固定源码 SHA，从干净检出按 §9 运行 release:windows，生成并验证 EXE、MSI、两个签名、latest.json 和 SHA256SUMS.txt；不用 -AllowDirty 的产物替代正式构建。保留签名更新、终端权限和原有功能的验收边界；报告远端源码 SHA、本地产物目录、哈希、检查和剩余项。本次不推发布标签、不创建或公开 Release，不向 upstream 推送。

**已授权推送并公开新版 Release：**

> 请按 AGENTS.md、docs/TODO.md 和 docs/features/release-rules.md 完成本次授权的新版本源码与文档归并、版本更新、验证、提交和 origin/main 推送。从固定 SHA 的干净检出按 §9 构建并核验六个签名发行文件，完成当次要求的桌面验收。将本次新标签绑定实际构建 SHA，创建并核对草稿，再按已明确的发布授权转为公开正式 Latest。匿名独立下载并验签远端两包，核对 metadata/hash/Latest；区分旧 0.2.25 手动过渡和已有新客户端的升级验证。公开未验收部分只按本次已明确接受的边界处理，不把状态写成验收通过。不要复用旧验证产物、移动标签、强推或向 upstream 推送；报告真实提交、标签、六文件、检查和公开状态。

## 9. 签名更新发行准备（2026-10-09 接入）

开发源码已接入 [公开元数据与签名下载协议](updates.md)。以下流程用于后续新版本；不修改已公开的 0.2.25，也不把本次本地验证产物当作那个标签的附件。正式发行仍按前文的源码固定、桌面验收、授权范围、草稿检查和公开核验执行。

### 密钥与构建

受信任公钥在 `copy-creator/src-tauri/updater.pub`，key ID 为 `249F2915B7BBC0DC`。匹配私钥仅保存在发行环境，默认本机位置为 `%USERPROFILE%/.tauri/copy-creator-updater.key`；也可设置 `TAURI_SIGNING_PRIVATE_KEY_PATH` 或 CI secret `TAURI_SIGNING_PRIVATE_KEY`，密码由 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 提供。脚本不创建或替换密钥，私钥、密码不得进入仓库、文档、日志和发行文件。保留这次生成的密钥并在安全位置备份，丢失后旧客户端无法信任新密钥签名的包。

从内层应用目录使用 PowerShell 7 和已锁定依赖：

```powershell
pnpm release:windows -NotesFile '<UTF-8 发行说明文件>' -Tag 'v<新基础版本>-baihejiangnan.1'
```

默认要求干净的已提交源码，package.json、Cargo.toml 与 Tauri 配置使用同一新基础版本；标签允许 `v<version>` 或基础版本相同的个人版正整数后缀。脚本运行类型检查、前端逻辑测试、完整 lint、Rust 单测与正式 Tauri MSI 构建，再从同次构建复制便携 EXE。它检查 MSI ProductVersion 和安装模式 registry component，但不会安装 MSI。

脚本的当前环境合同：Windows x64 原生构建、PowerShell 7 的 `pwsh` 已在 PATH、pnpm/Node/Rust/MSVC 与 WindowsInstaller COM 可用；先 `pnpm install --frozen-lockfile`。不指定 Cargo target，不使用自定义 `CARGO_TARGET_DIR` / `CARGO_BUILD_TARGET` 或 `.cargo/config.toml` 的自定义 target-dir/build.target；脚本固定读取默认 target 路径及中文 x64 MSI 名，不能在这些设置存在时猜测或拿旧文件凑齐。若确需其他目标，先适配并验证脚本。独立验证器有自己的 Cargo.lock，其 package 版本 0.1.0 不随应用发布版本递增。

NotesFile 使用绝对路径最清楚；准备在已提交文档位置或仓库外/忽略的发行准备目录，避免临时说明文件让干净源码检查失败。签名命令默认使用本机现有密钥，另一个 Agent 在此机器使用同一路径即可；新的检出不会自动带走私钥。构建期间不要修改源码或生成新的提交；保存脚本实际 exit code、sourceCommit 和输出目录，完工再次核对 HEAD 与构建 SHA、Git 状态。日志与溯源放在六文件目录外。

干净构建目录须是能正确解析该仓库 HEAD 的 Git 检出（如独立 clone 或受管 worktree）。旧 0.2.25 曾从 Git archive 提取构建，但当前签名脚本会查询 Git 状态和 HEAD，不能直接在无 Git 元数据的 archive 导出目录运行。其他 Agent 仍在共享目录工作时从固定提交创建独立检出，不重置、清空或 stash 掉他们的未提交内容。

`-AllowDirty` 仅用于本地实现验证：输出目录带 `validation-` 和唯一 ID，`validationOnly=true`，摘要中的 HEAD 不是未提交二进制的完整来源。不得给这些产物打正式标签、上传或宣称对应固定提交。后续提交最终源码后必须重新构建。当前脚本只准备产物，不执行 git 推送或 Release 创建。

### 六个发行文件

每次输出到根目录 `releases/<标签>-<唯一 ID>/`，准确包含：

| 文件 | 用途 |
| --- | --- |
| `Copy-Creator-<version>-portable.exe` | 手动分发的便携程序，并兼容 0.2.26/0.2.27 的便携更新入口；统一 MSI 的新客户端不通过此文件更新 |
| `Copy-Creator-<version>-portable.exe.sig` | EXE 自身的 Tauri/minisign 签名 |
| `Copy-Creator_<version>_x64.msi` | Windows x64 MSI |
| `Copy-Creator_<version>_x64.msi.sig` | MSI 自身的签名 |
| `latest.json` | UTF-8 无 BOM 元数据；基础版本、标签、纯文本说明、UTC 日期、两个平台各自的 URL/签名/实际大小 |
| `SHA256SUMS.txt` | 前五个文件的 SHA-256 清单 |

独立 `src-tauri/update-verifier/` 使用与客户端相同的流式验证源码和公钥。构建脚本验签两个最终文件，并对各自的一字节篡改副本确认拒绝；最后检查六文件清单、元数据、大小、签名和哈希。可单独复核本地目录：

```powershell
pwsh -NoProfile -File ../scripts/verify-update-release.ps1 -Directory '<六文件目录>' -Verifier './src-tauri/update-verifier/target/debug/copy-creator-update-verifier.exe'
```

### 发布与独立下载验收

经过授权且满足相应发行门槛后，将六个文件上传同一个草稿 Release；标签绑定实际新基础版本构建 SHA，说明与 NotesFile 保持一致，核对后转公开正式 Latest。只有公开 Latest 才供客户端检查，不用它充当私有测试频道。

发布后用匿名 HTTPS 从 `/releases/latest/download/latest.json` 下载元数据，并从其中的两个固定资产 URL 下载程序、各自 `.sig` 和 `SHA256SUMS.txt` 到独立核验目录。使用上面的验证命令核对下载副本，另确认 latest 对应实际标签。远端有文件或本地验签成功不能代替这一步；保留 CDN/代理错误与重试证据。

独立核验目录只放这六个下载文件，不附带日志；从可信客户端源码构建验证器，不从待验证 Release 下载一个自称可信的验证器。只有 Release 发布/上传使用维护者的 gh 认证，公开下载不用 gh token、Authorization header 或客户端 Token。`$ErrorActionPreference` 不能保证原生程序失败即停止；pnpm/git/cargo/node/gh 与验证器每步检查 `$LASTEXITCODE`，失败停止依赖步骤。`verify-update-release.ps1` 是本地文件验证，不会下载、安装或核验远端状态。

再用已有新客户端检查更高版本、下载/验签/显式升级，用新版检查自身不提示升级。统一 MSI 的客户端须分别验证便携首次 MSI 向导、安装版原目录升级/进度/完成后启动、旧进程退出/新版快捷键可用及安装/升级/卸载标记，并验证自动/手动发现新版的红点。用合成数据库核对便签/设置保存失败与超时不启动安装。已发布 0.2.26/0.2.27 仍按运行模式选择 EXE/MSI，不能把新源码的统一 MSI 行为写成旧客户端升级操作的行为。旧 0.2.25 仍使用 REST 检查，须先手动升级一次；旧 NSIS 与没有新标记的 MSI 先手动过渡，不宣称支持跨安装方式的自动迁移。

本次本地结果及未执行的公开、安装与桌面联合范围见 [签名更新验证](../verification/2026-10-09-signed-updates.md)。
