# P2 监听、提示与分组复用验证

2026-10-10，接续本地 `455f252`，按用户“开始”继续修复 P2-1/3/4/18。开发版本保持 0.2.28、schema 6、备份 v4。任务状态仅维护在 [TODO](../TODO.md)；本页保存实现和实跑证据。发行仍暂停，没有推送、签名打包、标签或 Release。

## 改动与依据

| 条目 | 实现位置 | 变化 |
| --- | --- | --- |
| P2-1 | `copy-creator/src/stores/clipboardStore.ts:107`、`:157`、`:314` | 五个原生监听统一交给 `ownEventSubscriptions`；卸载/HMR 同时释放原生监听、存储身份订阅和 beforeunload。迟到注册立即退订，注册失败被捕获；身份查询迟到时阻止已销毁 store 继续查询。`init` 仍只注册一次，页面普通卸载不会销毁共享 store。 |
| P2-3 | `copy-creator/src/pages/ClipboardPage/utils.tsx:18`、`index.tsx:9` | 图标在元数据定义处完整初始化，类型只读；删除页面模块加载时的五处赋值和失去用途的导入。颜色及图标映射保持。 |
| P2-4 | `copy-creator/src/stores/vaultStore.ts:37`、`:144`、`:157` | 复制/填入共用一个提示计时器，新提示重新计满 2500ms；锁定、清除选择和开始填入时取消旧计时器，保留原 epoch 守卫。修复同一代次提前清除提示的问题，不声称原实现会污染新代次。 |
| P2-18 | `copy-creator/src/pages/NotesPage/index.tsx:68`、`:171`、`:178`；`PhrasePage/SuijiPage.tsx:84` | `NoteEditor` 必须接收父级 groups，两个入口均明确传入，编辑器不再创建第二组查询和三项事件订阅。未建立跨窗口单例缓存。 |

没有修改 Rust、数据库迁移、Key/密码箱保护、保存屏障或中英文文案。测试 adapter 仅替换原生、React 和计时边界，执行实际 store/TSX 源码。

## 自动检查

所有命令从内层 `copy-creator/` 执行。最终前端检查在身份迟到守卫补齐后重跑。

| 实跑命令 | 结果 |
| --- | --- |
| `node --experimental-strip-types --test tests/p2Lifetimes.test.ts` | 13 通过。覆盖 unload/HMR/迟到注册/注册失败、卸载中身份读取、独立图标导入、四种连续复制/填入组合、锁定/清除选择取消计时器、两种实际父页面+编辑器的单次订阅与数据传递。 |
| `pnpm test:unit` | 117 通过，0 失败；日志 `output/p2-unit.log`。 |
| `pnpm exec tsc -b` | exit 0。 |
| `pnpm lint` | exit 0。中途发现测试变量可用 const，修正后完整重跑。 |
| `pnpm build` | exit 0，594ms；日志 `output/p2-build.log`。构建通过不等于桌面功能通过。 |
| `$env:TEMP=.../output/tmp-rust; $env:TMP=$env:TEMP; cargo test --manifest-path src-tauri/Cargo.toml` | 178 通过、5 忽略、0 失败；日志 `output/p2-rust.log`。 |
| `pwsh -NoProfile -File ../scripts/qa-process-isolation.ps1` | QA 启动前与恢复收尾均 exit 0、实时测试原生进程 0。 |
| `git diff --check` | exit 0。 |

## 反向验证

运行 `node ../output/reverse-p2.mjs`。每个场景临时替换真实生产源码，断言失败后在 finally 按原始字节恢复并核对 SHA256；未改测试来制造失败。随后最终 117 项全部通过。

| 回退 | 红灯依据 |
| --- | --- |
| P2-1：将 clipboardStore 恢复为 HEAD 的仅一个句柄写法 | unload 未退订四个句柄；HMR 无清理接线，测试失败，exit 1。 |
| P2-3：元数据和页面恢复为 HEAD 的先置 null、导入页面后再赋图标 | 单独导入 utils 的五个图标不完整，断言失败，exit 1。 |
| P2-4：恢复 HEAD 的两处无句柄 setTimeout | 连续操作的新提示在旧截止点提前清空；清除状态后计时器未取消，断言失败，exit 1。 |
| P2-18：两个父页面及编辑器恢复为 HEAD 写法 | 父页面+编辑器订阅数为 2，数据传递/次数断言失败，exit 1。 |
| P2-1 补充：单独删除身份 await 后的 disposed/generation 守卫 | 已销毁 store 仍发一次读取，期望 0 得到 1，断言失败，exit 1。 |

日志和恢复核对：`output/p2-reverse/*.log`、`results.json`；脚本及日志仅作本地证据，不提交 output。

## 隔离桌面尝试与恢复

冻结前端 `frontend-radial-p2-20261010`，运行：

```powershell
pwsh -NoProfile -File ../scripts/build-qa-default.ps1 -Frontend frontend-radial-p2-20261010 -Variant native-release-radial-p2-20261010
pwsh -NoProfile -File ../scripts/select-stopped-qa-build.ps1 -Variant native-release-radial-p2-20261010
node ../scripts/with-controlled-clipboard-qa.cjs verify-radial-notes.cjs
```

构建成功：identifier `com.copycreator.qa20261007`、默认 Release/WAL FULL、EXE 46,924,288 字节，SHA256 `EB2DEF41157BAEA867AD18AF62053F0AD96473D51325DCD35091E1E5C7E9CEDB`，122.18 秒。这是内部 `--no-bundle` QA 构建，不是发行产物；它冻结于最后一处身份迟到守卫补齐之前，不能代表最终源码验收或性能。

四轮启动均未进入驱动断言：原生 setup 报 `unable to open database file`，CDP 连接随进程退出被拒绝。分别尝试既有合成夹具、新建空夹具、仓库内 TEMP/TMP，以及仅隔离 QA 目录的临时写 ACL；均失败。独立 Rust/SQLite 探针确认：仓库内合成数据库可开启 WAL，AppData 下 QA 库开启 WAL 失败；原生 `OpenOptions` 新建与已有文件读写均返回 Windows code 5 / PermissionDenied。Python 对同一隔离库可写，说明存在运行环境/进程权限差异；不据此归因于应用逻辑回归，也不声称 ACL 修改足以解除限制。

四轮外层保护均在进程停止后恢复原剪贴板，并回报 `restored=true`、`byteFormatsVerified=true`、7 种格式。报告位于 QA 根的 `reports/controlled-clipboard-{1791638884905,1791639015459,1791639063674,1791639180787}.json`。日志 `output/p2-radial-{qa,fresh-qa,temp-qa,acl-qa}.log`。原始剪贴板值仅保留在 helper RAM，没有导出正文。

仅修改过隔离 QA 数据库的 storage_path 与隔离 QA 目录 ACL，已分别恢复原始值、原始 SDDL 并核对；没有访问生产数据库或密码箱。QA 选择仍指向上述新内部构建，原有构建快照保留；旧 QA 存储路由恢复。准备的驱动未能实跑，已从 scripts 移至 `output/verify-radial-notes-prepared.cjs` 保留，临时白名单变更撤回，没有将未验证的驱动纳入正式脚本。

## 待验收边界

- 四项自动回归完成；真实 WebView/HMR、提示持续时间和分组 IPC 数量仍需桌面实跑。
- P1-1 主窗隐藏未落盘、保存冲突/超时、迟到确认、旧短语升级、新随记分组、切库、文件引用、物理手势与外部目标实际插入，本轮均未得到新的桌面通过证据。
- 历史连续粘贴第 17/20 次为空的问题仍未关闭；不能用这次构建或单元测试覆盖它。
- P2 其他兼容/缓存/迁移项、需逐条评估的 P2-6/7/12/13/14，以及其余 P3 保留，后续顺序以 TODO 为准。
