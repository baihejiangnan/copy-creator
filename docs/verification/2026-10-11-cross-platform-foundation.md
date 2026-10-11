# macOS / Linux 首轮基础修复验证

## 来源与范围

基线为 `main` 的 `4e85cf49cebd65eb13e2703330cf631bdd30fe8f`。首轮修复已在用户授权后提交并推送至 `origin/main`，源码 SHA 为 `4cf3965f1384b442f8f7a5276c537e796c2517e8`；已启动[首次手动 CI](https://github.com/baihejiangnan/copy-creator/actions/runs/38108284062)，`build_packages=false`。未打标签或发布。应用版本仍为 0.3.0，schema 6、备份 v4 和 Windows 更新信任/六文件合同保持。设计和未完成项分别见[跨平台准备](../features/cross-platform-release.md)与 [TODO](../TODO.md)。

本轮处理系统密钥保护、受保护前缀在清理/备份/便签中的一致性、初步剪贴板采集与普通粘贴、私密复制保护性拒绝、非 Windows 链接/文件定位及关闭到托盘。系统测试与正式打包尚未发生；新平台原生代码存在不等于平台构建或验收通过。

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

首次 GitHub CI 的前端检查通过；macOS ARM 与 Linux 原生编译暴露 `enigo::Key::V` 仅 Windows 存在，macOS 另暴露透明窗口缺少 `macos-private-api`。改为跨平台 `Key::Unicode('v')`，并配对启用 Tauri feature 与 `app.macOSPrivateApi`，保留透明界面。Windows 普通粘贴仍使用原来的 Windows 路径。后续 CI 结果在本记录收尾补齐。

没有执行实际系统钥匙串读写、辅助功能权限、X11/Wayland、浏览器/文件管理器、托盘/关闭/焦点/重启或系统剪贴板桌面验证。没有启动 QA 应用或改变系统剪贴板；不把旧桌面报告作为这批新分支的证据。

已知功能缺口仍包括 Linux 相同内容重复制与原生事件、私密剪贴板归属/到期清除/私密填入、原生文件剪贴板格式、非 Windows 单实例与焦点保护、轮盘手势及平台签名/安装/桌面验收。当前非 Windows 私密复制返回明确错误，普通 Linux Wayland 自动粘贴及非 Windows 置顶面板自动粘贴被拒绝；这些保护性限制不算功能验收。Linux 图片轮询成本、系统密钥服务 RPC 耗时及插件图片解码预分配上限仍需测量/修正。

下一步先用真实 macOS/Linux CI 编译暴露剩余类型/链接/依赖问题，再接原生事件与私密归属协议；全套桌面验收仍需对应操作系统。公开 Release 需要独立授权和发布合同，当前工作不自动公开。
