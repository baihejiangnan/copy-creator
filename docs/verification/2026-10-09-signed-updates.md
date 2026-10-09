# 签名更新接入与本地发行验证 — 2026-10-09

## 授权与来源

用户要求仿照外部 `github-releases-update-check.md` 实现，并明确选择「完整接入：应用内下载、验签与用户选择升级，并准备发行脚本」。该文档作为协议参考，本轮未修改它；未获本轮源码推送或新 Release 发布授权。工作分支 main，开始/最终构建 HEAD 为 `89bac88b4b771c67e6563729d0300c12467bb6aa`，二进制包含本轮未提交改动，不能称为该提交的精确产物。并行粘贴任务的脚本改动保留。

环境沿用 Windows x64、Node 24.19.0、pnpm 11.7.0、Rust/Cargo 1.98.1、Tauri CLI 2.11.1；使用现有锁文件及默认 Release profile。基础版本保留 0.2.25，仅作本地验证，未覆盖已公开的同版本附件。最终本轮流水线于 15:51:46 结束；15:54 后另一任务继续修改 paste.rs、App.tsx 与粘贴相关中英文文案，这些修改保留但不包含在本轮签名产物与测试快照中，不宣称后续整个工作区已重建。

## 实现与原生逻辑检查

客户端固定公开 latest.json；SemVer 优先级、个人版标签与基础版本匹配；15 秒检查、180 秒下载、5 次 HTTPS 重定向、1 MiB 元数据/512 MiB 程序限制，共用翻译代理配置或 reqwest 系统/环境代理。尝试时间按 identifier 保存在配置目录，失败也计入 24 小时自动间隔。手动请求共享正在进行的任务，自动冷却跳过时的手动意图会触发一次实际检查。

原生按 MSI registry 路径/便携模式选包，禁止缺签名、错误仓库/标签/文件名；下载前重新检查 version、mode、URL、signature、size。逐块下载到同目录临时文件，64 KiB 流式验证，成功才原子保留，不覆盖现有文件；使用前再次验证并持 Windows 拒绝写入/删除共享的文件句柄。升级仅接受前端预期版本，由原生保存的包与路径执行。退出/备份/迁移取消网络并排空更新 worker。

生命周期的 Update 分支复用保存请求、会话绑定、截止时间、后台排空；失败不启动。便携子进程传入旧 PID，在打开数据库、注册快捷键和启动剪贴板前等待旧进程结束，最多 30 秒。新增 Windows 测试实际启动无窗口的短时 PowerShell 子进程，确认零等待超时拒绝和结束等待成功并回收进程；不涉及用户应用或剪贴板。

| 检查 | 最终结果 |
| --- | --- |
| `pnpm exec tsc -b` | 通过 |
| `pnpm test:unit` | 81 通过；更新 store 新增 7 例，覆盖共用请求、开关、冷却中的手动意图、错误保留/重试、签名失败、显式启动及存储代次 |
| `pnpm lint` | 完整通过 |
| 正常 Tauri beforeBuildCommand / 前端生产构建 | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml --locked --lib` | 148 通过、0 失败、3 基准忽略 |
| 更新原生用例 | SemVer/标签/date、BOM/限量元数据、本机 HTTP 实际请求与 404/限流/超量/中断、自动间隔、latest 包变化、精确 URL/平台签名、真实夹具验签/篡改/大小、实际流式下载/复用、失败/取消临时清理与进程等待通过 |

最终完整日志：`output/optimization/updates-release-build5.log`。前四次流水线和较早 Rust 日志保留在同目录，不覆盖最终证据。

## 签名构建与六文件

执行 `pwsh -NoProfile -File scripts/release-windows.ps1 -NotesFile output/optimization/updates-validation-notes.md -AllowDirty`。完整命令 exit 0；脚本摘要 `validationOnly=true`、`published=false`、`installed=false`。没有运行最终正式标识 EXE或安装 MSI。

最终目录：`releases/validation-v0.2.25-baihejiangnan.1-1d2ed11b6e1748b6add2afcdc5bc6889/`，准确六文件：

| 文件 | 字节 |
| --- | ---: |
| Copy-Creator-0.2.25-portable.exe | 46,667,776 |
| Copy-Creator-0.2.25-portable.exe.sig | 424 |
| Copy-Creator_0.2.25_x64.msi | 34,963,456 |
| Copy-Creator_0.2.25_x64.msi.sig | 416 |
| latest.json | 1,556 |
| SHA256SUMS.txt | 472 |

EXE SHA-256 `03deb56da6477f9ffe82ab48b420778aad462bdd293e51190eb53f713a15896b`；MSI `32078745ee553020f1505f77209858fe369f5674ebe06564631d319aa8324c6a`。其余摘要在实际 SHA256SUMS.txt。本轮体积只是产物报告，没有相同配置运行性能对照或性能收益结论。

Tauri signer 分别签 EXE/MSI；独立验证器引用客户端 `update_signature.rs`，对最终两个原文件均通过，对各自翻转一字节的副本均 exit 1（signatureInvalid），副本随后精确清理。验证脚本核对元数据与两个平台的独立 URL/签名/实际大小、六文件准确集合及五项 SHA 清单，最终 `verified=true`。MSI 只通过 WindowsInstaller COM 读取 ProductVersion=0.2.25 和 `[INSTALLDIR]copy-creator.exe` registry component；安装、升级和卸载未执行。早期同配置 WiX 构建报告 ICE03/40/57/61 的 LGHT1076 模板警告，构建成功不能替代安装验收。

受信任公钥 key ID `249F2915B7BBC0DC` 已编译入客户端；匹配私钥留在仓库外 `%USERPROFILE%/.tauri/copy-creator-updater.key`。文档/仓库/日志/产物不含私钥内容。签名文本与公钥是公开协议内容。

## 浏览器界面检查与恢复

使用 Playwright Interactive，在 headless Edge 的 440×420 视口挂载原 AboutDialog、UpdateSection 和 updateStore，IPC、保存生命周期与版本响应使用合成适配器。产物在 `output/optimization/updates-ui-harness/`，有 inventory、qa-report.json、适配源码与四张截图。它不连接真实数据库，不代表 WebView2/原生 DPI 或实际升级成功。

- 自动检查 503 错误显示固定错误和 HTTP 状态；finally 后、关闭重开、设置面板均保留。手动重试后变成新版结果。
- 设置自动检查开关关/开保存；两个入口共享状态。
- 下载显示进度并禁用忙时操作；验签错误恢复按钮，不能进入启动步骤。
- 正常便携和 MSI 下载完成后分别显示显式打开/安装操作；下载不会调用 launch_update，实际按钮点击才发送预期版本。
- 缺签名包保留发布页且无下载按钮；缺元数据明确提示手动下载；自身版本显示已是最新并移除下载入口。
- 中文亮/暗、英文亮/暗四张截图已查看；弹窗位于视口内、无横向溢出；纵向可滚动至操作及长更新说明。Escape 后入口焦点恢复。

截图：`zh-light-portable.png`、`en-dark-installed.png`、`en-light-unsigned.png`、`zh-dark-metadata-error.png`。脚本一度使用错误的英文按钮文案导致 Playwright 超时/内核恢复，重建浏览器后使用真实文案通过；另一缺签名检查曾在响应完成前过早断言，等待实际结果后按钮已移除。未把驱动失败算成产品失败，也未隐去尝试。测试浏览器与 Vite 服务均结束。

桌面 QA 准入早期因另一验证实例 PID 134072 拒绝，未中断它；收尾再次执行 `scripts/qa-process-isolation.ps1` 为实时测试根目录原生实例 0。本轮未启动 Tauri 桌面，未读取真实用户数据或触碰系统剪贴板。

## 发现并修正的问题

1. Windows 临时文件写句柄与验签的拒绝写共享冲突：关闭写句柄、保留 TempPath 后再验签，下载回归与最终两包通过。
2. Tauri 把额外验证 bin 纳入 MSI，缺该 bin 时打包失败：验证器拆为独立 Cargo 项目，正式 MSI 仅含应用。
3. pnpm 11 丢失 Cargo 参数分隔：发行脚本直接调用已安装 Tauri CLI 的 node 入口，保留 `-- --locked`。
4. PowerShell 文件数组拼接与 ISO 日期自动转换使六文件/date 校验失败：括号固定文件名拼接，7.5+ 显式 DateKind String，最终完整脚本通过。
5. 初次离线依赖解析带入无关升级：恢复原锁定依赖，只增加所需新项；后续 locked 构建/单测通过。
6. 便携启动早于旧进程退出可能丢失快捷键：加入初始化前进程等待，真实 Windows 子进程测试通过后重建全部最终文件。

## 未完成的验收

`gh release view` 只读核对当时公开的 0.2.25 附件仍仅便携 EXE；[Latest 页面](https://github.com/baihejiangnan/copy-creator/releases/tag/v0.2.25-baihejiangnan.1) 未改动。本轮浏览工具访问元数据资产 URL 被工具限制，不能把该限制冒充客户端 HTTP 404 实测。当时没有公开 latest.json，首次公开签名更新仍须发更高基础版本（该版本已于同日随 0.2.26 发出，见下节）。

待补：匿名公开元数据/两包独立下载和客户端验签；两个实际版本的发现/自身版本比较；Tauri 桌面便签与设置失败/超时/排空/退出/新进程运行和快捷键联合验收；MSI 自定义目录安装、升级、卸载及 marker/数据保持。旧 markerless MSI 与 NSIS 手动过渡。本地协议、合成 UI 和签名构建通过不代替这些项，因此 TODO U-01 保持未勾选。受影响 Markdown 的 361 个本地链接检查通过，`git diff --check` 通过。本轮没有提交、推送、打标签或发布。

## 后续：0.2.26 发行轮

上一节的「未获源码推送或新 Release 发布授权」只描述 2026-10-09 白天那一轮本地实现验证。同日随后用户按 [发行规则 §8](../features/release-rules.md#8-可直接转交给执行-agent-的指令)「已授权推送并公开新版 Release」模板另行授权，本轮据此把基础版本提高到 **0.2.26**，从固定提交 `79ea21906d9322072bbdd0250054317e048e65fa` 的干净检出重建六文件（标签 `v0.2.26-baihejiangnan.1` 绑定该提交），并完成草稿、公开正式 Latest 与匿名独立下载验签；本轮结果、字节数与哈希另记于 [0.2.26 签名发行记录](2026-10-09-release-026.md)。

上文 0.2.25 的测试数量、产物字节与哈希属于被 supersede 的本地轮次，不得当作 0.2.26 的证据。上面「待补」清单中，**匿名公开元数据与两包独立下载、客户端验签**已在本轮执行并通过（两次独立运行，见发行记录）；**客户端发现与自身版本比较、旧 0.2.25 手动过渡、MSI 自定义目录安装/升级/卸载以及桌面联合验收**本轮仍未执行，只具备合成/单元级版本比较证据，属明确保留的边界，不因公开发布写成通过。
