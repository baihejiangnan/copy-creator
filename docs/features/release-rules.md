# 推送与 Release 发布规则

本文件供 Agent 顺序执行。通用约束见 [AGENTS.md](../../AGENTS.md)，任务和待验收项见 [TODO](../TODO.md)；详细更新行为见 [更新说明](updates.md)，环境问题按 §7 的入口查阅。

**主流程：检查 → 提交 → 构建签名 → 推送 → 草稿核对与公开 → 公开核验 → 交付。** 每个依赖步骤成功后继续；PowerShell 中运行 pnpm/git/cargo/node/gh 等原生程序后检查 `$LASTEXITCODE`，非零不得被后续成功掩盖。记录每轮日志，日志与私钥不放入发行附件目录。

## 1. 范围与目标

默认目标为个人仓库 `origin/main`（`https://github.com/baihejiangnan/copy-creator.git`）；`upstream` 为 `https://github.com/hu-qi-jia/copy-creator.git`。每次执行先核对实际远端，用户明确指定的目标和范围优先。

| 用户任务 | 执行至 |
| --- | --- |
| 提交并推送 / 更新远端 | 检查、验证、提交、源码推送 |
| 构建 / 编译 | 本地产物生成与验证 |
| 推送更新并打包 | 源码推送与本地签名打包 |
| 推送并发布新版 Release | 完整主流程 |
| 创建草稿 / 发布预览版 | 按要求保持 draft 或 prerelease |

完整发布已授权时连续执行，不重复请求确认。源码推送不自动改版本或创建 Release；本地打包不自动推送标签或公开。不能假设推送会触发远端自动构建，执行时核对现有工作流。

## 2. 检查与提交

1. 从仓库根目录检查分支、`git status --short`、工作区/暂存 diff、未跟踪文件、远端和 TODO。保护其他贡献者修改；共享工作区变化时，为构建使用固定提交的独立 Git 检出，不通过 reset、清空或 stash 他人内容制造干净状态。
2. `git fetch origin --prune` 后比较本地与远端，安全集成新提交。发布任务另查询 `gh release list --repo baihejiangnan/copy-creator` 和远端标签；实时查询决定新版本，不从历史记录取“当前 Latest”。
3. 新发行同步 `copy-creator/package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 中应用自身的版本，后三处均在内层应用。**基础版本必须高于已分发版本**，仅递增个人版后缀或 build 元数据不能触发升级。默认标签 `v<基础版本>-baihejiangnan.<无前导零正32位整数>`，标题 `Copy Creator <基础版本> 个人增强版`；核对版本/标签未占用。
4. 不移动既有发行标签，不替换已公开二进制。源码或重建改变二进制时发布更高基础版本；纯说明勘误可改原正文。
5. 逐项审查并暂存授权内容，沿用 feat/fix/perf/docs/chore 等前缀。保留公钥、合成签名夹具、WiX fragment、验证器源码/锁文件与发行脚本；排除 node_modules/dist/target/releases、优化快照、临时日志、用户资料和私钥。检查 `git diff --cached --check` 后提交，记录完整构建 SHA。
6. 纯源码推送执行与改动对应的检查；纯文档只检查事实、链接和 diff。正式签名构建的自动检查统一由 §3 脚本执行，不先重复跑整套测试。

## 3. 构建签名

从内层 `copy-creator/` 执行，依赖用 `pnpm install --frozen-lockfile`，Cargo 保持锁定。不顺手升级依赖或修改应用 identifier。

环境要求：Windows x64、PowerShell 7 的 pwsh 在 PATH、Node/pnpm/Rust/MSVC 与 WindowsInstaller COM 可用，临时目录可写且工具允许启动构建子进程。当前脚本使用默认 Cargo target 路径；不指定 target 或自定义 CARGO_TARGET_DIR/CARGO_BUILD_TARGET、.cargo/config.toml 的 target-dir/build.target，其他目标需先适配验证脚本。本机包装日志与临时目录示例见 [环境处理](../problems_and_solutions.md#windows-构建环境与临时目录)。

公钥为 `src-tauri/updater.pub`（key ID `249F2915B7BBC0DC`）；沿用匹配私钥，本机默认 `%USERPROFILE%/.tauri/copy-creator-updater.key`，也支持 TAURI_SIGNING_PRIVATE_KEY_PATH / TAURI_SIGNING_PRIVATE_KEY 及 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。不创建或替换发行密钥，不输出密钥/密码/token；私钥须由维护者安全备份，新检出不包含它。

准备 UTF-8 发行说明文件，置于已提交文档、仓库外或忽略的准备目录。按实际版本和路径填写下例；构建期间不修改源码或 HEAD：

```powershell
$releaseVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
$releaseTag = "v$releaseVersion-baihejiangnan.1"
$releaseNotes = '<发行说明绝对路径>'
$releaseSource = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot read source commit' }
pnpm release:windows -NotesFile $releaseNotes -Tag $releaseTag
if ($LASTEXITCODE -ne 0) { throw 'Release build failed' }
```

[release-windows.ps1](../../scripts/release-windows.ps1) 已执行类型、前端单测、完整 lint、Rust lib 单测、生产前端及 Tauri MSI 构建，检查 MSI ProductVersion/安装标记，并复制同次 EXE、独立签名、验签与篡改拒绝。它不执行安装、推送或发布；额外 Cargo 测试目标和桌面检查按改动范围安排。

**构建完成条件：** 实际退出码 0，摘要 `validationOnly=false`、`assets=6`，`sourceCommit` 与固定 SHA/构建后 HEAD 一致，Git 状态干净。以摘要 `directory` 的 `releases/<标签>-<唯一ID>/` 为准，不挑旧目录文件。四处版本、MSI ProductVersion、元数据 version 和标签基础版本一致。

| 精确六文件 | 用途 |
| --- | --- |
| `Copy-Creator-<version>-portable.exe` | 手动分发及旧客户端兼容 |
| `Copy-Creator-<version>-portable.exe.sig` | EXE 独立签名 |
| `Copy-Creator_<version>_x64.msi` | 当前客户端更新包 |
| `Copy-Creator_<version>_x64.msi.sig` | MSI 独立签名 |
| `latest.json` | UTF-8 无 BOM；版本/标签/说明/UTC 日期及两个平台的 URL、各自签名、大小 |
| `SHA256SUMS.txt` | 前五个文件的 SHA-256 |

`-AllowDirty` 仅供本地实现验证，其 `validationOnly=true` 产物不能发行。单独便携/NSIS 构建见 [补充命令](../problems_and_solutions.md#单独构建便携-exe-或-nsis)；NSIS 不替换 MSI，也不混入六文件目录。前端 dist/debug EXE 不作为正式桌面发行。

## 4. 推送源码与标签

返回仓库根目录，确认授权提交与 origin/main 的关系后正常快进推送，查询远端 main SHA 确认包含构建提交。非快进时安全集成并重跑受影响检查，不强推、不向 upstream 推送。功能分支先核对集成方式，新建分支沿用 `codex/` 前缀。

```powershell
git push origin main
if ($LASTEXITCODE -ne 0) { throw 'Push main failed' }
```

只有授权发布时创建附注标签，绑定 §3 的实际构建 SHA，单独推本次标签：

```powershell
git tag -a $releaseTag $releaseSource -m "Copy Creator $releaseTag"
if ($LASTEXITCODE -ne 0) { throw 'Create release tag failed' }
git push origin $releaseTag
if ($LASTEXITCODE -ne 0) { throw 'Push release tag failed' }
git ls-remote origin refs/heads/main "refs/tags/$releaseTag" "refs/tags/$releaseTag^{}"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read remote refs' }
```

附注标签继续解析到 commit SHA，不能把 tag 对象 SHA 当源码；标签指向必须与构建 SHA 一致。恢复中已存在正确标签时核对后续步骤，不重复创建。只有下载文档/验证记录的后继提交可另推，二进制与标签仍对应原构建 SHA；源码、版本、配置或资源变化则重新固定提交构建。

## 5. 草稿核对与公开

用本次成功目录的六个明确路径组成 `$releaseAssets` 数组，发行说明用文件保存实际换行；不以通配符上传日志、溯源或 QA 文件：

```powershell
$releaseDirectory = '<成功摘要中的绝对输出目录>'
$releaseAssets = @(
    "Copy-Creator-$releaseVersion-portable.exe",
    "Copy-Creator-$releaseVersion-portable.exe.sig",
    "Copy-Creator_${releaseVersion}_x64.msi",
    "Copy-Creator_${releaseVersion}_x64.msi.sig",
    'latest.json', 'SHA256SUMS.txt'
) | ForEach-Object { Join-Path $releaseDirectory $_ }
gh release create $releaseTag @releaseAssets --repo baihejiangnan/copy-creator --draft --verify-tag --target $releaseSource --title "Copy Creator $releaseVersion 个人增强版" --notes-file $releaseNotes
if ($LASTEXITCODE -ne 0) { throw 'Create or upload draft failed; inspect remote state' }
```

创建后从认证发行列表按完整标签精确匹配取得 ID，读取该 ID 的完整草稿，核对正文、实际标签所指 commit、六个资产名/字节/uploaded 状态/摘要及元数据目标。草稿读取与摘要缺失处理见 [按 ID 核对](../problems_and_solutions.md#草稿-404上传中断与按-id-核对)；按标签返回 404 不代表创建失败。

满足本次公开交付条件后，使用已核对的 `$releaseId` 按已有授权转正式 Latest；输入文件放在忽略的准备目录，位于六文件目录外：

```powershell
$releasePublishInput = '<忽略准备目录中的 publish.json 绝对路径>'
[IO.File]::WriteAllText($releasePublishInput, '{"draft":false,"prerelease":false,"make_latest":"true"}', [Text.UTF8Encoding]::new($false))
gh api --method PATCH "repos/baihejiangnan/copy-creator/releases/$releaseId" --input $releasePublishInput
if ($LASTEXITCODE -ne 0) { throw 'Publish release failed; inspect remote state' }
```

核对 draft=false、prerelease=false、Latest 标签与 URL；草稿/预发布不供正式客户端发现。缺少本次验收依据时保持本地或草稿；用户已明确接受本次列出的缺口并授权公开时继续，保留真实边界，不把旧发行的接受延伸到新问题。

正文面向使用者，写本次二进制实际变化、平台/附件/升级方法、已知问题、实际检查范围，以及来源完整 SHA、字节数和 SHA-256。README 中英文版本/链接一致，公开后同步结果；失败时明确哪些步骤成功，不长期保留失效“最新版”链接。

## 6. 公开与客户端核验

**无论远端 digest 是否存在，都匿名独立下载全部六文件。** 从公开 `/releases/latest/download/latest.json` 取得元数据，再从其两个固定资产 URL 和对应标签下载包、各自 .sig 与 SHA256SUMS.txt；核对 Latest 标签，下载副本逐一与本次成功构建的六文件摘要一致。公开下载不用 token 或 Authorization header，独立目录只放六文件，日志放外侧。

从可信客户端源码构建验证器，用以下命令核对下载副本；验证器不从待验证 Release 获取：

```powershell
pwsh -NoProfile -File ../scripts/verify-update-release.ps1 -Directory '<独立下载六文件目录>' -Verifier './src-tauri/update-verifier/target/debug/copy-creator-update-verifier.exe'
if ($LASTEXITCODE -ne 0) { throw 'Downloaded release verification failed' }
```

上例从内层应用执行，[验证脚本](../../scripts/verify-update-release.ps1) 只检查本地文件，不下载/安装/核对远端。大小、元数据、两包独立签名与 SHA 清单均须通过；服务器存在资产、本地验签或 digest 一致不能代替公开下载。完整通过后，无新变化不重复下载。

客户端/桌面验收按 [更新验收清单](updates.md#更新与安装验收) 执行：关于和设置两个入口发现更高版本、下载验签、保存后安装、安装版升级完成后自动启动，以及新版检查自身不提示升级。使用合成资料和隔离环境；本次其他功能回归按 AGENTS/TODO/设计执行，构建或 MSI 表检查不能替代桌面结果。

## 7. 异常与交付

只恢复失败步骤：构建成功后的推送/上传/下载失败不重新编译或换文件；失败构建产物不发行。先查本轮日志、进程和远端状态，定位原因再重试，同一阻塞未解除不重复运行。保留原始失败和每轮退出码。

| 遇到的问题 | 详细处理入口 |
| --- | --- |
| Temp 无法写入、spawn EPERM、继承的 Node 参数 | [环境与临时目录](../problems_and_solutions.md#windows-构建环境与临时目录) |
| Git 凭据管理器等待 | [本次认证恢复](../problems_and_solutions.md#git-凭据等待与本次认证) |
| Cargo.toml 状态脏但文本 diff 为空 | [规范化内容核对](../problems_and_solutions.md#cargotoml-换行造成的脏状态) |
| 草稿 404、上传中断、资产状态不明 | [按 ID 核对与补传](../problems_and_solutions.md#草稿-404上传中断与按-id-核对) |
| CDN/代理/下载失败 | 保留具体文件和 HTTP 状态，重试该下载；拒绝把 HTML 或旧元数据当成功结果 |

标签或资产不匹配时停止公开并定位，不删除/移动标签、强推或默认覆盖附件；公开版本有问题用更高版本修复，撤回/删除需用户明确要求。

交付报告仓库/分支/已推 SHA、版本/标签/构建 SHA、环境/命令/产物目录、六文件大小与哈希、Release URL/公开状态、匿名核验及客户端验收结果。**源码已推、草稿已建、公开完成、公开下载通过和桌面验收分别报告**；部分成功不称完整发布成功，公开不等于 TODO 全部验收通过。历史结果只链接已有 [验证记录](../verification/) 和 [开发日志](../project_process.md)，当前待办统一更新 TODO；性能收益仅引用对应实测。

## 8. 可直接转交给执行 Agent 的指令

按实际授权复制对应模板，模板不扩大任务范围。

**推送源码并本地打包：**

> 按 AGENTS.md、TODO 和发布规则整理授权修改，固定提交，完成本地签名打包和 origin/main 推送，交付真实产物/验证状态及剩余问题。按规则只恢复失败步骤。本次不推发布标签、不创建或公开 Release。

**已授权推送并公开新版 Release：**

> 按 AGENTS.md、TODO 和发布规则顺序完成本次新版本的提交、签名构建、推送、标签、草稿核对、正式 Latest 发布与匿名六文件核验，并执行本次要求的客户端验收。同步文档，分别报告各阶段结果和已接受的验收缺口。异常按规则入口处理，只恢复失败步骤。
