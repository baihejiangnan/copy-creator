# MSI 升级打开参数帮助页：复现与修复

2026-10-10 用户反馈从 0.2.28 下载并验签 0.2.29 后，点击“保存并退出，安装新版”只出现 Windows Installer 参数帮助页，关闭后仍为旧版；2026-10-11 继续完成回归。对比两个发行标签的 `update_package.rs` 无差异，0.2.29 没有包含本问题的修复。此前签名、MSI 表和匿名下载检查不覆盖实际安装参数解析，这一漏测已确认。

## 根因与实现

原生层原来返回逻辑参数 `LAUNCHAPPARGS=--copy-creator-update-parent 1234`、`INSTALLDIR=D:\自定义目录\Copy Creator`，随后通过 Rust `Command::args` 启动 msiexec。Rust 按 CRT 规则把含空格的整个参数加引号，得到 `"LAUNCHAPPARGS=--copy-creator-update-parent 1234"`。Windows Installer 要求 `LAUNCHAPPARGS="--copy-creator-update-parent 1234"`，属性名不能被这层引号包住；两种运行模式都传递含空格的 LAUNCHAPPARGS，故不依赖安装目录是否含空格。

依据：[Microsoft Windows Installer 命令行属性语法](https://learn.microsoft.com/en-us/windows/win32/msi/command-line-options)、[Rust CommandExt::raw_arg](https://doc.rust-lang.org/stable/std/os/windows/process/trait.CommandExt.html#tymethod.raw_arg)。原测试只检查 Vec 中的字符串，没有检查 CreateProcessW 实际交付的完整命令行。

修复在原生层生成 MSI 语法：包路径单独引用、LAUNCHAPPARGS/INSTALLDIR 只引用值，通过 `raw_arg` 逐项传入，避免二次 CRT 转义。拒绝引号、NUL 和 CR/LF 分隔符，使用 OsString 保留 Windows 路径；来源仍为原生固定系统 msiexec、已验签缓存路径及本机当前 EXE，不接受 WebView 自由命令行。便携完整向导、安装版 `/passive /norestart`、原目录和自动启动/PID 等待语义保持；保存屏障、使用前再验签及 deny-write 文件句柄不变。

## 合成复现与环境边界

探测只引用仓库 output 内不存在的合成 MSI，加 `/qn` 且隐藏启动，从未启动正式应用或安装包，也未访问真实数据库、密码箱或剪贴板。

- 旧命令：隐藏启动后 10 秒仍不退出，关闭其自身窗口后仍未结束，最终仅终止该探测 PID；与用户的帮助页阻塞相符，两轮均复现。
- 修正命令：同一路径返回 1619（安装包无法打开），未超时，说明真实 Windows Installer 正常解析命令并进入包检查。PowerShell ShellExecute、直接 CreateProcess 与 CREATE_NO_WINDOW 三种探测均返回 1619。此结果只证明命令解析，没有安装产品。
- Rust 集成探测首次运行返回 1601（原生测试进程不能访问 Installer 服务），9 项通过、1 项失败，原日志保留；通过 ShellExecute 启动同一个 Rust 测试仍失败。该 OS 集成测试转为显式隔离桌面检查，默认忽略；断言仍严格要求 1619，未把 1601 接受为通过。普通单测捕获原始 Windows 命令行，不依赖 MSI 服务。

本机证据位于 `output/optimization/msi-command-line/`：`probe-result.json`、`launch-probe.log`、`focused.log`、`focused-final.log` 及后续回归/反向日志；不存在的包保证不会安装产品，不创建正式产品标记或启动新版。日志中 Windows 原生输出编码不一致，结果以实际退出码和命令行捕获断言为准。

## 验证结果

全部命令从内层 `copy-creator/` 执行，Rust 的 TEMP/TMP 指向仓库可写 `output/optimization/msi-command-line/`。前端移除继承的 `--test-isolation=none`，未修改工具链/依赖锁或应用 identifier。

| 检查 | 实跑结果 |
| --- | --- |
| `pnpm test:unit` | 117 通过、0 失败 |
| `pnpm exec tsc -b`、`pnpm lint`、`pnpm build` | 均退出 0；Vite 生产构建完成 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked` | 180 通过、0 失败、6 默认忽略；main/doc 目标通过（0 例） |
| 新增普通回归 | 分隔符拒绝；子进程通过 GetCommandLineW 直接捕获原始 UTF-16 命令行，覆盖便携/安装、中文/空格路径及盘符根目录。合成捕获程序单独由 rustc 编译，不启动应用或安装器 |
| 反向：恢复旧参数及 `Command::arg` 写法 | 实际原始命令行回归失败，cargo exit 101 |
| 反向：去掉 INSTALLDIR 值的引号 | 安装模式原始命令行回归失败，cargo exit 101 |
| 反向：移除引号/NUL/CR/LF 拒绝 | 输入拒绝测试失败，cargo exit 101 |
| 恢复与重跑 | 三轮后源码逐字节恢复，SHA-256 均为 `093ddb578aeea6bf8072ebab48a8ed5b65cf8edbb3c4b648351e9ca357232e4c`；随后完成上述完整回归 |
| QA 前后 `pwsh -NoProfile -File ../scripts/qa-process-isolation.ps1` | 均退出 0，所有测试根实时原生进程为零 |
| `node ../scripts/check-doc-links.cjs`、`git diff --check` | 58 文档、776 本地链接、22 唯一任务 ID 无错误；差异检查通过 |

6 个默认忽略项包括原有 5 项（显式性能基准、提权目标检查、被父测试调用的单实例子进程夹具）以及新增的真实 Installer 服务探测。后者首次显式失败，不能从默认全绿推断它通过；重测命令为 `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib update_package::tests::real_msiexec_accepts_quoted_properties_without_installing_a_package -- --exact --ignored`，须另行记录退出码和隔离恢复。

主要修改定位：`src-tauri/src/update_package.rs:127`（值引用与拒绝）、`:137`（MSI 原始参数）、`:171`（系统命令构造）、`:310`（验签后启动）、`:394`（真实命令行回归）；`src-tauri/tests/fixtures/windows-command-line.rs:1`（只读合成捕获器）。本轮没有前端行为变化、schema 迁移、正式 MSI 打包或发行。

## 用户过渡与剩余边界

0.2.28/0.2.29 已编译的升级器不会被服务端或目标 MSI 里的源码修复自动改变。可手动下载并打开[已发行的 0.2.29 MSI](https://github.com/baihejiangnan/copy-creator/releases/download/v0.2.29-baihejiangnan.1/Copy-Creator_0.2.29_x64.msi)，完成安装后从安装目录启动，再在关于确认版本；升级前先在旧版中备份。此举绕过旧客户端的参数错误，不表示 0.2.29 自身包含升级器修复。后续使用包含本修复的更高版本，仍须手动过渡一次；不得覆盖现有 0.2.29 资产或移动标签。

本轮源码修复尚未发行；未在用户机器上执行安装、UAC 或升级。真实 MSI 成功安装、原目录/资料保持、完成后自动启动与单实例/快捷键，以及保存失败/超时不安装的联合验收仍待完成。合成不存在包的解析与原始命令行捕获不替代这些结果。
