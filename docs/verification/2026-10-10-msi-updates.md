# MSI 更新与关于红点修正

2026-10-10，基于主分支 `750464cb7a218fc9e1c118e87551a804abbf5c09` 修改开发源码。用户要求应用内更新使用 MSI 安装流程，并在左侧关于提示新版本。初次工作区验证时版本保持 0.2.27，未发行；随后用户在了解未实测边界后授权提交、推送与 Release，四处版本提高至 0.2.28，从固定干净提交 `27d7ba3` 构建并公开，不替换 0.2.27 的任何公开资产。本记录保存实现验证，后继正式构建、推送与匿名下载结果见[0.2.28 发行记录](2026-10-10-release-028.md)。

## 实现

- 两种运行模式均读取 `windows-x86_64` 的 MSI，验证仓库、标签、MSI 文件名、大小与签名；MSI 缺失不回退到便携 EXE。缓存统一在应用 cache/updates，保存屏障、worker 排空、使用前再验签及验证期间文件共享保护保留。
- 安装模式仍由 registry marker 与当前 EXE 路径匹配确定。已安装程序调用系统 msiexec，保留父目录为 INSTALLDIR，传递 `/passive /norestart`、AUTOLAUNCHAPP 和旧进程 PID。便携程序首次安装保留完整目录向导，使用默认完成页启动选项，不同时设置 AUTOLAUNCHAPP，以免重复启动。
- 现有 Tauri 2.11.1 WiX 生成模板确认含 AUTOLAUNCHAPP/LAUNCHAPPARGS、InstallFinalize 后 LaunchApplication、完成页启动选项。这是模板检查，不是实际安装成功证据。新版保留初始化前等待旧进程的路径。
- 红点改用 danger 颜色 token，移至启动时加载的 layout.css；提示/无障碍标签说明有新版。网络重试失败保留本会话已有发现结果，成功检查可清除红点。中英文同步 MSI 按钮与两种安装说明。

## 检查

Windows x64，沿用已有锁定依赖；检查从内层应用目录执行。

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test:unit` | 82 通过，0 失败 |
| `pnpm lint` | 完整 lint 通过 |
| `pnpm build` | 类型检查与 Vite 生产构建通过 |
| `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml` | 155 通过，0 失败，4 原有基准忽略 |
| 文档链接与 diff | 6 个相关文档的 192 个本地链接存在，`git diff --check` 通过；生产主窗口 CSS 确认包含 danger 颜色的 update-dot |
| 回归范围 | 两种模式优先 MSI、拒绝 EXE URL/缺 MSI、原安装目录含空格/中文及安装参数、便携首次向导与避免双启动、已有验签/篡改/下载取消/超时、检查失败保留新版与成功清除 |

首次 Rust 检查因新测试使用 unwrap_err 要求 CheckedUpdate 实现 Debug 而编译失败，改为检查 err 后重新执行整套 Rust lib 测试通过。Rust 临时目录设置为忽略目录 `output/optimization/msi-update/tmp`，避免既有系统 Temp 写入权限问题。检查入口和原始单元测试日志在同一忽略目录，使用合成夹具与临时数据库，未访问真实用户资料，未启动生产程序或改动 PaperNest。

## 仍待验证

初次实现验证未执行正式 Tauri MSI 打包或签名发行；后继 0.2.28 已完成正式打包、签名和公开下载核验（见上方发行记录）。新二进制运行、真实 Windows Installer/UAC/安装目录升级与卸载、资料保持、安装取消/失败、安装后启动或中英亮暗红点视觉验收仍未执行。进程创建成功只代表安装器已启动；原程序退出后安装被取消或失败，不承诺自动重开旧程序。

公开 0.2.26/0.2.27 的便携更新仍下载 EXE；服务器无法修改这些已编译客户端。应用内统一 MSI 行为要安装包含本次修正的更高版本才生效。便携首次转换需要 MSI 安装向导，以后使用安装目录内的程序；Windows 要求的 UAC 授权仍保留。六文件发行集中的便携 EXE 和签名继续供手动分发及旧客户端兼容。
