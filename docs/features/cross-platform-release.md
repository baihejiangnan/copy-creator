# macOS / Linux Release 准备

本轮范围是构建与发布准备，不是平台移植完成或公开授权。用户已确认 Windows、macOS、Linux 三端功能必须完整一致，仅允许 macOS/Linux 单实例保护暂缓；不能通过缩减功能范围或保留 `unsupported` 分支视为完成。实现可采用各系统原生协议与权限流程，面向用户的功能、资料保护和保存恢复要求须一致。Windows 0.3.0 的已发布文件和更新元数据保持既有合同；现有验证包可先开展基础测试，但 macOS/Linux 尚不具备公开分发条件。任务状态只维护在 [TODO](../TODO.md)。

## 构建目标与入口

[platform-readiness.yml](../../.github/workflows/platform-readiness.yml) 仅提供 `workflow_dispatch`，默认只验证；启用 `build_packages` 后，原生测试成功才尝试生成验证包。无自动 push/tag 触发、无 Release 写权限、无发行私钥；不会生成 `latest.json`、创建标签或发布 Release。

| 初始目标 | GitHub runner | Rust target | 验证包 |
| --- | --- | --- | --- |
| macOS Apple Silicon | `macos-15` | `aarch64-apple-darwin` | `.app` 构建并封装为 DMG |
| macOS Intel | `macos-15-intel` | `x86_64-apple-darwin` | `.app` 构建并封装为 DMG |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | DEB、AppImage |

Linux ARM64、RPM、Flatpak 和 macOS universal 暂不在初始矩阵内。runner 版本是构建环境，不等于已验证的最低运行系统；Linux 先验收 X11，Wayland 须单独验证，不能用 XWayland 成功推断原生 Wayland 可用。

工具版本参照当前 Windows 开发环境固定为 Node 24.19.0、pnpm 11.7.0、Rust 1.98.1；JS/Cargo 依赖使用现有锁文件，第三方 Actions 固定提交。前端类型、单测、lint 成功后，各原生平台独立执行前端生产构建与 `cargo test --locked`；矩阵一项失败不取消其他平台。本轮已处理 DPAPI 无条件引用，以及首次原生 CI 暴露的按键枚举和 macOS 透明窗口 feature 阻塞；不得忽略失败后上传安装包。

工作流已按本次授权提交/推送到 `origin/main`，可从 Actions 页面选择 **macOS and Linux readiness → Run workflow**。首次保持 `build_packages=false`，保存每个平台实际编译错误；原生验证通过后再启用打包。实际来源与 CI 结果见[首轮验证记录](../verification/2026-10-11-cross-platform-foundation.md)。

成功打包的 artifact 名含 target 与完整 SHA，保留 14 天，仅含 DMG/DEB/AppImage、`SOURCE_COMMIT.txt`、`BUILD_INFO.txt` 和 `SHA256SUMS.txt`。上传目录保留包子目录，校验命令从 bundle 根执行 `shasum -a 256 -c SHA256SUMS.txt`；`.app` 位于 DMG 内，不单独上传以免 ZIP 破坏链接/权限。`validationOnly=true` 包不用于正式分发，原生测试和打包成功也不等于桌面验收通过。

验证包生成后，手动运行 [Inspect validation packages](../../.github/workflows/inspect-platform-packages.yml)，`source_run_id` 填成功的构建 run ID。只接受本仓库 main 上成功的 readiness 工作流，按原构建完整 SHA 下载精确 artifact，用[完整性脚本](../../scripts/verify-platform-artifact.py)检查来源、target、文件集合、SHA-256、非空大小，拒绝篡改、缺包、重复/越界路径及额外文件；[平台脚本](../../scripts/inspect-platform-packages.sh)在对应 runner 只读挂载 DMG、检查 plist/架构/图标/Applications 链接/内部执行权限和 ad-hoc 签名，或解出 DEB/AppImage 检查依赖/桌面入口/图标/ELF 与 AppRun 权限。GitHub artifact ZIP 不保留外层执行位，下载的 AppImage 使用前须 `chmod +x`，内部 SquashFS 权限单独核对。检查不会启动应用或安装 DEB，不替代 FUSE 运行、Gatekeeper 下载后行为、公证或桌面验收。

## 当前源码差距

基线源码为 `4e85cf49cebd65eb13e2703330cf631bdd30fe8f`。首轮基础修复及两轮 CI 缺陷修复均已推送，基础功能源码 `2f1b0c60cd90bfda309c5150a5c81804618a3670` 的[第三轮 CI](https://github.com/baihejiangnan/copy-creator/actions/runs/38109127150) 全通过：三个原生平台各 168 通过/3 默认忽略，前端 117/类型/完整 lint 与生产构建通过；Windows 自动回归 189 通过/6 默认忽略。此前三轮 CI 均关闭打包。后续首次验证打包发现 Linux AppImage 图标链接及 DEB 运行依赖问题，已固定 CLI 2.11.4（Rust Tauri/runtime 保持原值）、补充依赖；`d6e78381ff1e806bc1f7603a98be3bbe2d113d2d` 的[第二轮打包](https://github.com/baihejiangnan/copy-creator/actions/runs/38111658922)与[包内检查](https://github.com/baihejiangnan/copy-creator/actions/runs/38113172715)全通过，已生成并下载核对四个验证包；不代表安装或桌面功能通过。各轮失败、修复与边界详见[首轮验证记录](../verification/2026-10-11-cross-platform-foundation.md)。

| 范围 | 本轮实现 | 剩余要求 |
| --- | --- | --- |
| 受保护 API Key | Windows DPAPI 依赖/实现按平台限定；macOS Keychain、Linux Secret Service 通过 keyring 3.6.3 存放随机 256 位密钥，SQLite 保存 `oskey:v1:<UUID>:v1:<认证密文>`；应用 identifier 与密钥 ID 绑定 AAD | 两个真实系统验证密钥持久化、锁定/拒绝/服务缺失和访问耗时；单测使用内存密钥库，不接触用户系统密钥库 |
| 密钥生命周期 | 配置目录只存公开密钥 ID，文件锁串行初始化；新 UUID 密钥写入/回读成功后原子公布 ID；已存在 ID 对应密钥丢失时拒绝写入，不能覆盖旧密文；不缓存系统密钥以绕过服务锁定 | 实机验证系统钥匙串删除/锁定、并发启动及崩溃恢复；密钥服务 RPC 耗时与锁内预算未实测 |
| 旧数据/备份/清理 | Windows DPAPI 格式保留；拒绝把其他平台或未知版本密文当明文。Key 分类、TTL/容量清理、备份选择/容量预检、便签收存保护均识别两类保留前缀；无法解密时备份明确失败，不漏导受保护记录 | Windows DPAPI 数据库不能直接跨系统解密；须由源系统通过加密备份转换。目标机重新保护、v4/旧格式及回滚已有合成回归，真实跨平台恢复未执行 |
| 剪贴板采集 | macOS 使用 NSPasteboard changeCount，并在读取前后核对变化；Linux 以 800ms watchdog 和完整文本/图片 SHA-256 指纹轮询。文本快照上限 16 MiB、图片复用 20,000 像素边界与 256 MiB RGBA 限制；同次快照只保留一份图片 | Linux 无法可靠识别再次复制完全相同的内容，仍需 X11/Wayland 原生变化协议；轮询可能漏掉 tick 间的快速变化，图片读取/轮询成本待实测；插件解码发生在尺寸检查前，不宣称预分配有界 |
| 私密复制 | 删除非 Windows 直接走普通插件写入且无到期清理的路径；原生在写入前返回中英文 `vault.copyUnsupported`；非 Windows 私密填入仍明确不支持 | 归属、到期清除、不覆盖后续用户复制、历史排除的原生实现与验收仍是发布阻塞。保护性拒绝不是功能完成，不能宣传已支持密码箱复制/填入 |
| 普通粘贴 | Linux X11 加入 Ctrl+V；macOS Cmd+V 改为失败时也释放修饰键，不盲目重发 V。非 Windows 置顶窗口或窗口仍持有焦点时拒绝；Linux Wayland 会话明确失败，可手动粘贴已复制的普通内容 | 外部目标捕获/身份/焦点确认、手势修饰键释放、macOS 辅助功能授权/拒绝恢复及原生 Wayland 路径尚待实现/桌面验收，不以发键成功认定插入成功 |
| 文件引用/文件复制 | macOS Finder `open -R` 定位；Linux FileManager1 `ShowItems`，不支持时打开父目录。无 shell 拼接；子进程有超时、失败检查及回收 | 系统文件管理器实际行为待验；非 Windows 文件复制仍退化为路径文本，原生文件剪贴板格式尚未实现，不得误删外部文件 |
| 链接打开 | 保留原协议限制，macOS `open` / Linux `xdg-open` 经有界后台 worker 打开，失败返回固定错误，不打印用户 URL 或系统原始错误 | 默认浏览器实际打开/失败/超时待实机验收 |
| 窗口与单实例 | 非 Windows 关闭主窗改为隐藏到托盘，保留统一保存交接；Windows 路径保持 | 失焦自动隐藏、主窗/轮盘焦点、托盘/重启与开机启动仍须平台实现或验收；仅非 Windows 单实例保护按用户决定暂缓，不能标为已实现 |
| 应用内更新 | 非 Windows mode=`unsupported`，现有 MSI 合同保持 | 先前首轮手动安装/更新的方案已由三端功能完整一致要求取代；须补平台选择、签名下载验证、安装和保存交接，手动下载仅作为退路，不能代替应用内更新完成 |

本轮不是完整移植。除用户允许暂缓的非 Windows 单实例保护外，上述功能差距仍阻塞三端功能完整一致的正式发行；基础测试可以分批开展，但不能以暂不提供私密复制、原生文件格式、轮盘或应用内更新等方式完成本轮要求。按包判断：AppImage 运行问题只阻塞 AppImage；DEB 无此依赖，但仍有自身未验证项（安装/卸载、桌面入口、托盘、WebKitGTK），包间差异不免除三端功能要求。不关闭失败测试、不降级为明文，也不把保护性拒绝或未运行的原生分支记为验收完成。

安全与可靠性不因单实例暂缓而免除验证：系统密钥保护的持久化与缺失/锁定/拒绝行为、保存屏障与草稿恢复、退出重启后的数据保持、加密备份的导入与回滚仍须验证，包括允许多进程启动时的数据可靠性边界。

## 签名与正式发布材料

当前锁定的 Tauri 2.11.1 需要配对启用 `macos-private-api` feature 与 `app.macOSPrivateApi` 才能保留主窗/轮盘透明背景；该配置不提供 Apple 签名或公证，当前采用独立 DMG 分发路线，未准备 Mac App Store 上架。

macOS 验证包使用 `APPLE_SIGNING_IDENTITY=-` 的 ad-hoc 签名，仅用于开发验证。正式分发准备 Apple Developer 的 Developer ID Application 证书（P12）、证书密码、签名 identity，以及 notarization 凭据。Apple ID 方式使用 `APPLE_ID`、应用专用 `APPLE_PASSWORD`、`APPLE_TEAM_ID`；也可改用 App Store Connect 的 `APPLE_API_ISSUER`、`APPLE_API_KEY`、`APPLE_API_KEY_PATH`。凭据通过受控 CI secrets/临时文件提供，不进入仓库、artifact 或日志；本准备工作流尚未接入这些凭据。正式包需验证 codesign、notarization/stapling 与下载后 Gatekeeper 行为，不把 ad-hoc 或 Tauri 更新签名当作 Apple 公证。

ad-hoc 包不等于不可用：它没有 Developer ID 签名和公证，默认 Gatekeeper 会拦截，但系统策略允许时，可信测试者可通过「隐私与安全性 → 仍要打开」授权运行（[Apple 官方说明](https://support.apple.com/en-us/102445)）。draft/prerelease 标签本身不改变这一行为，也不构成公开分发准备。该授权路径只适用于内部基础测试，不能替代 Developer ID 签名与公证，也不作为面向最终用户的获取方式。

Linux 包须核对运行依赖、安装/卸载、桌面入口、托盘、开机启动与 WebKitGTK；AppImage 另验证执行权限、FUSE/无 FUSE 的受支持启动方式与实际分发版兼容。构建 Ubuntu 22.04 不表示支持所有 Linux 发行版。正式公开前给每个包生成大小、SHA-256、来源 SHA 和签名；若采用现有更新信任，沿用受控发行密钥，先扩展独立验证器与附件合同，不随意生成替代密钥。

Windows 的六文件发行规则仍只适用于 Windows。联合发行需先扩展 [发布规则](release-rules.md) 的资产集合、`latest.json` 平台选择、摘要与匿名独立下载验证；保留 Windows 两个既有平台条目。CI 不得自动把准备包发布为 Latest。首次正式跨平台二进制使用高于已分发版本的基础版本，不向既有公开版本补入不同源码构建的附件。

## 桌面验收边界

用合成资料与隔离 identifier/系统集成，在两类 Mac 和 Linux 实机/桌面环境分别覆盖：首次启动/托盘/快捷键/轮盘、中文 IME、亮暗/中英/最小窗/缩放、文本/图片/文件采集和外部粘贴、私密复制到期与后续用户复制、自动保存/异常重开/退出与重启、目录搬迁、加密备份跨平台恢复、安装/卸载/升级。系统密钥服务锁定/缺失、macOS 权限拒绝、Wayland 限制须有明确产品行为和可见提示。核对所有 QA 进程与测试后系统状态恢复；不得默认访问真实用户数据。

本轮本机只具备 Windows 工具链；WSL 清单只有 `docker-desktop`，不视作已准备的 Linux 桌面 QA 环境。本轮尝试启动 Docker Desktop 后仍无法连接 Linux 引擎，未创建或运行 Linux 验证容器。远端原生 CI、四个验证包及修复后包内检查成功结果已记录在验证文档；尚无签名公证、实际安装或桌面验收结果。

外部验证条件不只有签名证书。对应系统的桌面测试环境（两类 Mac 实机、Linux 桌面），真实 Keychain/Secret Service 与权限拒绝、服务缺失/锁定场景，同样是当前缺少的验证条件；Apple 证书准备可与功能补齐、基础测试并行推进，无需先行等待。

### 基础桌面测试（可先开展）

现有四个验证包可直接用于基础测试，不必等证书或未实现功能：安装/载入、启动、托盘、普通文本复制粘贴、保存与重启后数据保持、系统密钥服务读写属于第一批范围；已知未实现项（私密复制、Linux 原生事件、原生文件格式、单实例/焦点、轮盘手势）保持待验，不计入基础结论。

这些包使用正式 identifier `com.copycreator.app`，在同一账户中会与正式版共用默认数据目录及 macOS/Linux 系统密钥条目；现有单实例锁只在 Windows 启用，macOS/Linux 尚无对应门闸。测试 MUST 只用合成夹具，并在开始前确认没有需要保留的用户资料。实际安装应使用干净测试系统/虚拟机，或先核对安装身份无冲突；专用测试账户能隔离账户资料，但不能隔离共享的 `/Applications` 安装位置或系统级 DEB 安装。

隔离 QA 包可沿用既有 Windows 实验模式，用 `tauri build --config <qa>.json` 覆盖 `identifier`（例如 `com.copycreator.qa<日期>`）作为数据身份隔离的起点。安装隔离还须逐平台核对产物：macOS 的 `.app` 名称与安装位置，Linux 的 DEB 包名、可执行文件路径、桌面入口与图标路径。仅改 identifier 或产品名不能视为已完成这些检查。下表列出已有源码机制及其适用范围；macOS/Linux 的实际系统集成隔离仍待桌面验证：

| 隔离点 | 位置 | 行为 |
| --- | --- | --- |
| 系统密钥条目（macOS/Linux） | `secrets_portable.rs` | 服务名 `{identifier}.local-secrets.v1`，密文认证的 AAD 绑定 identifier；Windows 使用用户范围的 DPAPI，不适用此条目隔离机制 |
| 粘贴图片目录 | `paste.rs` | 非 `com.copycreator.app` 写入 `copy_creator_paste_instances/<identifier 摘要>`，不进入正式版清理树 |
| 开机启动项 | `lib.rs` | 非正式 identifier 传入插件的名称为 `<应用名> (<identifier>)`；macOS/Linux 实际注册、开关及清理仍待验证 |
| 单实例锁（仅 Windows） | `single_instance.rs` | 锁名取自 SID 与 identifier 的摘要，并由 Local 命名空间区分登录会话；macOS/Linux 尚未实现对应保护 |
| 加速清理时钟 | `maintenance.rs` | 仅 `diagnostics` feature + 非正式 identifier 生效，正式标识与普通构建固定为生产间隔 |

系统剪贴板、全局快捷键与系统权限不会因 identifier 改变而自动隔离；受控测试须保留授权与恢复证据，并核对测试后进程及系统状态。QA 包同样使用 ad-hoc/无签名，测试授权方式与验证包一致；它只用于隔离测试，NOT 用于分发。

本轮已执行：actionlint 1.7.12 工作流检查通过（下载文件与上游 SHA-256 清单一致；Windows 上未执行 ShellCheck）；Git Bash `bash -n` 对全部 11 个 run 块语法检查通过；YAML 的手动触发/只读权限/三目标矩阵检查、受影响文档相对文件链接检查、`git diff --check` 通过。这些是此前准备轮的静态证据；本轮源码变更与自动回归结果见[首轮验证记录](../verification/2026-10-11-cross-platform-foundation.md)，不将 Windows 回归记为 macOS/Linux 构建通过。

系统密钥库资料：[keyring 3.6.3 平台后端与特性](https://docs.rs/keyring/3.6.3/keyring/)。

官方资料：[Tauri GitHub 构建](https://v2.tauri.app/distribute/pipelines/github/)、[系统依赖](https://v2.tauri.app/start/prerequisites/)、[macOS 签名与公证](https://v2.tauri.app/distribute/sign/macos/)、[GitHub runner 架构与标签](https://github.com/actions/runner-images)。
