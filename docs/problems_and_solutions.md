# Copy Creator — 问题与解决方案总结

> 2026-10-07：原有问题记录保留历史上下文和当时方案，旧行号/状态须对照源码。当前两个主任务与待验证项见 [TODO](TODO.md)，设计见 [便签](features/notes-design.md)和[性能与体积优化](features/performance-design.md)。

## Windows 发行环境与故障处理

正常发布步骤见 [发布规则](features/release-rules.md)；本节按遇到的问题查阅，详细命令不作为每次发行都要重复执行的检查。依据本机 [0.2.26](verification/2026-10-09-release-026.md)、[0.2.27](verification/2026-10-10-release-027.md)和[0.2.28](verification/2026-10-10-release-028.md) 的实际执行记录。

连续约 2 分钟没有新输出时，查看本轮阶段日志、相关进程活动及远端状态，区分活跃编译/上传和凭据等待；该时间是诊断触发点，不是编译超时。只终止已确认属于本轮且确实阻塞的进程，不按进程名批量结束其他任务。原因未解决时不重复重试；修正后重试一次仍失败，保留证据继续定位。

### Windows 构建环境与临时目录

先从内层应用确认 Node/pnpm、Rust/MSVC、PowerShell 7 与 WindowsInstaller COM 可用，确认已锁定依赖和签名密钥存在；不读取或输出私钥、密码或认证 token。仅在发行子进程内调整 PATH、TMP/TEMP 和 NODE_OPTIONS，不改用户全局环境。

本机系统 Temp 曾使 Rust 合成数据库测试以 `PermissionDenied`/`CannotOpen` 失败，优先在仓库根目录的忽略路径 `output/optimization/release-<新版本>/tmp` 创建专用目录，先写入并删除唯一命名、无敏感内容的探针确认可写，再让 TMP/TEMP 指向它。不要把失败归为产品数据库问题，也不要访问真实数据库排查。

Vite 在 Windows 上可能执行 `net use` 并使用 piped stdio；Node 测试默认也会启动子进程。遇到 `spawn EPERM`，结合失败命令判断是否是当前工具沙箱拒绝进程创建。临时目录调整或 `--test-isolation=none` 不能解决 Vite 的子进程权限拒绝；不得为此改业务源码、跳过测试或替换构建入口。沿用会话已有执行权限授权，通过工具支持的机制在允许这些进程调用的环境重试；确实需要尚未授权的权限时说明具体被拒命令与原因，不把文档当作权限授予。

检查继承的 NODE_OPTIONS 是否影响本轮构建；旧沙箱的测试隔离 workaround 不默认沿用到正常发行。本机 0.2.27/0.2.28 在允许进程创建的环境中移除该测试选项，按原测试入口通过。用户明确需要的其他 Node 参数应先核对用途，不能机械覆盖。

下面是包装脚本示例，保存到上述忽略的发行准备目录后，从内层应用用 `pwsh -NoProfile -File <包装脚本绝对路径> -NotesFile <说明绝对路径> -Tag <本次标签>` 执行。示例按本机正常发行清除继承的 NODE_OPTIONS；Node 不在 PATH 时只在该子进程补充实际安装目录。不要把多行脚本挤成无分隔符的一行。

```powershell
param(
    [Parameter(Mandatory=$true)][string]$NotesFile,
    [Parameter(Mandatory=$true)][string]$Tag
)
$ErrorActionPreference = 'Stop'
$releaseTemp = Join-Path $PSScriptRoot 'tmp'
New-Item -ItemType Directory -Force -Path $releaseTemp | Out-Null
$releaseProbe = Join-Path $releaseTemp ('write-probe-' + [guid]::NewGuid().ToString('N') + '.txt')
[IO.File]::WriteAllText($releaseProbe, 'release temp probe')
Remove-Item -LiteralPath $releaseProbe
$env:TMP = $releaseTemp
$env:TEMP = $releaseTemp
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$releaseLog = Join-Path $PSScriptRoot 'build.log'
& pnpm release:windows -NotesFile $NotesFile -Tag $Tag *>&1 | Tee-Object -FilePath $releaseLog
$releaseExit = $LASTEXITCODE
Write-Output "RELEASE-EXIT=$releaseExit"
exit $releaseExit
```

每次重试用独立日志或先重命名旧日志，保留原始失败。`$ErrorActionPreference` 与 Tee-Object 不能代替原生退出码；包装脚本只有实际退出码为 0、正式摘要 `validationOnly=false`、sourceCommit/最终 HEAD 一致且六文件校验通过，才进入推送与上传。实际 Temp 或权限阻塞未解除时停止依赖步骤。

### Git 凭据等待与本次认证

`git push` 长时间无输出时先确认它是否等待本轮 git-credential-manager，并只读查询远端 main/标签是否已经更新。不是所有无输出都代表等待登录。已确认阻塞时先结束本轮等待的进程，等待原命令返回并核对远端，再重试；不要让两个 push 同时运行。

GitHub CLI 已认证且对目标仓库有写权限时，可在本次发行子进程用其现有认证替代等待的 helper。不要把 token 拼进远端 URL、命令、环境日志或文档，不使用输出 token 的命令，也不默认修改全局 credential 配置。仓库根目录的示例：

```powershell
gh auth status
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI authentication is unavailable' }
$env:GIT_TERMINAL_PROMPT = '0'
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
if ($LASTEXITCODE -ne 0) { throw 'Push main failed' }
# $releaseTag 必须是本次已创建且绑定构建 SHA 的标签。
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin $releaseTag
if ($LASTEXITCODE -ne 0) { throw 'Push release tag failed' }
```

第二条 helper 参数只作用于该命令，第一条清空继承的其他 helper。公开 fetch 或 `gh api` 读取成功不等于具备推送权限；认证、写权限或非快进失败时按实际原因处理，不能强推。推送后继续核对远端源码与标签 SHA；CLI 未认证时报告所需登录/权限，不自行更换账号或搜寻其他凭据。

### Cargo.toml 换行造成的脏状态

Tauri 可能重写 `copy-creator/src-tauri/Cargo.toml` 的换行；0.2.28 曾出现 `git status` 为修改、文本 diff 为空、规范化 blob 与 HEAD 相同。构建退出非零时不能直接使用该轮产物，即使签名已完成，也不能把失败改记为成功。

先从仓库根目录核对全部状态、固定 HEAD、该文件 diff 和规范化内容，命令如下；每步检查退出码，不使用忽略空白的 diff 作为内容相同的唯一依据：

```powershell
git status --short
git rev-parse HEAD
git diff -- copy-creator/src-tauri/Cargo.toml
git hash-object copy-creator/src-tauri/Cargo.toml
git rev-parse HEAD:copy-creator/src-tauri/Cargo.toml
git diff --cached --check
```

仅在构建开始时工作区干净、当前 HEAD 仍为固定构建 SHA、两项 blob 完全一致、暂存 diff 为空且无其他内容变化时，允许 `git add -- copy-creator/src-tauri/Cargo.toml` 刷新该文件的索引统计。随后用 `git diff --cached --quiet`、`git status --short` 和 HEAD 确认无暂存变化、工作区干净、提交未变，再从同一 SHA 重跑原发行脚本，使用新的成功摘要目录。

存在真实源码/版本/依赖变化、别人的修改、暂存内容或 HEAD 改变时停止这种恢复，按授权审查、提交最终内容并重新固定 SHA 构建。禁止 `git reset --hard`、覆盖文件、批量暂存或用 `-AllowDirty` 掩盖变化；二进制和 `-text` 签名夹具不能套用此换行恢复。

### 草稿 404、上传中断与按 ID 核对

草稿的 `/releases/tags/<tag>` 在本次环境曾返回 404，但发行列表包含已上传草稿；不能据此认定创建失败。先检查创建命令状态及 `gh release list --repo baihejiangnan/copy-creator`，再从认证的发行列表按本次完整标签精确匹配取得 ID。以下示例中 `$releaseTag` 为本次标签，从仓库根目录执行；分页避免只查询首屏：

```powershell
$releasePages = gh api --paginate --slurp 'repos/baihejiangnan/copy-creator/releases?per_page=100'
if ($LASTEXITCODE -ne 0) { throw 'Cannot list releases' }
$releaseMatches = @(($releasePages | ConvertFrom-Json) | ForEach-Object { $_ } |
    Where-Object { $_.tag_name -ceq $releaseTag })
if ($releaseMatches.Count -ne 1) { throw 'Expected exactly one matching release; inspect remote state' }
$releaseId = $releaseMatches[0].id
$releaseJson = gh api "repos/baihejiangnan/copy-creator/releases/$releaseId"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read release by ID' }
$release = $releaseJson | ConvertFrom-Json
```

核对该 ID 的 draft/prerelease、标签、正文、目标提交与实际远端标签解析的源码 SHA，再逐一比对本次精确六文件名、size、uploaded 状态和可用的 SHA-256 digest；附注标签对象须继续解析到 commit。草稿 digest 缺失时，使用维护者认证下载草稿副本至独立目录核对摘要、签名与元数据，不输出 token；这是公开前草稿核验，不能代替公开后匿名下载。目标字段不足以证明标签所指源码，不单独依赖 target_commitish。

创建或上传中断后，先核对已有草稿与每个资产，保留已匹配文件；仅补传确认缺失的文件，不重复创建，不用通配符或默认 `--clobber`。存在不匹配资产、标签、多个匹配发行或状态不明时停止公开并定位原因。所有附件核对通过后才按既有授权公开；可按已经验证的发行 ID，通过 UTF-8 JSON 文件调用 `gh api --method PATCH ... --input <文件>` 设置 draft=false、prerelease=false、make_latest=true，并重新确认公开状态。上传成功不等于公开成功，公开成功也不等于匿名下载/桌面验收通过。

### 单独构建便携 EXE 或 NSIS

仅在用户要求这些本地产物时，从内层应用执行以下补充命令；正常六文件发行仍使用发布规则的 release:windows。这些命令不包含完整测试与六文件签名核验。

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --no-bundle --ci -- --locked
if ($LASTEXITCODE -ne 0) { throw 'Portable build failed' }
```

明确要求额外 NSIS 时才运行：

```powershell
node node_modules/@tauri-apps/cli/tauri.js build --ci --bundles nsis -- --locked
if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
```

直接调用已安装的 Tauri CLI node 入口保留 Cargo 分隔符；本机 pnpm 11.7.0 的 exec 曾剥离该分隔符并被 CLI 拒绝。CLI 仍执行 beforeBuildCommand 的前端生产构建，默认 EXE 在 src-tauri/target/release/copy-creator.exe，安装包在其 bundle/。依赖已缓存且任务需要离线时才加 Cargo --offline；不以离线代替冻结依赖。NSIS 不作为当前客户端 MSI 更新包；便携不承诺数据在 EXE 旁或免除 WebView2 依赖。

## 一、已解决的问题

### 2026-10-08：拒绝旧响应仍不足以保护迁移后的存储

真实延迟传输发现旧收藏请求可在目录切换后才进入原生并修改新库；实际旧锁定事件又分别清空了新密码箱会话和新备份输入。统一请求在交付前绑定 epoch，原生在生产者/异步许可内拒绝旧身份，私密读取在刷新活动和读取 Key 前检查；锁定事件及心跳、复制/剪切回调保留来源身份。36 个旧原生命令全表保持、新旧事件和当前锁定分别验证；备份表单三项实际 effect 回归先失败后修复，前端 71 项通过，默认桌面复验及剪贴板恢复通过。请求、成功/错误回执、事件与其他消费者需要分别检查，不能用一条过滤代替全部边界，详见[发现与验收](verification/2026-10-08-vault-phrase-regression.md)。

### 2026-10-07：原生隐藏不能只看 document.hidden

Windows 实际隐藏主窗后 WebView2 仍可报告网页可见，原可见性订阅无法暂停刷新。主窗原生显隐成功后发送状态，焦点/尺寸变化以单飞有界查询核对 visible/minimized；代次拒绝旧结果，固定失焦窗口仍可见。复验实际隐藏按钮后连续 10 次刷新没有新增摘要/图片请求。另修复长 flex 列表的离屏卡片被压到约 1.6px；不取消动画或字体。测量入口冻结、失败报告和剩余性能范围见[图片与压力记录](verification/2026-10-07-images-scale.md)。

### 2026-10-07：备份容量有界仍会同时保留多份大缓冲

98.21% 上限的默认 Release 备份已经能正常往返，但约 100ms 进程采样发现原生导出 private 峰值约 417MB。序列化后提前释放快照、借用 JSON payload 解析和按预检文件长度预留读取缓冲后，同夹具导出约 187MB、预览约 213MB；保留加密强度、容量与原子事务。全进程树、空闲差异及单次观察限制单独报告；含图片/密码箱和尾延迟仍待验。另修复实际连接与资产目录偏离、失败文件阻塞回收队列，详见[实现与证据](verification/2026-10-07-capacity-exit.md)。

### 2026-10-07：右键菜单存在于 DOM 但无法点击

剪贴板卡片内的 fixed 菜单受到祖先动画 transform、内容可见性和列表滚动裁切影响；DOM 可见断言不能证明用户能操作。菜单移至 body 门户，保留动画与原样式，并按实际宽高约束视口。默认 Release 的普通及 440×420 /125% 窗口中，文本、链接、文件捕获均用正常点击通过；未使用强制点击掩盖遮挡。详见[失败截图与复验](verification/2026-10-07-file-backup-desktop.md#剪贴板卡片捕获与菜单裁切)。

### 2026-10-07：已保存且获准退出仍不等于重启成功

Windows 默认 Release 在原生目录选择、迁移和新草稿保存后，保存确认与后台排空均完成，`ExitRequested` 也已批准，却没有最终退出事件或替换进程。无待保存稿的重启曾成功，因此不能用它替代联合验收。Windows 现在在统一交接、后台排空、密码箱锁定和敏感剪贴板清理之后，排入主线程执行 Tauri 的直接清理/重启路径；诊断及默认版本分别验证替换进程、正确目标库和新稿正文。没有绕过保存屏障；完整退出仍单独验收。迁移错误原本显示内部 key，另补齐中英文提示。详见[失败与复验证据](verification/2026-10-07-file-backup-desktop.md#目录迁移源路由故障与原生重启)。

### 2026-10-07：文件定位与原生对话框的失焦竞态

路径带逗号/空格时，单参数 Explorer `/select,<path>` 调用不可靠，spawn 返回也不能证明准确选择；改用 Shell PIDL API，并在真实 Explorer SelectedItems 中核验完整路径。文件对话框原未绑定主窗口，选择前失焦隐藏会提前保存仅标题草稿并残留错误提示；绑定父窗口、保护对话框作用域后完整流程通过。全应用唯一门闸与真实回调持有的增强已复验并发拒绝和随后连续使用。引用移除和便签删除不触及外部文件，缺失文件仍保留引用。详见[原生桌面证据](verification/2026-10-07-file-backup-desktop.md)。

### 2026-10-07：边界长文的浏览器布局被 input 后计时遗漏

接近 256 KiB 单段文本在 textarea 中每键约 1.2s，110 键均有长任务；input capture 后绘制 P95 却仅约 17ms。跟踪显示主开销在更早的 `textInput`/`keypress` Layout。样式调整没有解决，改用惰性 CodeMirror 纯文本视口绘制后，同设备默认 Release 按键到 Paint P95 10.960ms、无 >50ms 长任务。保留字体、软换行和完整正文，增加的 JS 单独核算；真实 IME 仍待验。另修复超长搜索同步 throw 绕过 Promise `.catch`，页面错误后可恢复查询。详见[证据与边界](verification/2026-10-07-durability-pressure.md)。

### 2026-10-07：普通 Node 测试未覆盖 WebView 计时器 receiver

真实便签归档在进入原生命令前失败，WebView 抛出 `Illegal invocation`。保存屏障把浏览器计时器存成对象属性后作为方法调用，receiver 改变；Node 计时器没有暴露这个差异。改为包装函数调用原全局计时器，新增 host timer 回归并在真实 QA WebView 跑通归档、删除和恢复。检查还补上仅标题未落库稿件的交接拒绝；原生重启请求被拒绝后稿件保留，四份失败稿均可恢复保存。最小窗口截图发现侧栏裁切，修复后须按每个按钮的实际几何范围复验，不能只检查页面横向滚动。详见[本批验证](verification/2026-10-07-accounting-desktop.md)。

### 1. 多窗口方案失败（WebviewWindowBuilder）

**问题**：尝试用 `WebviewWindowBuilder` 动态创建子窗口作为功能面板，`build()` 不报错但窗口不出现。调试多日后放弃。

**解决**：放弃多窗口，改用**单窗口 + 左侧功能栏 + 右侧面板**布局。面板通过 React state 切换内容，窗口始终 440px 宽，不再伸缩。

**教训**：Tauri 2.x 的多窗口 WebviewWindowBuilder 在不同 Windows 版本上有兼容性问题，动态窗口创建不如静态配置可靠。效率工具类产品（Alfred、Raycast）用单窗口伸缩/切换方案更成熟。

---

### 2. Tauri 窗口白色原生背景（WebView2 透明）

**问题**：设置了 `transparent: true` + `decorations: false`，但窗口仍有白色/灰色背景，CSS `background: transparent` 不生效。

**原因**：Windows WebView2 默认有白色背景，CSS 透明无法穿透到底层窗口。

**解决**：
```rust
// lib.rs
window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

// Windows DWM backdrop effect
DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, &3, size_of::<i32>());
```
并配置 `tauri.conf.json`:
```json
"windows": [{ "transparent": true, "decorations": false }]
```

---

### 3. 粘贴时窗口闪烁 / 聚焦不可靠

**问题**：点击内容粘贴时窗口消失/闪烁，且部分应用粘贴不生效。

**根因**：Tauri 浮窗有键盘焦点时，Ctrl+V 投递到自身窗口。尝试了多种方案：

| 方案 | 效果 | 原因 |
|------|------|------|
| `window.hide()` / `window.show()` | 聚焦可靠 ✓ | Windows 隐藏前台窗口时精确激活上一个焦点窗口 |
| `Alt+Escape`（Z 序推底） | 部分失效 ✗ | 激活 Z 序下一个窗口，不一定是用户用的 |
| `SetForegroundWindow(HWND)` | 不可靠 ✗ | 跨进程前台窗口切换有权限限制 |
| `window.minimize()` | 较可靠 △ | 动画比 hide/show 更平滑但仍有视觉变化 |
| `set_position(-9999,-9999)` | 完全不聚焦 ✗ | 移动窗口不改变焦点 |

**最终方案**：`window.hide()` + `window.show()` + 前端 CSS opacity 消除视觉闪烁。

---

### 4. 导航栏状态冲突（设置按钮 vs 功能按钮）

**问题**：点击设置按钮时，功能按钮（剪切板/短语/翻译）仍保持选中状态；反之亦然。

**解决**：在 `GlassIcons.tsx` 中通过 `activePanelType` prop 从父组件 App.tsx 同步激活状态。当 settings 激活时传 `null` 清除导航栏选中；当功能面板激活时传对应 panelType 清除设置按钮选中。

---

### 5. CSS 灰色窗口问题（样式完全失效）

**问题**：Tauri 窗口启动后完全灰色，所有 CSS 失效，持续多日。

**排查过程**：
1. CSS 括号匹配 → 正确
2. `@font-face` 中文路径 → 不存在
3. Vite 日志 → JSON 解析错误 + 模块导入错误

**最终发现两个根因**：

**a) JSON 语法错误**
- `zh-CN.json:41` — `"translation": "翻译","更改"` 多余字符串
- `en.json:41` — `"translation": "Translation",` 尾随逗号（标准 JSON 不允许）
- 单个 JSON 文件解析失败导致 Vite 整个模块图构建崩溃，CSS 无法加载

**b) Vite 8 (rolldown) 类型导入兼容问题**
```
The requested module does not provide an export named 'UnlistenFn'
```
Vite 8 底层用 rolldown，不支持跨模块 `export type` 重新导出。`@tauri-apps/api/event` 的 `UnlistenFn` 是类型导出，rolldown 无法解析。

**解决**：不在本地导入 `UnlistenFn`，改用本地类型定义 `type UnlistenFn = () => void`。同时清除 `.vite` 缓存目录。

---

### 6. Rust 闭包类型不兼容（E0308）

**问题**：`db.rs` 的 `get_clipboard_records` 中 `if/else` 两个分支的 `query_map` 闭包产生不同类型，编译失败。

```
error[E0308]: `if` and `else` have incompatible types
expected `MappedRows<'_, {closure@...}>`, found `MappedRows<'_, {closure@...}>`
```

**解决**：将收集逻辑移到各自分支内部，避免跨分支共享 `rows` 变量：
```rust
if let Some(q) = search {
    // prepare + query_map + collect 在 if 分支内完成
} else {
    // prepare + query_map + collect 在 else 分支内完成
}
Ok(records)
```

---

### 7. Tauri 窗口尺寸权限缺失

**问题**：前端调用 `getCurrentWindow().setSize()` 时报错：
```
window.set_size not allowed. Permissions associated with this command: core:window:allow-set-size
```

**解决**：在 `capabilities/default.json` 中添加：
```json
"core:window:allow-set-size",
"core:window:allow-set-position",
"core:window:allow-set-focus",
"core:window:allow-show"
```

---

### 8. 端口占用 / 旧进程残留

**问题**：重启 Tauri dev 时端口 5173 被占用，或 HotKey 已注册导致 panic。

**解决**：启动前先清理：
```bash
taskkill -F -IM copy-creator.exe
# 找到占用 5173 的 PID 并 kill
netstat -ano | grep ":5173" | awk '{print $5}' | xargs -I{} taskkill -PID {} -F
# 清除 Vite 缓存
rm -rf node_modules/.vite
```

---

## 二、关键架构决策

| 决策 | 结论 | 理由 |
|------|------|------|
| 多窗口 vs 单窗口 | **单窗口** | Tauri 动态窗口创建不稳定，单窗口 + React state 更可靠 |
| 面板路由方式 | **React state** | 比 URL param 简单，不需要处理编码问题 |
| CSS 方案 | **纯 CSS + CSS 变量** | 移除 MUI 依赖，减小包体积，完全控制样式 |
| 按钮设计 | **圆角矩形 + tooltip** | 比 3D 玻璃拟态更简洁，亮暗色适配更直观 |
| 粘贴聚焦 | **hide/show + opacity** | 唯一在所有应用中聚焦可靠的方案 |

---

## 三、技术栈兼容性注意事项

1. **Vite 8 不要导入 Tauri 的类型导出** — 所有 `@tauri-apps/api/*` 的 type-only export 需改为本地定义
2. **JSON 必须严格标准格式** — 不能有尾随逗号或多余内容，否则整个 Vite 构建崩溃
3. **Tauri 2.x 权限模型** — `capabilities/default.json` 需要显式列出每个用到的权限
4. **Windows WebView2 透明** — 需要 Rust 侧 `set_background_color` + DWM API 双管齐下
5. **Rust 闭包类型** — `if/else` 分支的闭包即使完全相同也会产生不同类型，需分开处理

---

## 四、最新会话问题与解决（2026-05-15）

### 9. 快捷键/托盘呼出窗口闪烁

**现象**：按一次快捷键或点击一次托盘图标，窗口闪现后消失，需操作 3 次才能稳定显示。

**根因**：
- 全局快捷键 `tauri-plugin-global-shortcut` 的 handler 在 `Press` 和 `Release` 各触发一次
- 托盘 `TrayIconEvent::Click` 在鼠标 `Down` 和 `Up` 各触发一次
- 每次触发都调用 `toggle_window()`，一个物理动作 toggle 两次

**解决**：
- 快捷键：过滤 `ShortcutState::Pressed`（`shortcut.rs:58`）
- 托盘：过滤 `MouseButtonState::Down`（`tray.rs:30`）
- 添加 `AtomicBool TOGGLING` 防重入

**API 对照**（容易写错）：
| 模块 | 正确类型 | 正确字段名 |
|------|---------|-----------|
| global-shortcut | `ShortcutState::{Pressed, Released}` | `.state` |
| tray | `MouseButtonState::{Down, Up}` — 不是 Pressed/Released | `.button_state` — 不是 `.state` |

---

### 10. 关闭按钮和 hide() 无效

**现象**：右上角关闭按钮点击无效，快捷键无法隐藏窗口。

**根因**：`capabilities/default.json` 缺少 `"core:window:allow-hide"` 权限。Tauri 2 每个 window 操作都需显式声明。

---

### 11. Google 翻译 API Key 输入框不显示

**现象**：翻译引擎默认选中 Google 时，Google API Key 输入框不出现。

**根因**：
- Zustand store `settingsStore.ts` 中 `defaultEngine` = `"builtin"`
- 但 `<select>` 中删除了 `"builtin"` 选项（只保留 google/ai）
- React 受控组件：UI 显示 Google（第一个 option），但 state 仍为 "builtin"
- 条件 `localEngine === "google"` → false，输入框不渲染

**教训**：修改 UI option 列表时，必须同步更新 store 默认值。UI 与 state 不同步是隐性 bug。

---

### 12. 过期记录未自动删除

**现象**：`prune_old_records()` 已实现（SQL DELETE）但仅启动时调用一次，托盘应用运行数天不清理。

**解决**：`lib.rs` 启动时调用 + `std::thread::spawn` 后台线程每 3600s 执行一次。

---

### 13. 图片悬浮放大预览不生效（反复尝试 4 次）

**现象**：鼠标悬浮剪切板图片缩略图时，`transform: scale(1.22)` 不生效或被裁切。

**根因**（关键 CSS 规范坑）：
- `.panel-window-body` 有 `overflow-y: auto; overflow-x: hidden;`
- `.clipboard-list` 有 `overflow-y: auto`
- **CSS 规范**：当 overflow 一个轴为 `auto/scroll/hidden`，另一个轴为 `visible` 时，`visible` 被**强制计算为 `auto`**
- 所有祖先容器都产生 clipping 上下文，缩放后的子元素被裁剪
- 即使 JS 直接设置 `el.style.transform` 也无法绕过祖先 overflow clipping
- 即使移除 `overflow: hidden`，`overflow-y: auto` 也会产生同样的 clipping

**历次尝试**：

| 尝试 | 方案 | 结果 |
|------|------|------|
| 1 | CSS `:hover` + `overflow: visible` | 失败，祖先 overflow 强制覆盖 |
| 2 | 移除父容器 `overflow: hidden` | 失败，overflow-y: auto 同样裁剪 |
| 3 | JS `onMouseEnter` 直接改 inline transform | 失败，同受 overflow clipping 限制 |
| 4 | **Fixed-position overlay + React state** | **成功** |

**最终方案代码**：
```tsx
// 状态
const [hoverPreview, setHoverPreview] = useState<{src: string} | null>(null);

// 缩略图 onMouseEnter
onMouseEnter={(e) => {
  const img = imageSrcs[r.id];
  if (!img) return;
  setHoverPreview({ src: img });
}}

// 渲染 fixed overlay（在组件最底部）
{hoverPreview && (
  <div className="thumb-hover-overlay">
    <img src={hoverPreview.src} alt="" />
  </div>
)}
```

```css
.thumb-hover-overlay {
  position: fixed;        /* 跳出所有 overflow 容器 */
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  pointer-events: none;   /* 关键：让鼠标事件穿透，onMouseLeave 正常触发 */
  animation: fadeIn 0.15s ease;
}
```

**核心原理**：`position: fixed` 脱离正常文档流和所有 overflow 容器，`pointer-events: none` 保证 overlay 不拦截鼠标事件，缩略图的 `onMouseLeave` 能正常触发。

---

### 14. 图片粘贴卡顿

**现象**：点击剪切板图片粘贴时界面明显卡顿。

**根因**：
- `window.minimize()` 在 Windows 11 有 ~300ms 最小化动画
- `thread::sleep(200ms)` + `thread::sleep(80ms)` = 280ms 额外等待
- 全部在主命令线程同步执行，前端 `invoke()` 阻塞等待

**解决（三重优化）**：

1. `window.minimize()` → `window.hide()`（无动画，即时生效）
2. 延迟 200ms → 100ms
3. **后台线程**：将 hide/paste/show 移入 `std::thread::spawn`，command 在 clipboard write 后立即返回

```rust
#[tauri::command]
pub fn paste_image(app: AppHandle, path: String) -> Result<(), String> {
    // ... 读取文件、解码 PNG、写剪贴板 ...
    app.clipboard().write_image(&tauri_img).map_err(...)?;

    // clipboard write 完成，立即返回；hide/paste/show 在后台执行
    let handle = app.clone();
    std::thread::spawn(move || {
        paste_with_defocus(&handle).ok();
    });

    Ok(())  // 不阻塞前端
}

fn paste_with_defocus(app: &AppHandle) -> Result<(), String> {
    window.hide()?;           // 即时隐藏，无动画
    sleep(100ms);             // 等待焦点转移
    enigo Ctrl+V;             // 执行粘贴
    window.show()?;           // 恢复窗口
    window.set_focus()?;
    Ok(())
}
```

---

### 15. 新建短语按钮不透明度问题

**现象**：亮色模式按钮仍有半透明感，暗色模式按钮几乎看不到。

**根因**：
- 亮色 `#f5f5f7` → 父容器 `backdrop-filter: blur(40px)` 导致按钮视觉半透明
- 暗色 `rgba(255, 255, 255, 0.15)` 仅 15% 不透明度

**解决**：
- 亮色：`#ffffff`（纯白，不透明）
- 暗色：`#3a3a3c`（iOS 标准暗色系统灰，不透明）

---

### 16. 暗色模式快捷短语卡片左侧竖条不可见

**现象**：`.phrase-card { --color: #111; }` 在暗色背景上消失。

**解决**：`[data-theme="dark"] .phrase-card { --color: #fff; }`

---

## 五、开发环境常见问题

| 问题 | 解决 |
|------|------|
| `cargo tauri` 命令不存在 | `npx tauri dev`（tauri-cli 未全局安装） |
| `npm run tauri` 不存在 | package.json 缺少 tauri 脚本，用 npx |
| Vite 端口 5173 占用 | `npx kill-port 5173` |
| 编译失败：无法删除 exe | `taskkill /F /IM copy-creator.exe` |
| Tauri exe 进程残留 | 每次重启前 kill 旧进程 |

## 六、未解决的问题 / 待验证（给接手者）

以下四项是旧会话的待验证快照，不代表当前源码均仍未实现。新增便签与优化的进度只维护在 TODO。

1. **图片悬浮 overlay 预览** — 已实现但需在 Tauri WebView2 窗口中实测，确认 fixed 定位和 backdrop-filter 正常
2. **图片粘贴后台线程 100ms 延迟** — 如果焦点未转移导致 Ctrl+V 无效，尝试增大到 150ms
3. **capabilities 中 `allow-minimize` 权限** — 已添加但最终未使用（hide 替代了 minimize），可保留或清理
4. **快捷键录制** — 更新快捷键后需要重启才能生效

## 七、关键设计约束速查

- **CSS overflow 单轴陷阱**：`overflow-y: auto` 强制 `overflow-x` 也为 auto，裁剪子元素
- **玻璃拟态子元素不透明**：需显式设置 `backdrop-filter: none`
- **Tauri 权限**：每个 window 操作必须在 capabilities 声明
- **托盘 vs 快捷键 API 差异**：事件类型名、字段名都不同，见第 9 节对照表
- **AppHandle 跨线程**：可 Clone + Send，`WebviewWindow` 操作尽量在主线程
- **JSON 严格标准**：不能有尾随逗号或多于内容，否则 Vite 构建崩溃

## 八、便签与优化评审发现（2026-10-07，部分已实现、持续验证）

| 发现 | 当前证据与限制 | 计划处理与验收入口 |
| --- | --- | --- |
| 隐藏轮盘仍查询/挂载图片 | 源码确认；具体 CPU/内存与重复请求幅度待实测 | O-03：轮盘可见性、组件引用和双窗口请求；不只修主列表 Observer |
| 图片限流范围有限 | 并发 3 只覆盖各 WebView 缩略图队列，完整预览未经过该队列 | O-03：分别限流/合并，快速悬停和隐藏状态测峰值 |
| 初始化与搜索重复读取 | 主列表 init 和挂载搜索 effect 均读取，轮盘另行初始化 | O-04：同查询单飞/失效规则，统计 IPC，不仅丢弃旧响应 |
| 后台导入仍长持 DB 锁 | stage_images 在锁内解码并写文件；未测具体保存回退 | O-05/S-04：锁外准备、短事务复核、保存与维护调度 |
| 备份超限拒绝仍可能先占大内存 | 整体对象/序列化后才检查载荷，新增长文放大成本 | O-06/N-05：容量预检和累计有界；近上限与拒绝路径测内存 |
| 目录切换缺存储身份合同 | 后端 epoch 和便签身份核对已实现并通过测试；前端、旧模块及保存交接待接入；有便签时暂拒绝切换 | S-03/N-06：缓存刷新、后台写入屏障与联合搬迁；延迟旧响应后切库验证 |
| 恢复副本与唯一创建身份需协调 | 新方案内部合同缺口，尚无便签实现故障 | N-05：重映射 ID/引用/协议字段、独立来源去重；冲突重复导入验收 |
| 失败草稿与大正文输入需有界 | 草稿不可静默淘汰；数量/字节预算和订阅计算边界尚待实现 | N-03/N-07：保留原稿、限制新会话；256 KiB 输入/IME 测量 |
| 字体/分包/原生体积效果需分开验证 | 37 个字体已移出发布范围，实际前端产物减少 51,515,212 字节，保留产物/字体哈希不变；视觉与原生仍待测 | O-02/O-07/O-08：视觉、实际加载图和原生发布对照 |

表中区分本批已实现部分与剩余处理方向，不能将静态收益视为运行验收；完整合同在两个方案中维护，完成状态与后续新发现更新到 [TODO](TODO.md)，本批证据见[验证记录](verification/2026-10-07-notes-foundation.md)。
