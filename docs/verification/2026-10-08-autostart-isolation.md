# QA 自动启动名称隔离与恢复

## 遗留实例补查与实时进程准入

后续完整进程清单发现，搜索实验实例 PID 125744 从 2026-10-07 23:23:22 持续运行，未被只核对当前默认 `process.json` PID 的停止检查覆盖。其冻结 EXE SHA 为 `61bc740d6b578d4c42806133126e4846f8dd30601c36b0f4ca257073909f1f12`。此前“QA 已停止”的回执只证明所选默认进程停止，不能推导全部历史实验实例已停止。

源码核对确认该搜索实验禁用系统剪贴板监控、全局快捷键及启动修复，但仍有周期清理及旧共享图片临时目录回收。因此共享临时目录的未知影响窗口延续到本次停止；没有正式临时目录的历史清单，不能推断实际删除项或声称已恢复。此前性能样本也存在未控制的后台实验进程，不量化未知干扰。未访问正式数据库或正式临时目录。

按其元数据核验实际 PID/路径/EXE 摘要，以真实保存屏障确认后仅结束该实例，`reports/legacy-search-qa-stop-20261008.json` 留存结果；这属于测试助手停止，不算原生 Quit 验收。旧搜索启动脚本现直接拒绝，拒绝发生在复制数据库、替换 EXE 或启动之前。

[实时准入检查](../../scripts/qa-process-isolation.ps1)只读 Windows 实际可执行路径，覆盖本项目 QA 根目录及共同运行基线根目录的所有后代实例；不依赖被选择元数据中的单个 PID，不结束任何进程。默认启动器、基线启动器和受控包装器接入；包装器在创建剪贴板保护助手前检查。7 个合成边界用例通过，覆盖默认/搜索/基线包含与正式程序、相似前缀、空路径、规范化后无关路径排除。

实际默认 `native-release-periodic-errors` 运行时，[集成驱动](../../scripts/verify-qa-process-isolation.cjs)确认独立检查、默认启动器、嵌套受控包装器全部按当前 PID 拒绝，嵌套包装器未启动剪贴板助手；旧搜索入口直接拒绝。前后只有当前一个 QA 原生进程，元数据及 EXE 摘要不变。成功报告 `qa-process-isolation-1791454912949.json`；外层 `controlled-clipboard-1791454909132.json` 确认保存屏障、停止 QA 后 **7 格式恢复、字节校验通过**。首轮 `qa-process-isolation-1791454896797.json` 因 PowerShell 单元素 JSON 为标量，驱动 `.sort` 失败，尚未执行拒绝断言；修正驱动数组归一化后通过，该失败轮也恢复/校验 7 格式。基线启动器的接入已检查，但未运行旧基线 EXE 作为集成测试，缺少隔离的基线仍禁止重放。

该检查是顺序执行验收的启动条件，不声称提供跨机器控制或并发启动的原子互斥。后续性能比较开始前及收尾均检查实时清单，旧结果保留上述环境限制。

## 实际发现及影响范围

默认 QA 使用独立 `com.copycreator.qa20261007` 标识，但产品名沿用 Copy Creator。检查本机锁定版本的 tauri-plugin-autostart 2.5.1 和 auto-launch 0.5.0 源码发现：Windows Run 项按应用名称识别，不按应用 identifier 或 EXE 路径识别。原生启动时已有的 `is_enabled → enable` 修复因此会把同名正式版 Run 项改为 QA EXE，并带 `--hidden`。

只读注册表核查确认这一副作用已发生，不能把先前的独立数据库/标识等同于全部系统集成隔离。先前合成数据、测量样本和剪贴板恢复证据保留；其范围须加上本项系统自动启动污染。未访问正式版数据库、密码箱、剪贴板历史或备份，未结束正在运行的正式版进程。

## 已执行恢复

确认 QA 停止、Run 值精确等于本次 QA EXE + `--hidden`，并核验当前运行的正式版进程、产品名与 0.2.24 版本后，仅将 Copy Creator Run 值恢复为该正式版可执行文件 + `--hidden`；读取回验一致。未修改 StartupApproved。收据为 `output/optimization/QA-notes-20261007/reports/autostart-restoration.json`，不输出用户路径。

原始历史启动参数没有留存，所以这属于恢复到已核验的当前正式版及既有隐藏启动语义，不能声称未知原注册表字符串逐字恢复。

## 修复与验收

[原生入口](../../copy-creator/src-tauri/src/lib.rs)由同一 Tauri context 的产品名与 identifier 设置插件名称。正式 `com.copycreator.app` 保留原 Copy Creator 名称；其余标识使用 `产品名 (identifier)`。macOS launcher 默认值与 `--hidden` 参数保持。新增回归覆盖正式名称兼容及两个不同 QA 标识互不相同；全量 Rust **128 通过、3 基准忽略、0 失败**。

默认/profile 构建脚本检查修复入口，并在成功构建元数据标记 `autostartIsolation=identifier`。选择器保留旧产物而标为 legacy；启动器与受控剪贴板包装器拒绝 legacy，不能改标记后重放旧 EXE。

新默认 Release `native-release-autostart-isolation`：frontend-page-transition、WAL/FULL、完整默认功能，**46,080,000 字节**，SHA `04e0cd16b398feba623eeaacb2d5ce388d5a9d1ecfb6856a15ad8dbbbb1fd17e`，本轮构建 56.795 秒。体积变化不是独立编译参数收益；此前同源码 profile 对照的结论仍仅适用于对应冻结产物。

[实际 UI 驱动](../../scripts/verify-autostart-isolation.cjs)及[只读 Run 守卫](../../scripts/guard-qa-autostart.ps1)确认：

- 新 QA 已启动后，正式版 Run 值仍等于已核验的恢复结果；原值只在守卫内存比较，内容/路径/摘要不写入报告。
- 实际「开机启动」开关由关闭到开启，插件写入独立 QA 名称及精确 QA EXE/隐藏参数；正式版值不变。
- 实际开关关闭后 QA 项不存在，正式版值不变。没有修改正式版启动批准状态。

成功报告 `reports/autostart-isolation-1791405173219.json`；包装器 `controlled-clipboard-1791405170961.json` 确认保存屏障、停止 QA 监听后 **4 格式恢复、字节校验通过**。首轮 `autostart-isolation-1791405096790.json` 使用了仅错误提示出现的设置按钮选择器，等待超时，尚未开启测试项；修改为真实设置按钮后通过。失败轮包装器也确认 4 格式恢复/字节校验通过。

这次验收覆盖名称隔离与真实开关；不把它写成登录重启后的系统开机启动验收。状态和剩余工作以 [TODO](../TODO.md) 为准。

补验开启状态下的新进程启动修复：`autostart-isolation-1791405749184.json` 实际开关开启后走所属托盘正常 Quit、再启动不同 PID，系统插件及初始化后的设置页均仍为开启，QA Run 路径/隐藏参数准确、正式值不变；实际开关关闭并移除 QA 项。包装器 `controlled-clipboard-1791405746886.json` 确认 4 格式恢复/字节校验通过。前一轮 `1791405718482.json` 在设置异步初始化尚未完成时读取默认 false 而失败，恢复路径已移除自有 QA 项、正式值不变、剪贴板 4 格式恢复；改为等待实际 fieldset 初始化完成后整轮通过。此处启动修复已复验，仍未执行 Windows 注销/登录。

## 图片粘贴临时文件的共享目录补查

后续源码检查发现，图片复制将 CF_HDROP 文件写到全局 `copy_creator_paste`，剪贴板过期清理也遍历该目录。独立 QA identifier 原先没有隔离这项文件写入/清理；此前默认 QA 的启动清理可能触及满足保留期的正式临时图片。没有之前的目录清单，不能证明实际删除过哪些文件，也不能声称已恢复未知文件；本轮未读取、枚举或修改正式临时目录。历史合成验收证据保留，但系统隔离范围还须加上这个限制。

现在正式 `com.copycreator.app` 保留原目录兼容；非正式标识统一使用另一根 `copy_creator_paste_instances/<identifier SHA256>`，写入和过期清理调用同一个 helper。固定摘要组件避免路径转义，两个测试身份互不清理，未改图片/HTML/PNG/文件格式功能。新增回归覆盖正式兼容、不同身份/相同身份与不安全标识，全部 Rust **133 通过 /3 忽略**。

最新完整默认 `native-release-paste-isolation` 为 **46,320,640 字节**，SHA `99fe862178056551c94106d11ad9d70b6793f7f4e6bfc63ba3c462b5eb192dd9`，缓存构建 78.140 秒；前端复用 `frontend-clipboard-errors`。这不是编译参数独立对照，不用其字节差推导优化收益。

[默认启动清理驱动](../../scripts/verify-paste-temp-isolation.cjs) 在两个非正式身份目录分别放置过期 10 天的合成文件，只暂时将合成库保留期设为一周，再真正启动默认 EXE。`paste-temp-isolation-1791435891808.json` 确认本身份文件被清理、另一个身份文件内容保持；停止 QA 后恢复原保留设置，移除本次夹具。包装器 `controlled-clipboard-1791435887980.json` 通过，4 格式恢复/字节校验。

选择器根据冻结的 paste/db 源码及清单哈希标记 `pasteIsolation=identifier`；旧默认/profile 和共同运行基线产物无此隔离，不再允许重放。默认启动器/受控包装器和基线启动器均拒绝缺少该标记的样本，后续基线须按相同隔离修正重建，保留原行为与旧数据版本限制。`paste-temp-legacy-guard.json` 实际临时设为 legacy，确认默认启动器在启动前拒绝、包装器在保存/读取剪贴板前拒绝，随后精确恢复 QA 元数据；没有运行旧 EXE。

同最新 SHA 的 `copy-worker-drain-1791435920953.json` 再通过真实原生粘贴/交接排空、忙提示/失败恢复、文件复制和图片四格式/像素；图片 CF_HDROP 实际指向并存在于本 QA 摘要目录。包装器 `controlled-clipboard-1791435918551.json` 通过，4 格式恢复/字节校验。托盘/真实 IME 等后继验收见[复制交接](2026-10-08-copy-handoff.md)，整体剩余项目见 [TODO](../TODO.md)。

同新 SHA 的 `controlled-desktop-1791435943288.json` 再通过普通复制/粘贴、实际原生托盘复制/粘贴、物理快捷键、默认监听捕获便签及真实中文 IME。包装器 `controlled-clipboard-1791435940836.json` 通过，4 格式恢复/字节校验。
