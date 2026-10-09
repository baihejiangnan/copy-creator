# 受控系统剪贴板、物理快捷键与中文 IME 验收

## 实际 Windows 缩放支持矩阵补验

使用默认 `native-release-backup-metrics`，440×420 原生最小窗口。独立轮次由[显示设置助手](../../scripts/qa-display-scale.ps1)核验系统设置进程、ApplicationFrameHost 所属设置窗口及准确缩放控件，再由[控制器](../../scripts/run-dpi-matrix.ps1)实际选择 Windows 缩放；本轮未使用 Computer Use，也未使用 DPR 模拟/CSS zoom。

`dpi-matrix-1791456221739.json` 与 `dpi-visual-1791456212867.json` 记录 **100%/125%/150% × 中英文 × 亮暗主题 × 编辑/列表/卡片菜单，共 36 个组合通过**。原生 scale_factor 与 DPR 相等、viewport scale=1，导航/操作/菜单在窗口内、无横向溢出；截图逐报告独立保存，后续通过六张保持原尺寸的分组图查看全部 36 张截图，检查明显布局、字体和菜单问题；不称逐像素审计。发现暗色便签编辑器与列表仍有白色原生滚动条，已在便签区域声明亮/暗 color-scheme；新默认构建复验见[收尾记录](2026-10-08-closeout.md)。

系统缩放控件实际只提供 **100%、125%、150%、175%**，没有 200%。控制器没有启用自定义缩放、改分辨率或注销会话，finally 已核对恢复原 **125%**。报告 partialMatrixPassed=true，但全矩阵 passed=false；驱动按明确的 Incomplete DPI 原因结束，**200% 仍待验**，N-02/O-02/N-07/O-10 不整项勾选。

包装器 `controlled-clipboard-1791456209075.json` 确认停止 QA 后 **7 格式恢复、字节校验通过**；passed=false 对应矩阵未齐。此前单独预检轮 `controlled-clipboard-1791456077950.json` 仅做 125% 一个组合后主动中止，也已停止/恢复 7 格式；历史中止文案不能代表已执行全部缩放。

## 实际 Windows 缩放验收尝试

本轮通过 Computer Use 打开 Windows 显示设置，读到当前 **125%、1920×1080 横向**。尚未修改系统缩放，QA 会话启动后设置窗口出现用户输入保护；刷新状态又提示最小化，恢复激活仍被输入保护拒绝。因此停止对该窗口继续输入，系统保持原缩放。没有实际 100/150/200% 测试，不能以浏览器 DPR 模拟、CSS zoom 或已有 125% 结果替代。

[会话驱动](../../scripts/verify-dpi-session.cjs)准备了默认 Release 最小窗 440×420 的三缩放、中文/英文、亮/暗色、编辑/列表/卡片菜单矩阵，并要求真实原生 scale_factor、WebView DPR 及 viewport scale 一致。完成条件现逐一要求 36 个不同组合，不只计截图总数；驱动本身尚未完成该矩阵验证。

`dpi-visual-1791454460003.json` 因合成记录 source_app 前缀不符合夹具限制而提前失败；修正为允许的 `QA ` 前缀后，`dpi-visual-1791454475226.json` 只到 session ready、原生 scale_factor=1.25。终止请求当时尚未有 abort 分支，故报告为 Unsupported DPI session command，不能算通过；驱动后来补了明确 abort 失败和严格矩阵检查。两轮自己的夹具均清理、QA 设置恢复，包装器 `controlled-clipboard-1791454456871.json` / `1791454472468.json` 均确认停止 QA 后 **4 格式恢复、字节校验**。旧报告 scope 是预定流程描述，实际未改变/恢复 OS 缩放，以上实测步骤为准。没有保存 Windows 设置账户信息到项目证据。

本项仍是 N-02/O-02/N-07/O-10 的验收缺口；后续在能稳定获取系统设置状态时执行实际矩阵并恢复原设置。

## 环境与授权

使用 `QA-notes-20261007/native-release-search-index` 完整默认 Release，WAL/FULL、schema 5、默认监听和全局钩子，frontend-native-visibility。EXE 46,142,976 字节、SHA `e6d7770dbd96b37c7c703f852c87aa898dd9cd40d181fe7b469795186ffceb88`。QA 标识、路径、SHA、实际原生存储身份在驱动前检查；数据库/文件/密码均为合成夹具，未访问生产库。

用户明确批准「允许受控验收并恢复剪贴板」。[包装器](../../scripts/with-controlled-clipboard-qa.cjs)先在 QA 停止时通过[保护助手](../../scripts/protect-qa-clipboard.ps1)在私有内存保存原格式，写合成哨兵后启动应用；结束先确认保存屏障/停止 QA 监听，再恢复并在内存比较字节格式。原内容、字节及摘要不输出到报告。原生输入助手仅接受精确 QA 主窗与自己创建的专用文本框，无任意目标 HWND 或任意键盘输入接口。

## 实际通过

reports/controlled-desktop-1791389014945.json 与 reports/controlled-clipboard-1791389012060.json：

- 实际便签「复制地址」保留中文、空格、逗号的完整外部文件路径；「复制正文」保留 CRLF、空白及 emoji。外部文件不变。
- 从专用文本框发送真实 Ctrl+Shift+右键，完整默认版的主窗实际显示；原生 `paste_text` 恢复该文本框焦点并真实 Ctrl+V，78 字符合成正文准确插入。目标前台和 textboxFocused 均 true。这不是仅派发产品内部事件的轮盘测试。
- 系统剪贴板写入 103 字节合成文本，默认监视器采集后经实际卡片菜单收为便签。已有普通采集 `trim` 后历史正文 100 字节，便签与该完整历史正文逐字一致。明确区分 OS 原来源和已存全文，没有把规范化后的记录称作原 OS 字节。
- Windows 键盘布局 134481924 下真实 SendInput 字母触发 compositionstart/update/end；协调器 composing=true。候选未提交停留 2,250ms，数据库 revision 保持 1；空格提交中文候选后准确保存，revision=2，编辑器与 DB 正文相等。没有手工派发 composition 事件。
- QA 保存屏障通过、进程停止；**7 格式恢复，字节格式校验 true**。

## 失败和范围

先前失败报告保留：首轮 CDP 页面尚未就绪，停止驱动同样失败，后来单独确认屏障、停止 QA，再让保护助手 EOF 自动恢复；这一轮没有取回逐格式恢复回执，不能写成已校验通过。后续失败轮均有显式恢复成功回执。保护助手最初在 Console 同步读取上阻塞 Windows 消息泵，影响其他进程替换剪贴板；已改 C# Task.Run 读取命令并持续 DoEvents。此处是测试设施缺陷，不作为产品复制失败结论。

另有前台焦点拒绝、单行搜索框去掉换行导致夹具查询不匹配、一次专用文本框未收到粘贴等失败保留；目标助手改为先恢复原生前台再明确聚焦文本框，最终完整轮通过。尚未覆盖持续快速粘贴、目标关闭或用户抢焦点，不以单轮通过承诺全部焦点竞态已排除。IME 这里验证普通正文组合输入和保存时机，长正文 Paint 证据仍见[第七批](2026-10-07-durability-pressure.md#长正文发现与修复)。

## 默认搜索与边界保存补验

native-acceptance-1791389101953.json 在同一完整默认 Release 中复验中文/生僻字/emoji、ASCII 大小写、字面 `%_`/反斜杠/引号、短查询、NUL、引用命中/移除、创建重试幂等、旧 revision 冲突、四种整理动作/过滤和旧 epoch 拒绝。260,004 字节正文 +20 引用的 110 轮排除前 10 后：保存 **P95/P99 25.7/39.9ms，最大 57.2ms**，正文/引用和最终 revision 一致；不是输入到 Paint 或联合压力指标。对应 controlled-clipboard-1791389098993.json 的 7 格式恢复/字节校验通过。

这些证据补齐 N-02 的实际复制/采集、N-03 的真实 IME 部分及默认索引语义，不替代其余 DPI、设置联合/故障、含图片/密码箱备份、全部运行回归和首发预算。状态以 [TODO](../TODO.md) 为准。

## 设置与便签联合交接发现

[联合驱动](../../scripts/verify-lifecycle-joint.cjs)使用真实设置/便签参与者及原生重启、托盘 Quit，注入仅前端便签 transport 故障，不伪装成磁盘故障。首轮协调器未初始化、次轮误用 failed 而非实际 error 状态均属于驱动错误，报告保留。lifecycle-joint-1791389359839.json（以实际 reports 文件名为准）后续确认：无效设置阻止重启且草稿保留/参与者恢复；便签交付失败阻止真实托盘退出且稿保留；真实 10s 保存超时后重启取消，晚确认不会启动旧重启或清除后续输入；实际隐藏按钮联合保存设置与便签、进程继续。

最后正常托盘 Quit 的保存完成，却没有实际结束进程，屏障留在 terminal busy。lifecycle-joint-stuck-state.json 确认恢复稿为空、设置 pending=0、值与已存值相同、无错误；只读磁盘检查正文/设置一致、revision=7、integrity=ok。此轮**退出失败**。救援仅停止哈希确认的 QA 与失效包装器，让保护助手 EOF 自动恢复；没有该轮逐格式恢复回执，不能写成已校验成功。

Windows 退出改为在所有保存确认、原生生产者/任务排空和敏感资料清理完成后，排到 Tauri 主线程执行已安装 API `cleanup_before_exit`，随即结束进程；与此前已修复的主线程重启路径一致。失败/超时仍不能进入此路径。完整 Rust **127 通过、0 失败、3 基准忽略，14.41 秒**；新默认 Release 正在构建，实际联合退出复验前不算修复验收完成。保护助手另增加只含布尔/格式数的磁盘恢复回执和精确恢复请求标记，后续异常救援无需丢失恢复回执。

native-release-joint-exit 已构建，**46,143,488 字节**，SHA `63cb32ac79c88c48ea063c029aec67956703f658be7baa3c688cd7762e36e542`，60.54 秒；相同前端、全部默认功能。reports/lifecycle-joint-1791389702513.json 在新产物完整复验上述设置错误、保存失败、真实 10s 超时及晚确认、隐藏联合保存，然后正常托盘 Quit：**进程实际结束**，只读磁盘正文/未显式提交的设置均一致、revision=7、integrity=ok。reports/controlled-clipboard-1791389697425.json 和助手的独立恢复回执确认 **4 格式恢复、字节校验 true**。这一成功范围是本次修复及所列交接场景，其他备份/搬迁故障和全应用运行预算继续。


## 备份与设置便签的排空暂停恢复

[备份交接驱动](../../scripts/verify-backup-handoff.cjs)使用最终同协议默认 `native-release-storage-events-complete`，`reports/backup-handoff-1791408352669.json` 通过实际数据页/原生文件选择器验证：

- 注入便签传输失败时实际导出被拒绝，正文保留为 error，设置与便签恢复编辑，未生成备份；恢复传输后可保存。无效 URL 设置也阻止导出并保留纠正入口。
- 未保存便签及设置经统一屏障提交后才打开原生导出框。模态框保持真实原生 lease 时，20 次便签读取、1 次保存、1 次设置写入和1 次清理均立即按 notes.busy/lifecycle.busy 拒绝；协调器编辑返回 notes.paused，两类参与者均暂停。没有把正确的排他暂停当作运行中保存延迟。
- 实际取消原生对话框后 lease 释放、设置与便签恢复，随后新稿成功导出 **8,191,106 字节** v3 加密备份。继续编辑/保存成功。
- 实际认证预览/导入刚导出的备份，导出时未保存正文逐字符恢复为一个冲突副本，导出后较新的本机正文保留，证明保存确认与备份快照一致。导入提升 epoch，原设置最终恢复。

包装器 `controlled-clipboard-1791408350222.json` 确认停止 QA 后 4 格式恢复/字节校验。夹具只含合成主密码、API Key、正文；未访问正式资料。此轮使用正常约 8MiB 备份，近容量富内容内存/原子回滚使用独立记录；后台分段锁时长及整小时 TTL 并发没有在此冒充通过。

## 原生交接无响应与迟到事件

[无响应驱动](../../scripts/verify-lifecycle-unresponsive.cjs)在当前完整默认 `native-release-clipboard-content` 上，通过真实 Tauri callback Map 暂留原生 `lifecycle-save-request`，没有伪造成功确认。`reports/lifecycle-unresponsive-1791428248607.json`：实际重启申请约 15,080ms 后到期，期间第二次申请按 lifecycle.busy 拒绝；到期后真实 token 的成功确认按 lifecycle.expired 拒绝。再放行旧真实事件也不能结束应用；应用仍响应，后续真实导出 lease 可申请并正常释放。没有丢弃草稿。

包装器 `controlled-clipboard-1791428244876.json` 确认停止 QA 后恢复 4 格式、字节校验通过。此证据覆盖前端交付无响应及原生超时保护，不宣称真实 WebView 崩溃/重载、启动未就绪或磁盘故障已经验收。
