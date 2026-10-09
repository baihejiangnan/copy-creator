# Windows Terminal 权限提示与主动管理员重启

## 用户确认与实现

用户实测确认：普通 Copy Creator 向管理员 Windows Terminal 的 PowerShell/CMD 标签页无法自动填入，普通权限终端正常。本次按用户后续要求加入主动管理员重启选项，不要求目标程序降权，也不修改终端默认权限。Windows 的输入注入受 UIPI 限制，`runas` 会请求管理员授权，参见 [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)、[ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw) 和 [runas](https://learn.microsoft.com/en-us/windows/win32/shell/launch)。

- `paste.rs` 查询本进程和已捕获目标窗口进程的提升令牌。只在确认本进程未提升、目标已提升时拒绝；查询未知不误报。检查先于窗口隐藏/按键注入，私密填入还先于资料复制。
- 普通内容仍在剪贴板，固定原因 `requiresElevation` 通过当前存储身份事件显示主窗提示。旧身份/未知原因被忽略，旧 `true` 通用失败事件继续支持，身份变化清除提示。
- 普通提示和密码箱错误区域提供「以管理员权限重启」。用户点击后，主窗专用命令进入既有保存协议；便签/设置保存、后端排空完成后锁定密码箱、清理仍拥有的敏感剪贴板，再由 `ShellExecuteExW(runas)` 启动同一 EXE。
- 新进程仅接收旧进程 PID，复用启动前等待机制，在旧进程退出后才打开数据库和系统集成。UAC 取消/启动失败返回固定错误、恢复原应用；已锁定密码箱需重新解锁。不修改启动权限默认值，不传递或自动重放选中内容。
- 中英文文案和按钮样式随源码更新。正式运行的 `0.2.25` EXE 未替换；本改动并入 0.2.26 发行提交。

## 检查结果

环境为 Windows 11、Windows Terminal、PowerShell 7.6.6。只使用标识 `com.copycreator.qa20261007` 的隔离 Release、合成数据库和不会执行输入的原生控制台接收器；未读取正式数据库/密码箱内容。

| 检查 | 实际结果 |
| --- | --- |
| 前端构建/类型检查、相关 ESLint | 通过 |
| 前端单元测试 | 81 通过 |
| Rust 全量单元测试 | 152 通过，4 忽略 |
| 原生权限/目标检查 | 7 项定向通过；其中显式选定现有管理员终端 PID 的忽略测试只读令牌，确认本进程未提升/目标提升，不发送按键 |
| UAC 错误与保存协议 | 单元测试区分取消和启动失败；已取消、超时、旧会话的保存确认不能批准管理员重启 |
| 普通终端实际粘贴 | Ctrl+V、Ctrl+Shift+V、产品 `paste_text` 的合成中文原文均准确、目标焦点保持；不是任意终端命令执行验收 |
| 权限提示与取消反馈 | 原生合成事件显示权限原因/重启按钮；关闭、旧身份/未知原因过滤、兼容通用失败、身份切换清除通过；取消反馈以合成生命周期事件验证 |
| QA 实例准入 | 9 项合成边界通过；补充原生有限权限路径查询，不能因 WMI 隐藏管理员实例路径就把它视为不存在；不能确认候选路径时拒绝下一轮 |

最终隔离产物：`output/optimization/QA-notes-20261007/native-release-paste-admin-option/copy-creator.exe`，46,645,760 字节，SHA-256 `0B6ACF64320899AEAA60108445EE7E7512B0ABBE2046924C822A104090E5DCC9`；前端冻结在 `frontend-paste-admin-option`。这不是正式安装包，也不作为体积优化对照。

同 SHA 的普通三种粘贴及提示分项报告为 `reports/terminal-paste-1791544444935.json`；外层 `reports/controlled-clipboard-1791544440966.json` 全通过，QA 保存屏障/停止完成，原剪贴板 6 格式恢复、字节格式校验通过。最小 440×420 逻辑窗口中英文/亮暗共 4 组合几何及截图通过，提示和按钮均在视口内，普通产品粘贴再次原文准确，视觉语言/尺寸恢复，见 `reports/terminal-paste-1791544551790.json`；对应 `controlled-clipboard-1791544547505.json` 全通过、监听器停止后恢复/校验 6 格式。最后全 QA 根实例清单为零，终端默认 `elevate:true` 保留，临时 QA profile 数为零。

## 测试故障与恢复

1. 初期直接从终端默认管理员 profile 启动接收器失败，并在现有管理员终端增加过合成标题的测试标签页；没有向这些失败标签发送粘贴输入。后续使用唯一临时 profile，显式 `elevate:false`，结束时精确移除该条配置；默认管理员设置保留，不关闭用户整个终端。早期失败标签若仍在，可关闭名称以 `CopyCreator terminal QA` 开头的标签。
2. 接收器 Unicode 结构最初缺少 `CharSet.Unicode`，导致记录中文失真；修正后对照和产品输入准确。这是夹具问题，不作为产品修复前失败证据。
3. 首轮新分包产物的保存屏障移至 `lifecycle` chunk，旧收尾脚本只从 `main` 查找而失败。保护程序保留了原剪贴板快照；修正 `flush-qa.cjs` 只检查已加载、同源的 `main/lifecycle` 模块并要求唯一真实屏障后停止 QA，恢复 4 格式并校验一致。保留失败报告 `controlled-clipboard-1791532924062.json` 和恢复回执 `clipboard-recovery-150404.json`；后续完整轮通过，不把失败轮改为成功。
4. 新重启按钮的自动测试尝试给不可写的 Tauri `invoke` 属性赋 mock，赋值未生效，点击触发了真实提权重启。旧实例退出，管理员后继 PID 127796 的实际 EXE 路径和 SHA 已核对；WMI/普通进程接口未返回其路径，暴露了旧 QA 进程清单的漏检。管理员后继未继承 CDP 调试入口，因此该轮不是完整验收通过。
5. 专用 UAC 清理脚本只核对并结束该 PID/EXE/SHA，回执 `elevated-qa-cleanup-127796.json` 确认已停止，正式应用未动。停止后仅按失败轮开始时间核查隔离库新增行，未读取内容，新增 0 行，完整性 `ok`，见 `elevated-qa-data-cleanup-127796.json`。失败轮剪贴板 6 格式已恢复/校验，但恢复时管理员监听器尚在，不把当时旧进程清单的“零实例”作为可靠证据。
6. 自动驱动现明确不点击真实提权按钮；取消反馈改用合成生命周期事件。补进程路径查询与拒绝未知候选后，重跑完整普通终端/提示轮通过，最后停止监听器再恢复剪贴板。失败轮 `terminal-paste-1791544014022.json` / `controlled-clipboard-1791544008109.json` 保留。

## 尚未完成的桌面验收

真实 UAC 取消后原进程继续可用、保存失败时不出现 UAC、管理员后继的令牌/同库存储/全局快捷键恢复、向隔离管理员目标完整填入、私密字段的复制前拒绝及重新解锁填入仍需受控桌面验收。意外触发的一次真实启动不是完整链路验收；合成取消事件和原生错误映射测试不冒称实际 UAC 取消。

本次没有验证 PowerShell 5.1 或 CMD 的独立交互流程，也没有重新验收轮盘/托盘全部入口。用户已提供普通/管理员 PowerShell/CMD 对照，但项目此前普通/托盘偶发空粘贴仍保留独立缺口，不因权限原因明确而宣称全部粘贴问题解决。状态以 [TODO](../TODO.md) 为准。
