# macOS / Linux 首轮基础修复验证

## 来源与范围

基线为 `main` 的 `4e85cf49cebd65eb13e2703330cf631bdd30fe8f`。首轮修复已在用户授权后提交并推送至 `origin/main`，源码 SHA 为 `4cf3965f1384b442f8f7a5276c537e796c2517e8`；已启动[首次手动 CI](https://github.com/baihejiangnan/copy-creator/actions/runs/38108284062)，`build_packages=false`。未打标签或发布。应用版本仍为 0.3.0，schema 6、备份 v4 和 Windows 更新信任/六文件合同保持。设计和未完成项分别见[跨平台准备](../features/cross-platform-release.md)与 [TODO](../TODO.md)。

首轮处理系统密钥保护、受保护前缀在清理/备份/便签中的一致性、初步剪贴板采集与普通粘贴、私密复制保护性拒绝、非 Windows 链接/文件定位及关闭到托盘。原生 CI 与后续验证打包分别记录在下文；新平台原生代码存在不等于桌面验收通过。

## 已执行结果

环境：Windows，Node 24.19.0、pnpm 11.7.0、Rust 1.98.1。Rust 夹具使用临时数据库、合成 Key/密码与文件；不读取真实用户数据库、密码箱、剪贴板历史、备份或系统密钥库。非 Windows 单测注入内存密钥库，生产代码没有明文/模拟后端退路。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test:unit` | 117 通过 |
| `pnpm lint` | 完整 lint 通过 |
| `pnpm build` | TypeScript 检查与 Vite 生产构建通过；不表示 macOS/Linux 桌面打包成功 |
| `cargo test --locked --manifest-path copy-creator/src-tauri/Cargo.toml --lib` | 188 通过，6 默认忽略，无失败；未重复执行忽略的基准/安装器测试 |
| `cargo check --locked --manifest-path copy-creator/src-tauri/Cargo.toml` | Windows 当前目标通过；不会编译 macOS/Linux 条件分支 |
| 工作流/文档静态检查 | actionlint、Bash 语法与本地文档链接/差异检查；此前准备轮已通过，本轮收尾复查 |

首轮新密钥模块测试遇到默认系统 Temp 的 `PermissionDenied`，3 项失败，不能作为逻辑结果。按既有环境处理入口，将子进程 TMP/TEMP 指向 `output/cross-platform-prep/temp` 后，5 项 secrets 测试及完整 Rust 回归通过；不修改用户全局环境或应用数据路径。最后全量 Rust 输出位于本地 `output/cross-platform-prep/rust-tests.txt`，该临时文件不作为发行附件。

新增/扩展的合成回归覆盖：

- 随机 nonce 的密文往返、明文不落入密文、篡改拒绝、identifier/AAD 绑定。
- 系统密钥服务拒绝时不公布密钥 ID；旧密钥丢失时不换密钥、不改 ID、不破坏旧密文。
- 其他平台/未知版本的保护格式拒绝按明文读取；旧普通明文迁移语义保留。
- `oskey:` 与未知保护版本在容量/TTL 清理中保留，便签捕获拒绝；受保护记录无法解密时备份明确失败，原记录不变。
- 完整图片尾部/尺寸/文本均影响指纹，修复此前只采样前 400 字节的碰撞风险；图片尺寸边界拒绝。
- 普通粘贴按键失败时仍尝试释放修饰键，V 至多发送一次。

既有加密备份 v0/v1/v2/v3/v4、迁移、恢复冲突、认证拒绝与事务回滚测试本轮继续通过，使用 Windows DPAPI 和合成资料。新平台系统后端与真实跨设备恢复没有在这些测试中执行。

## 原生环境与剩余边界

本机安装的 WSL 仅列出 `docker-desktop`，不视为 Linux 桌面环境。`docker desktop start --detach` 返回启动请求已发出，但之后仍无法连接 `dockerDesktopLinuxEngine`，没有可运行的 Linux 容器；已停止重复启动尝试。只在 `output/cross-platform-prep/linux-source` 暂存应用 Rust 源码/配置与前端 dist，未挂载用户 AppData、数据库或密钥。

首次 GitHub CI 的前端检查通过，三个原生目标均编译失败：`enigo::Key::V` 仅 Windows 存在，两个 macOS 目标另缺透明窗口的 `macos-private-api`。修复提交 `01d11039261e37f148ecda8842c8433816696ace` 改为跨平台 `Key::Unicode('v')`，并配对启用 Tauri feature 与 `app.macOSPrivateApi`，保留透明界面。Windows 普通粘贴仍使用原来的 Windows 路径；修复后 Windows `cargo check --locked` 与粘贴修饰键回归通过。[第二轮 CI](https://github.com/baihejiangnan/copy-creator/actions/runs/38108699661) 仍关闭打包，测试失败如下。

没有执行实际系统钥匙串读写、辅助功能权限、X11/Wayland、浏览器/文件管理器、托盘/关闭/焦点/重启或系统剪贴板桌面验证。没有启动 QA 应用或改变系统剪贴板；不把旧桌面报告作为这批新分支的证据。

第二轮三个目标均完成原生代码编译并进入测试。两个 macOS 目标各返回 164 通过、3 失败、3 默认忽略；Linux 返回 165 通过、2 失败、3 默认忽略。共同失败为 v3/v4 备份在目标系统拒绝 Windows 文件引用，这是实际跨平台恢复缺陷；保留原 Windows 夹具，改为接受 POSIX、Windows 盘符与 UNC 绝对引用数据（含扩展盘符/UNC），并覆盖外国路径恢复后编辑。明确打开文件仍要求本机原生绝对路径，不访问外部文件。macOS 的另外一项是临时路径 `/var` 与 SQLite 返回 `/private/var` 的符号链接差异，仅修正测试为 canonicalize 后比较，生产存储路由不变。修复后 Windows 全量 Rust 189 通过、6 默认忽略；随后扩展 Windows/POSIX/UNC 混合备份夹具，24 项备份专项回归通过。

恢复修复提交为 `2f1b0c60cd90bfda309c5150a5c81804618a3670`，已推送至 `origin/main`；[第三轮 CI](https://github.com/baihejiangnan/copy-creator/actions/runs/38109127150) 全部成功，使用 `build_packages=false`。Linux x64、macOS ARM64、macOS Intel 各 168 项通过、3 默认忽略，无失败；三个目标的 main 测试目标和 doc-tests 均通过（各 0 项）。默认忽略项为原有性能基准，没有新增忽略项。前端 117/117、类型与完整 lint 成功，三个原生目标的前端生产构建成功。没有生成 DMG/DEB/AppImage 或正式 Release 二进制；后继仅文档提交不改变此处已测试的源码 SHA。

已知功能缺口仍包括 Linux 相同内容重复制与原生事件、私密剪贴板归属/到期清除/私密填入、原生文件剪贴板格式、非 Windows 单实例与焦点保护、轮盘手势及平台签名/安装/桌面验收。当前非 Windows 私密复制返回明确错误，普通 Linux Wayland 自动粘贴及非 Windows 置顶面板自动粘贴被拒绝；这些保护性限制不算功能验收。Linux 图片轮询成本、系统密钥服务 RPC 耗时及插件图片解码预分配上限仍需测量/修正。

三个目标的类型、链接及默认单测阻塞已清除。用户随后授权先执行验证打包，功能缺口继续保留；对应操作系统的全套桌面验收仍待完成。公开 Release 需要独立授权和发布合同，当前工作不自动公开。

## 验证打包与包内检查

用户授权提交、推送与运行 CI 后，手动启动[验证打包](https://github.com/baihejiangnan/copy-creator/actions/runs/38110485878)，`build_packages=true`，固定来源为 `67d34467b1f99de53fdf4dcf81fff7b3d1b36f39`。该提交与前轮 `2f1b0c6` 的应用工程源码完全一致，差异只有文档；版本保持 0.3.0，产物标记 `validationOnly=true`，不向已有 Release 添加附件。

包内检查工作流及脚本提交为 `04e1aa5`，不改变应用工程或本轮构建来源。其本地静态检查包括 actionlint 1.7.12、Git Bash `bash -n`、Python 编译、文档链接和 `git diff --check`，均通过；Windows 未执行 ShellCheck。完整性脚本用临时合成包验证合法集合通过，并拒绝内容篡改、错误来源、非验证模式、缺包、重复摘要、越界路径和额外文件，不读取用户资料。

首次打包 CI 全部成功，三个平台各 168 Rust 通过/3 默认忽略，前端 117、类型及完整 lint 通过；两个 `.app`/DMG、DEB/AppImage 均实际生成。四个包下载至本机后，来源、target、文件集合及 SHA-256 全部匹配。[首次包内检查](https://github.com/baihejiangnan/copy-creator/actions/runs/38111409371) 的两个 macOS 目标通过：DMG 校验/只读挂载、plist/版本/identifier、架构、图标、Applications 链接、内部执行权限与 ad-hoc codesign 验证通过。没有执行公证或 Gatekeeper 验收。

Linux 首次包内检查在 AppImage `.DirIcon` 存在性处失败，DEB 的 ELF 检查另发现直接链接 `libxdo.so.3`、`libssl.so.3`/`libcrypto.so.3`，但元数据只有三个 Tauri 默认依赖。构建器仍为 CLI 2.11.1；[上游 2.11.4 修复说明](https://tauri.app/release/@tauri-apps/cli/v2.11.4/)明确修复 AppImage 图标和桌面入口指向构建机绝对路径的问题。本轮只将 CLI 固定为 2.11.4，锁文件其他依赖版本保持原值，不升级 Rust Tauri/runtime；DEB 额外声明 `libxdo3`、`libssl3` 与链接打开使用的 `xdg-utils`。检查脚本增加链接目标必须位于解出目录内、依赖声明及失败行号检查；修复包需要重新构建/核验，首次 Linux 包不能记为通过。
