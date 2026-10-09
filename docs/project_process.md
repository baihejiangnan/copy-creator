# Copy Creator — 开发日志

## 2026-10-09 — 收尾证据归并

连续粘贴排查补到实际卡片点击路径，20 轮成功与第 3/4 轮失败并存；目标收到 Ctrl+V/WM_CHAR=22，原文、焦点与前台正确，空目标稍后直接 Paste 诊断成功。剪贴板忙/空闲检测均出现过失败；探针改为不打开剪贴板的只读观察后仍复现，尚未定位占用或根因，不再凭猜测接入产品候选。各轮停止 QA 后 4 格式恢复/字节校验。20MB 按用户指示保留参考目标和真实 32.17/33.93 MB 包体积，未通过的联合验收保留，见[具体证据](verification/2026-10-08-closeout.md#连续粘贴的未完成验收)。

按用户尽快收尾要求，核对现有源码和原始报告，收回 S-04 有界调度、O-05 DB/容量热点、O-06 备份容量/内存及 O-09 条件候选取舍。保存/清理并发、备份原子回滚/分项、实际一小时核心和失败恢复分别引用既有证据，没有重复启动小时测试或增加产品候选。读连接池、通用虚拟列表及图标替换暂缓理由写入优化方案；20MB 为用户接受的尽力参考，全应用 80MB 和其余联合验收仍未完成。见[归并依据](verification/2026-10-08-closeout.md#已有验收证据归并)。

当前版共同运行补完：30 新进程、100 查询/各常用页导航与显隐采样通过，语料完整；显式 show/focus 控制计入启动观察，P95 1755ms，不与旧轮直接算收益。全树 private 中位数 494.21/490.42MB，仍超过 80MB。原生产原生与最终默认一致、前端早于滚动条 CSS，范围单独说明。QA 停止、7 格式恢复/字节校验、全根实例为零，见[后继完整轮](verification/2026-10-08-runtime-baseline.md#当前版显式显示控制后的完整轮)。

当前默认查询 IPC 验收收回 O-04：100 次同查询调用 100→1、已加载页重复调用为 0；同 WebView 的冻结旧 store/真实原生适配器用于算法对照，未冒称旧 EXE 运行收益。20 个等待查询只发最终项、260 原项插入期间分页无漏重，合成记录已清理，7 格式剪贴板恢复/校验。首次驱动因 CSP 拒绝浏览器动态构造而失败，改为 Node 生成可信测试函数后通过，产品 CSP 保持。见[真实计数](verification/2026-10-07-images-query-entry.md#真实查询-ipc-补验)。

双窗口持续图片补验发现隐藏主窗仍转占位动画，同进程暂停/恢复单核 CPU 23.80→0.94→18.62%。修复 `ImageThumb` 播放条件后，新默认 Release 约 30 秒隐藏采样由 18.418% 降到 0.574%，110 图片/缓存/并发及隐藏无运行动画通过，O-03 收回。EXE 仍 46,369,280 字节，JS 增 51 字节，原生/字体/CSS 摘要保持；前端 74/74、类型/完整 lint/构建通过，4 格式恢复/字节校验、全 QA 根实例为零。全树内存仍高，不虚报内存收益。见[发现与默认复验](verification/2026-10-07-images-query-entry.md#默认动画修复复验)。

补齐首次 ready 前的实际原生托盘退出：本机多 WebView 命名管道握手后暂停真实生效，root=0/loading/无侧栏时派发 Quit，不提前退出，恢复后实际结束。原始通过报告重读后 S-01、N-03、N-06 收回。关于/更新中英亮暗最小窗/焦点、真实新原生进程检查关/开 0/1及最终 40 发布文件/静态闭包补齐，O-07 收回。所有轮结束原剪贴板 4 格式恢复/字节校验，普通启动清除调试环境，QA 自动检查明确恢复 0；原失败的计数/挂载等待及 QA 设置恢复边界保留，不隐去。详见[首次 ready 与分包归并](verification/2026-10-08-closeout.md#首次-ready-与依赖验收收回)。

## 2026-10-08 — 受控剪贴板与真实中文输入

继续目标时补齐两项可靠性证据：异常终止后同 SHA/同库原生重开读取已确认原文/revision=2；真实迁移后旧托盘菜单命令不改目标全表/剪贴板，S-03 验收收回。启动超时来自助手等待继承输出管道 EOF，改按其实际进程退出后约 2.6 秒完成。最新 NSIS/MSI 测得 32.17/33.93 MB；用户明确“达不到也没事，尽力就行”，20MB 调整为参考目标，不再阻塞收尾，其他功能/可靠性/视觉要求保持。首次 ready 调试暂停未成立，未派发 Quit，失败及恢复保留；各轮原剪贴板 7 格式恢复校验。详见[后继补验](verification/2026-10-08-closeout.md#后续可靠性与体积补验)。

收尾批次：按用户要求不扩大实验。36 张缩放截图检查发现暗色便签原生滚动条发白，仅加局部主题声明；新默认 EXE 46,369,280 字节、SHA 70F828C57A0B290ADCBA57F0DE6B9D89F62C091E2CBE1D8D0972F0B171966E41，实际 125% 最小窗亮暗编辑/列表四张复验通过。SQLite FULL/只读新增回归、前端 74、Rust 137/3 忽略、类型/完整 lint/构建通过；15 秒 QA 驱动超时负向检查确认停止/剪贴板恢复。第二代 R0/R1 完成，当前首轮隐藏超时；异常结束重启就绪助手超时，已确认正文磁盘精确核对并清残留，未冒称完整验收。最终 QA 为零、原剪贴板 7 格式恢复校验，整体目标仍未完成、未提交/推送/发布，见[收尾边界](verification/2026-10-08-closeout.md)。

后续独立轮补齐近上限备份诊断样本和默认实际恢复：错误密码、SQL 故障原子回滚及重试、12 图片、本机正文和原始冲突副本保持，两轮均停 QA 后恢复/校验 7 格式。约 77MB 载荷导出/成功导入 worker 单次 2.16/0.54 秒，SQL profile 可重叠，不作分布或优化收益，见[分项证据](verification/2026-10-08-rich-backup.md#近上限备份分项实测与默认复验)。另实际 Windows 100%/125%/150% 最小窗中英文/亮暗/三场景共 36 组合通过，系统恢复 125%；显示设置最高仅 175%，200% 不启用自定义缩放/注销而保留缺口，见[矩阵证据](verification/2026-10-08-controlled-desktop.md#实际-windows-缩放支持矩阵补验)。

普通默认真实一小时到期暂停/解除后的有界排空核心通过；测试 finally 参数断言失败后 CDP 保持、包装器未自动收尾，核验后仅停止驱动子进程，外层确认保存屏障/停 QA/7 格式恢复校验，再精确清残留。失败报告保留，不能以核心通过称整轮通过；驱动修正并加包装器总时限，见[小时与恢复](verification/2026-10-08-cleanup-profile.md#普通默认一小时实际等待与收尾恢复)。第二代共同基线重建和 schema 门槛六例通过；首轮存在候选编译重叠而排除正式性能比较，后继 R0/R1 完成、当前版首轮超时，详见收尾记录。

备份分项计时补至可选诊断：后台排队/执行、六个连接范围的等锁/持锁/SQL 聚合；默认 135/诊断 136 Rust 通过，各 3 忽略。新默认 Release 46,368,768 字节，原生搜索/整理/边界保存复验通过，100 保存 P95 19.8ms。近上限备份计时尝试未能定位原生文件框，选择超时，未采到分项结果；已释放 lease/清理夹具/停 QA，7 格式剪贴板恢复校验。未将该计时实现记成性能收益或整项验收，见[记录](verification/2026-10-08-rich-backup.md#备份分项计时实现与未完成的桌面尝试)。

完整进程补查发现旧搜索 QA 从前夜持续运行，默认单 PID 停止回执未覆盖它；核验 EXE/真实保存屏障后关闭，旧共享临时目录影响未知，历史性能环境限制更正。旧搜索启动器停用，默认/基线/受控入口接入实时测试根目录进程准入，7 合成边界及实际重复启动拒绝通过；剪贴板 7 格式恢复/校验。Windows 多 DPI 尝试仅读到 125%，输入保护/状态获取循环后未改变系统设置，矩阵没有执行，不记通过。见[实例证据](verification/2026-10-08-autostart-isolation.md#遗留实例补查与实时进程准入)及[缩放尝试](verification/2026-10-08-controlled-desktop.md#实际-windows-缩放验收尝试)。

周期清理核查发现到期被 lease 暂停后再等一小时，以及便签每轮只回收一批；现保留单个到期任务，周期分批释放 producer、忙时重试。隔离诊断 Release 实际 export lease 7 秒暂停、2,000 历史/205 过期删除便签清理和保护边界通过，500 保存 P95/P99 37.8/142.3ms，队列/锁/SQL 分别留存。SQL 故障首版实测 7 秒误重试 8 次，修复错误分类后只一次，并于约 62 秒恢复清理；全部设置/合成故障/剪贴板恢复。最终默认 Rust 135/诊断 136 通过，各 3 基准忽略，默认启动 TTL/共享图片保护通过；无完整一小时或备份分项时长结论，见[周期证据](verification/2026-10-08-cleanup-profile.md#周期-ttl-的暂停重试与分项指标)。

后续补查图片粘贴临时目录的 QA/正式共用回收风险，历史删除范围没有目录清单可追溯；现非正式标识写入/回收统一独立摘要目录，133 Rust 通过/3 忽略，新默认实际启动只清理本 QA 过期合成文件、另一实例保持，设置/夹具与剪贴板均恢复。旧共享目录默认/profile/基线产物禁止重放，新产物 46,320,640 字节；见[隔离补查](verification/2026-10-08-autostart-isolation.md#图片粘贴临时文件的共享目录补查)。

普通复制请求真实延迟跨迁移仍写旧正文，复现后六入口补强制身份及实际 worker 排空，所有前端复制/粘贴统一封装，托盘动作/图片复制缓存携带来源身份。74 前端/131 Rust 通过（3 基准忽略），默认旧请求拒绝/在途粘贴排空/备份 29 请求拒绝、图片格式像素与文件路径实际确认通过。托盘复制通过但粘贴首轮失败，定位自有原生菜单覆盖外部目标，先失败回归修正后 Rust 132 通过/3 忽略，新默认实际托盘复制/粘贴及普通复制/真实 IME 整轮通过。42 个旧身份原生命令拒绝且全表保持，便签忙提示及实际 worker/文件/图片复制再次通过。各轮停止 QA 后剪贴板恢复/校验，见[复制交接记录](verification/2026-10-08-copy-handoff.md)。

实际 WebView 重载发现旧退出/重启请求被重新绑定给新 JS，新的空屏障发起旧保存确认；探针在原生交付前拦住。现替换已有会话取消未确认交接并显示中英文提示，初次 ready 和在途 worker 规则保持。原生回归先失败，修复后 Rust 129 通过/3 忽略、前端 71/71；新默认 EXE 46,268,928 字节，实际重载拒绝/后续 lease、dirty 稿正常原生重启及联合故障/超时/隐藏/真实托盘 Quit 再通过，各轮恢复/校验剪贴板。崩溃后未提交 JS 草稿的持久恢复和其他缺口继续，见[重载证据](verification/2026-10-08-lifecycle-reload.md)。

Windows 剪贴板采集补真实同环境对照：800ms 轮询普通文本提交事件 P95 761ms，改原生消息窗口/容量 1 唤醒队列后为 36ms、最大 87ms（60 次全 <100ms）。保留 watchdog/启动抑制/生产者暂停/私密序列，并互斥采集文本快照与应用复制事务；100 次合成私密复制无历史。默认 Release 再通过物理快捷键/粘贴/真实 IME 和备份交接，实际 lease 中改剪贴板不入库、取消后只补录一次。Rust 128 通过/3 忽略，同前端 EXE 46,268,928 字节（+2,560），各轮恢复/校验剪贴板；图片/文件和剩余调度继续，见[事件实测](verification/2026-10-08-clipboard-events.md)。

继续沿原生交付检查，实际暂留收藏请求至目录切换后执行，复现新库被修改；统一请求身份后默认拒绝矩阵扩至 36 命令，业务/派生表完整保持。密码箱旧锁定事件另复现新会话被前端清空，补事件来源与活动/复制剪切回调检查，默认真实迁移复验通过；同版改密、不同主密码合并、错误密码拒绝和重复恢复再通过，原 6 合成账户保持、临时账户移除。翻译交付前及配置分段身份补齐后真实本机 HTTP 在途/新请求/缓存通过。备份密码表单的同类旧事件再实际复现，补来源过滤/切换清理后前端 71/71、默认表单及当前锁定通过。Rust 128 通过/3 忽略，该常规默认 EXE 46,266,368 字节；各轮剪贴板均恢复/校验。见[请求与会话证据](verification/2026-10-08-vault-phrase-regression.md)。

完整字符集 WOFF2 实验保留全部映射、轮廓和布局，5 字体 44.42→24.63 MB；实际 WebView2 480 组像素/字宽相等，但中文字体构造 + load P95 23–41→103–140ms。匹配构建控制/候选 EXE 46,266,880→45,158,400 字节，远小于字体原始文件的相对减少。匹配 NSIS/MSI 减少 3.35/3.29%，实际启动及四页首次加载各 30 次完成，短语尾部波动保留；本轮暂缓转换：安装包仅再省约 1MB且解析成本增加；多 DPI 仍验收现有字体集合；失败的表检查/构建/计时方法均保留并修正，见[字体实验](verification/2026-10-08-font-woff2.md)。

后续补验：五模块迟到读和真实 HTTP 在途翻译跨目录保护通过；实际发现剪贴板旧事件及旧写成功确认分别污染同 ID 目标记录，补原生事件身份信封、前端过滤和三类写确认代次检查。前端 53/53、类型/lint/构建、Rust 128 通过/3 忽略；完整默认 Release 分别复验通过，见[身份回归](verification/2026-10-08-vault-phrase-regression.md)。默认启动 TTL 清理/共享图片保留及备份保存屏障、排他拒绝/取消恢复/成功认证导入也已补验，剩余边界仍以 TODO 为准。

继续真实复现旧全文跨目录返回，补原生 epoch 和前端读取/粘贴前检查；前端 56/56、类型/相关 lint、Rust 128 通过/3 忽略，新默认 Release 旧全文拒绝与当前完整读取通过。另将 R0/R1/当前版从源码重建为相同独立身份。权限更新后 R0/R1 各 30 次启动及完整查询/导航/显隐采样完成，当前版首轮第 23 次等待卡片超时，保留失败；驱动补页面身份、逐轮断开及诊断后完整 30 次和运行采样通过，启动观察 P95 1,543ms、查询 P95 6.7ms。方法变化不用于直接计算收益，全进程树 private P50 可见/隐藏为 653.49/479.66 MB，未达 80MB。原生 15s 无响应交接、迟到确认保护及后续正常 lease 通过，剪贴板恢复校验。见[运行结果](verification/2026-10-08-runtime-baseline.md)及[交接证据](verification/2026-10-08-controlled-desktop.md#原生交接无响应与迟到事件)。

同配置生成 R0/R1/当前 NSIS 和 MSI 体积样本，当前为 32.14/33.90 MB；仅字体集合的 NSIS 收益 48.17%，后续功能成本单独记录。没有安装、运行这些包或发布，当前未达 PRD 20MB；详见[安装包体积对照](verification/2026-10-08-installer-size.md)。

第十四批：不同主密码真实 UI 合并、错误密码保护、本机冲突优先和重复去重通过，合成主密码/临时账户已恢复清理。随后实际延迟旧短语创建成功响应跨目录切换，复现新界面污染；给六类短语写响应补存储代次校验、创建去重/切组保护。前端 46/46、类型/lint/构建通过，新完整默认 Release 同场景复验无污染，EXE 46,080,000 字节、JS 增 215 字节，见[旧模块回归](verification/2026-10-08-vault-phrase-regression.md)。

第十三批核查发现旧 QA 虽独立 identifier，却与正式版共用自动启动名称，启动修复已将正式 Run 指向 QA。停止 QA 后核验当前运行正式版并恢复其路径/`--hidden`；历史参数未知。源码非正式标识独立命名、旧产物拒绝启动，Rust 128 通过/3 忽略，新默认真实开关及开启后新进程修复均确认正式值不变。随后目录只读失败、暂存目标被改的冲突保护和密码箱联合迁移通过，旧源 807 悬空来源成因未明并保留，外键完整后继库重复全轮通过。见[隔离恢复](verification/2026-10-08-autostart-isolation.md)和[迁移补验](verification/2026-10-08-storage-remaining.md)。

第十二批首切实测发现惰性模块加载很快，页面却受 Suspense 重试节流影响，便签列表 P95 380.2ms。针对导航使用 transition、便签复用外层边界；前端 38/38、类型和 App lint 通过。相同默认 Release 的 30 个新进程复验列表 P95 92.0ms、侧栏进入至新建可输入 168.8ms，其他页面首切 22–29ms，各页 100 次预热无明显回退；字体/CSS 不变，JS 增 22 字节，EXE 不变。原生 opt-level=s 虽减约 13% 体积，但同字节图片/加密明显变慢，反向复测后不采用。见[首切证据](verification/2026-10-08-page-transition.md)与[编译参数对照](verification/2026-10-08-cleanup-profile.md)。

后续补验发现联合设置/便签保存成功后 Windows Quit 仍可能未结束；按 Tauri 本地源码合同，排空/锁定/清理后在主线程执行 cleanup_before_exit 并立即结束进程。全量 Rust 127 通过/3 基准忽略，完整默认 Release 的失败/超时/晚确认/隐藏/正常 Quit 复验通过，磁盘设置与便签一致。含图片/密码箱/Key 的近容量 v3 备份达 99.2748% 载荷上限，真实多对象回滚与重试、v0/v1/v2 实际 UI 恢复通过，见[富内容证据](verification/2026-10-08-rich-backup.md)。

第十二批由默认系统监听实际触发容量清理并联合 8 读/1 写，保存 P95/P99 35.0/100.6ms，原有记录、60 条保护夹具和独立便签完整；尾部波动相对基线保留。相同最终源码与前端 Thin LTO 候选 EXE 减少 2.673%，构建成本增加，尚未采用；依赖 feature 图已核对，size 候选与运行验收继续。见[清理与编译实验](verification/2026-10-08-cleanup-profile.md)。

用户明确批准系统剪贴板/全局快捷键受控验收。完整默认 Release 的实际复制路径/正文、物理 Ctrl+Shift+右键唤起、专用文本框真实粘贴和默认监听后收为便签通过；中文 SendInput 触发真实 composition，候选停留 2,250ms 不提前保存，提交后正文准确。修复保护助手的 Console 同步读取阻塞 Windows 消息泵，失败记录保留；最终停止监听后 7 种格式恢复、字节校验通过。默认原生边界保存 P95/P99 25.7/39.9ms，全部联合验收继续，见[受控桌面证据](verification/2026-10-08-controlled-desktop.md)。

## 2026-10-07 — 搜索索引：隔离证据与批准接入

默认 50k 全文长扫描使联合保存 P95 734.9ms，完成 trigram 候选的语义、磁盘/写入/迁移及真实 IPC 实验后，升级已有 50k 的联合保存 P95 33.0ms、无匹配搜索 2.1ms。52,100 项升级全部便签/引用/来源字段哈希一致，库增约 5.03%，进程至原生可用约 6.55–7.40 秒；短词和常见词回退、最终 LIKE 语义保持。边界正文加 20 引用保存 P95/P99 45.9/93.3ms。收益和代价分开报告，不把隔离配置的体积或 CPU 当默认版结果。

自动审批最初拒绝直接迁移，改用强制独立标识、固定合成数据且关闭系统监听/钩子的源码副本验证。用户审阅具体证据后明确批准默认 schema 4→5；现已接入，全量 Rust 127 通过/3 基准忽略。随后用户批准受控系统剪贴板与全局快捷键验收，完整默认 Release 的 50k 联合保存 P95/P99 28.9/54.1ms、分页无漏重；该轮停止监听后原剪贴板 6 格式恢复并通过字节校验。普通保存成本另报，其余联合验收继续；没有访问生产数据库或推送发布。见[详细证据](verification/2026-10-07-images-scale.md#完整默认配置索引复验)。

## 2026-10-07 — 第十批：图片与原生可见性

修正 Tauri 只读入口造成的无效请求测量，通过原生自检后统计两窗实际 IPC；修复 content-visibility 卡片被 flex 压缩及 WebView2 原生隐藏后仍报告网页可见。默认 Release 主窗 150/轮盘 110 个不同图片、缓存/并发、静止稳定、轮盘卸载、隐藏主窗后 10 次刷新不新增请求通过。字体保持，前端 38/38、类型/完整 lint 通过。10k 联合保存 P95 132ms，插入期间游标 10k 与剪贴板 2k 无漏重；50k 无匹配搜索 P95 274ms，联合阶段读槽 busy 超出驱动重试边界。保留失败，候选索引先做测试/成本实验，不直接采用或整项勾选。见[本批证据](verification/2026-10-07-images-scale.md)。

## 2026-10-07 — 第九批：真实退出与近容量内存

真实 QA 托盘退出命令选择时便签仍为 dirty，约 860ms 后原生进程结束，磁盘正文与 revision 正确；没有用停止进程代替验收。补修资产目录随实际数据库连接、回收游标防止失败项饥饿，两项临时库回归通过。默认 Rust 121 通过/2 基准忽略，前端 38/38、类型/完整 lint 通过。

实际设置页完成 98.21% 容量载荷的 v3 导出、预览、重复导入及 80MiB 原文超限拒绝；区分原生与全 WebView 进程树 private/working set。发现大缓冲同时存活导致原生导出 private 峰值约 417MB，按测量缩短快照生命周期、借用 payload 解析并预留有界读取容量，保留格式、限制与加密参数，独立 Release 复验继续。见[本批证据](verification/2026-10-07-capacity-exit.md)。

## 2026-10-07 — 第八批：原生文件、备份与迁移桌面流程

默认 Release 补验文本/链接/文件卡片收为便签：完整 43,280 字节原文、来源快照、引用和删除原记录后的独立性通过，原生边界拒绝受保护内容和图片。实际发现右键菜单受动画卡片与滚动容器裁切，改用 body 门户并按实际尺寸限制视口；普通和 440×420 /125% 窗口正常点击通过。当前前端资源 46,294,918 字节，完整 JS 818,485 字节；此修复的增量单独计入，不算优化收益。复制路径、真实 IME 和其他显示条件仍待验，见[本批证据](verification/2026-10-07-file-backup-desktop.md#剪贴板卡片捕获与菜单裁切)。

默认 Release 补验真实目录迁移：目标已有便签拒绝覆盖、目标提交后的源路由故障、期间新编辑及重试、原目标设置/协议身份/引用/归档删除状态保持、旧身份拒绝通过。实际发现带新稿重启时保存与后台排空成功，却在已批准退出后未最终结束 Windows 事件循环；改为自有交接完成后排入主线程执行 Tauri 重启。诊断及默认无诊断版本分别通过，替换进程沿多级路由打开正确目标并读回重启前的新稿，旧源未写入。补齐中英文迁移错误提示；完整 Rust 120 通过/2 基准忽略，前端 38/38、类型/完整 lint/生产前端构建通过。完整退出、密码箱迁移、其他故障及性能验收继续，未整项勾选。

真实选择/取消、中文/空格/逗号定位、文件缺失提示以及移除引用/删除便签不改外部文件通过。定位改用 Windows Shell PIDL 接口；文件、备份和目录对话框绑定主窗口，补对话框作用域以避免失焦隐藏提前保存标题稿。全应用一个原生对话框、真实回调持有保护的增强已在 Release 复验并发拒绝及随后连续选择/取消。

最新默认 Release 实际设置页导出 7,598,102 字节 v3 文件（2,066 条便签、39 引用），错误密码拒绝、冲突副本、重复导入去重、归档/回收站及旧 epoch 读写拒绝通过；便签页面更新缓存。此轮无图片/Key/密码箱夹具，也未代表近容量上限。驱动中修正现代对话框字段、COM 枚举与中文 stdout 编码，失败原因与产品问题分开记录。见[本批证据](verification/2026-10-07-file-backup-desktop.md)。

## 2026-10-07 — 第七批：持久性决策与长正文瓶颈

磁盘 Release 两轮 FULL/NORMAL 对照覆盖便签、剪贴板和各模块存储写入，保留尾部波动；据此统一连接 WAL/FULL，并检查持久库 WAL 返回值。默认关闭的 diagnostics 分别记录后台排队、等锁、持锁和粗粒度 SQL 指标，忽略 SQL 内容/参数。真实 2,000 条便签的摘要分页、字面搜索及 8 读/1 写压力通过，混合保存 P95 10.5ms。

真实 WebView 检查发现单段接近 256 KiB 正文在 textarea 内每键约 1.2s 布局，仅计 input 回调会漏掉主开销。样式探针无效后采用惰性 CodeMirror 纯文本视口绘制，保留字体/软换行/全文与保存协议。默认 Release 110 键、排除前 10 后按键到 Paint P95 10.960ms，无 >50ms 长任务；原文换行/空白、撤销重做、超限修正恢复和搜索错误复验通过。增加惰性 JS 的代价已单独记录，未称总 JS 减少。前端 38/38、Rust 含诊断 120 通过/2 基准默认忽略；真实 IME、文件和备份/迁移等联合验收继续。见[第七批证据](verification/2026-10-07-durability-pressure.md)。

## 2026-10-07 — 第六批：容量统计与真实 WebView 回归

schema 4 接入事务计数、共享图片资产台账，超限/TTL 分批及回收前复核；导入存在性复核移入写保留事务，尺寸与引用同提交。完整 Rust 119 通过、1 个 Release 基准默认忽略，显式基准另通过；合成容量统计 p95 23.7296 → 0.0022 ms，只报告微基准收益。前端 36 项、类型、完整 lint 和生产构建通过。

独立 QA 标识已通过便签新建/保存/链接/整理/回收，以及真实 DB 确认丢失重试和冲突副本。发现并修复 WebView host timer receiver、未落库标题稿交接、最小窗口侧栏裁切；默认 Release 已复验全部侧栏按钮、125% 中英文/浅暗视觉，以及标题稿拒绝原生重启和四份失败稿恢复。账户额度曾阻止 QA 重启的自动审批，未绕过；恢复后才继续更新应用。当前目标仍进行中，未收齐验收的 TODO 不勾选。证据见[本批记录](verification/2026-10-07-accounting-desktop.md)。


2026-10-07 第五批：便签页面、图片有界请求/缓存、剪贴板游标/标签查询、旧模块身份失效和主窗/轮盘独立入口已接入；前端 34 项、Rust 110 项测试通过，类型/定向 lint/生产构建通过。R0 嵌入资源 Release EXE 已留存，74,983,424 字节。桌面、性能、安装包和剩余优化未验收，详见[本批记录](verification/2026-10-07-images-query-entry.md)与 TODO。

## 2026-10-07 — 第四批：便签页面接入

便签侧栏、单栏列表/编辑、引用、卡片收存和恢复稿已接入；查询单飞/代次校验和隐藏延后刷新已实现。修正标题草稿的淘汰与额度问题。前端 30 项测试、类型、定向 lint 及生产构建通过；未完成桌面联合验收，TODO 仍按证据保留未勾选。见[验证记录](verification/2026-10-07-notes-ui.md)。
## 第三批实施：备份与搬迁（2026-10-07）

接入 v3 便签备份、旧版本读取、独立恢复来源/冲突副本及全对象事务；一致源快照、目标联合搬迁与暂存凭据替换临时拒绝保护，源路由失败可校验重试，目标原数据不覆盖。DB schema 3 新增恢复来源表。备份长度聚合、累计预算、精确有界 writer、原缓冲加解密、共享暂存与 2 个后台槽已接入，图片准备移出 DB 锁并提交前复核；便签过期清理有界。

Rust 全量 **108/108** 通过，TypeScript、相关 ESLint、独立中间 Vite 构建及差异空白检查通过。没有访问用户 DB 或进行真实桌面/Release 性能测量；便签页面仍未开放，继续原生文件操作、界面/查询、剩余热点与联合验收。证据见[第三批验证](verification/2026-10-07-backup-relocation.md)，勾选仅在 [TODO](TODO.md) 维护。

## 第二批实施：保存核心与统一交接（2026-10-07）

按用户要求创建持续执行目标，直到当前所需功能、合理优化与验收收齐。已实现页面外惰性保存协调器、设置冻结/确认、全局屏障、托盘/原生退出及自定义重启交接、备份和目录切换 lease。原生排空顺序覆盖接受入口竞态、整轮采集的图片/文件工作、清理、同步变更和已接受密码箱异步操作；旧 session、错误 token、超时或失败均不能确认退出。

23 项前端单元测试通过；Rust 全量 88/88 通过后，补充 lease 测试，当前 6 项原生协议测试通过。TypeScript、目标文件 ESLint 与独立中间 Vite 生产构建通过。便签入口仍未开放，备份仍 v2，便签搬迁保护仍保留；没有启动用户应用或检查用户数据库，桌面/Release 验收仍待完成。下一步推进 v3 备份与联合搬迁。证据见[保存交接验证](verification/2026-10-07-save-handoff.md)，进度只维护于 [TODO](TODO.md)。

## 第一批实施（2026-10-07）

便签数据层已完成，包含独立表、摘要分页、全文/引用保存、CAS/幂等、全文捕获、整理及存储身份。启动和目标库统一版本迁移/连接配置，便签命令有界后台执行；新增 20 项测试，Rust 全量 85/85 通过。保存协调器、页面、v3 备份及联合搬迁仍待接入，因此没有开放便签入口；源/目标已有便签时目录切换暂时拒绝，避免遗漏。

固定 R0 的源码清单/哈希与原有差异后，将 37 个未引用字体移出 public 并保留原文件；两个独立前端生产构建 97,489,964 → 45,974,752 字节，减少 51,515,212 字节，保留产物和全部原字体哈希一致。TypeScript 检查通过；未启动用户应用、读取用户数据库或测量 EXE/安装包、桌面渲染与运行性能。

接口、验证命令、环境和剩余边界见[首批验证记录](verification/2026-10-07-notes-foundation.md)；完成/未完成状态仅维护于 [TODO](TODO.md)。接下来按 TODO 推进保存交接与前端协调器。以下“本次规划更新”记录的是本批开发前的规划状态。

## 本次规划更新（2026-10-07）

后续拆为两个独立任务：N「便签」和 O「合理优化性能与体积」，均待实现；共用 S 保存屏障、连接/迁移、存储身份及后台调度只交付一次。统一状态见 [TODO](TODO.md)，设计分别见 [便签方案](features/notes-design.md)和[优化方案](features/performance-design.md)。

本次完成评审结论融入项目文档，补齐隐藏轮盘/完整预览、备份锁内图片处理/峰值内存、存储 epoch、恢复副本身份和失败草稿预算等规则。保留当前字体、美化、图片能力及全部已有功能，其他热点按实测推进，不把全应用优化作为便签首发前置。

2026-10-06 的最新前端内存构建/public 核算为 97.49 MB，未引用字体为 51.52 MB，候选集合约 45.97 MB；此前 45.96 MB 隔离实验属于不同源码快照。精确数字和测量方法维护在优化方案，不作为 EXE、内存或运行速度成绩。本次文档更新未实现便签或优化，未新增桌面/Release 性能成绩。

后续每次相关开发收尾及时更新 TODO 的 N/O/S 对应项、检查证据与待验证内容，并同步相关说明；本日志仅记录阶段变化。以下 2026-05 的问题、状态和规划保留为历史，不能据此重做已经实现的功能或判定当前风险。

## 当前阶段

Phase 1 — 核心功能闭环 ✅ (已完成)
Phase 2 — 完善与优化 🔄 (进行中)

## 历史项目状态（2026-05）

| 维度 | 状态 |
|------|------|
| PRD | 已完成 |
| 产品架构 | 已完成 |
| 技术选型 | Tauri 2.x + React + TypeScript + Zustand + SQLite |
| UI 框架 | iOS 风格纯 CSS + Notification Card 组件体系 |
| 项目脚手架 | 已搭建，前后端编译通过 |
| 数据库 | 5 张表已建，CRUD 命令已注册 |
| 翻译引擎 | 百度 + Google（免费/官方 API）+ AI 三种引擎 |
| 粘贴模拟 | 已实现，聚焦可靠，闪烁已消除 |
| 图片剪切板 | 已支持监控、存储（PNG 文件）、展示、粘贴、悬浮预览 |
| 剪切板分类 | 文本 / 图片 / 链接 / 文件 四类自动识别 |
| 导航栏 | 圆角矩形按钮 + 右侧 tooltip，亮暗色模式适配 |
| 设置页 | 存储位置 + 语言 + 快捷键 + 翻译引擎整合模块 |
| 窗口置顶 | 已实现（Rust 侧 toggle_always_on_top） |
| 可运行 | 是（`pnpm tauri dev`） |

## 已完成事项

- [x] 2026-10-07：设计评审融入文档，拆分便签与优化任务，建立统一 TODO 与交接规则；功能实现和运行验收仍待完成。

- [x] PRD 编写
- [x] 产品架构设计
- [x] 技术栈选型与论证
- [x] Rust 环境配置（MSVC 工具链）
- [x] Tauri + React + TypeScript 项目脚手架
- [x] SQLite 数据库建表 + 迁移
- [x] 剪切板监听模块
- [x] 快捷短语 CRUD 全部命令
- [x] 系统托盘（显示/退出菜单）
- [x] 全局快捷键 Alt+Shift+V
- [x] i18n 国际化（中/英）
- [x] 百度翻译 API 接入
- [x] Google 翻译接入（免费接口 + Cloud Translation API）
- [x] AI 翻译模块（OpenAI 兼容格式）
- [x] Windows/macOS 粘贴模拟（enigo）
- [x] 窗口置顶（Rust 侧命令，可靠）
- [x] 设置页百度/Google/AI 三引擎配置
- [x] 设置页语言切换按钮（中/英一键切换）
- [x] AI 翻译解析失败修复（读 body text + HTTP 状态检查）
- [x] UI 改为 iOS 风格 — 无边框透明窗口、磨砂玻璃、SF 字体、纯 CSS 组件
- [x] 前端组件全部去 MUI 化（App + 3 页面 + 设置弹窗）
- [x] 图片剪切板监控 + 存储（RGBA → PNG → 文件，缩略图展示）
- [x] 图片粘贴（PNG 文件 → Image → 剪切板 → Ctrl+V）
- [x] 粘贴闪烁消除（CSS opacity 0 → hide → paste → show → opacity 1）
- [x] 导航栏状态冲突修复（点击设置时主功能按钮取消选中）
- [x] 导航栏按钮重设计（圆形 → 矩形圆角16px + 右侧 tooltip + 亮暗色模式适配）
- [x] 剪切板/快捷短语卡片重设计（Notification Card 风格：左侧彩色条 + 内容位移动画）
- [x] 剪切板分类功能（文本/图片/链接/文件 四类自动识别 + 分类筛选标签）
- [x] Rust 后端链接/文件类型检测（is_url / is_file_path 函数）
- [x] 图片悬浮预览（hover 400ms 弹出大图，鼠标移开关闭）
- [x] 隐藏横向滚动条（全局 CSS）
- [x] 设置页翻译模块整合（4个 section → 1个 section，按引擎条件渲染配置项）
- [x] 设置页存储位置显示 + 自定义文件夹选择（tauri-plugin-dialog）
- [x] 剪切板时间格式改为日期+时分（5/14 14:30）
- [x] 快捷短语内容在前标题在后，标题小字，左对齐
- [x] 全局快捷键自定义（设置页录制快捷键 + Ctrl+Shift+右键鼠标钩子）
- [x] 过期记录自动清理（prune_old_records 启动时 + 每小时定时线程）
- [x] 图片悬浮预览修复（CSS :hover 在 overflow 容器中被裁剪，改用 fixed overlay + React state）
- [x] 图片粘贴优化（paste_with_defocus 改为后台线程 hide/paste/show，消除卡顿）
- [x] 短语按钮 100% 不透明度（亮色 #fff / 暗色 #3a3a3c）
- [x] 暗色模式短语卡片左侧竖条颜色修复（暗色下 #111 → #fff）
- [x] 前端代码重构 — CSS 模块化拆分（2488 行 index.css → 7 个模块化文件）
- [x] 前端代码重构 — 页面组件拆分（PhrasePage/ClipboardPage 拆分为多个子组件）
- [x] 前端代码重构 — 设置组件拆分（SettingsContent 拆分为 Language/Storage/Translation 三个 Section）
- [x] 前端代码重构 — 文件夹结构优化（pages 使用文件夹组织，新增 styles 目录）
- [x] 前端代码重构 — TypeScript 类型修复（所有编译错误已解决）

## 粘贴聚焦问题记录

**问题**：点击内容粘贴时，窗口消失/闪烁，且部分应用（浏览器、终端）粘贴不生效。

**根因**：Tauri 浮窗具有键盘焦点时，模拟的 Ctrl+V 会投递到自身窗口，必须先转移焦点到目标应用。转移焦点的不同方式有不同表现：

| 方案 | 效果 | 原因 |
|------|------|------|
| `window.hide()` / `window.show()` | 聚焦可靠 ✓ | Windows 隐藏前台窗口时，系统精确激活上一个焦点窗口 |
| `Alt+Escape`（Z 序推底） | 部分应用失效 ✗ | 激活的是 Z 序下一个窗口，不一定是用户之前使用的应用 |
| `SetForegroundWindow(HWND)` | 不可靠 ✗ | 跨进程前台窗口切换有权限限制，且背景线程追踪 HWND 有 800ms 延迟 |
| `window.minimize()` | 聚焦较可靠 △ | 动画比 hide/show 更平滑但仍有视觉变化 |
| `set_position(-9999,-9999)` | 完全不聚焦 ✗ | 移动窗口不改变焦点 |

**最终方案**：回到 `window.hide()` / `window.show()`（聚焦确定可靠），配合前端 CSS opacity 技巧消除视觉闪烁：

```
点击 → opacity:0 → requestAnimationFrame(等一帧确保重绘) → invoke
→ [后端: write clipboard → hide → sleep 120ms → Ctrl+V → sleep 40ms → show → focus]
→ opacity:1
```

窗口在 hide 之前已经全透明，show 之后才恢复可见。用户看不到 hide/show 过渡，视觉上窗口保持静止。

## 架构一致性审查（2026-05-14）

基于 `ARCHITECTURE.md` 逐项对照审查，发现以下不一致问题：

### 严重问题

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 1 | API 凭证硬编码 | `db.rs:80-81` | 百度翻译 AppID 和 Secret 直接写入 `init_db` 的 SQL 语句，属于安全漏洞。应移除硬编码，改为用户在设置中自行配置 |
| 2 | SQL 注入风险 | `db.rs:143-152` | `get_clipboard_records` 中搜索关键词通过 `format!` 拼接构建 SQL，未使用参数化查询。应改用 `rusqlite::params!` |

### 主要问题

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 3 | 前端未监听 `clipboard-update` 事件 | `clipboardStore.ts` | Rust 后端通过 `emit("clipboard-update")` 推送新记录，但前端无监听器，剪切板记录不会实时更新。需创建 `useTauriEvent` hook |
| 4 | React 版本不一致 | `package.json:16` | 架构文档指定 React 18，实际安装 React 19.2.6 |
| 5 | MUI 已安装但完全未使用 | `package.json:6-7` | 架构文档指定 MUI 为 UI 组件库，已安装但所有组件均使用自定义 CSS，无任何 MUI 导入。需移除依赖并更新架构文档 |
| 6 | `hooks/` 目录缺失 | `src/utils/paste.ts` | 架构文档指定 `src/hooks/useTauriEvent.ts` 和 `src/hooks/usePaste.ts`，实际为 `src/utils/paste.ts`，且 `useTauriEvent.ts` 不存在 |
| 7 | `types/index.ts` 类型定义不完整 | `types/index.ts:2-5` | `ClipboardRecord.type` 仅定义 `"text" \| "image"`，实际含 `"link"` 和 `"file"`；`TranslationRecord.engine` 仅定义 `"ai" \| "builtin"`，实际还有 `"google"` |

### 次要问题

| # | 问题 | 位置 | 说明 |
|---|------|------|------|
| 8 | 剪切板轮询间隔不一致 | `clipboard.rs:30` | 架构文档指定 500ms，实际代码为 800ms |
| 9 | 有道翻译未实现 | `translator.rs` | 架构文档提到"百度翻译/有道翻译"，实际仅实现百度+Google，无有道 |
| 10 | 面板路由方式不一致 | `App.tsx:17` | 架构文档指定 URL param `?p=` 路由，实际使用 React state |
| 11 | `toggle_always_on_top` 未实现 | `lib.rs` | 架构文档提到置顶切换命令，但未注册 Tauri Command（开发日志称已实现，需确认） |
| 12 | 托盘图标单击事件未实现 | `tray.rs` | 架构文档指定"单击托盘图标: 显示/隐藏悬浮窗"，实际仅右键菜单 |
| 13 | 过期数据定时清理未启用 | `db.rs:88-107` | `prune_old_records` 已编写但从未被调用（已在当前待处理 #5 中记录） |
| 14 | NavigationButton 组件未使用 | `NavigationButton.tsx` | 组件和样式文件存在但未被任何文件导入，属于死代码 |
| 15 | 默认快捷键未设置 | `db.rs:78` | 架构文档指定默认 `Alt+Shift+V`，实际默认为空字符串 |

## 历史待处理（2026-05，接手前核对当前源码）

1. **全局快捷键注册冲突** — `shortcut.rs` 和 `lib.rs` 中存在双重注册逻辑，需整理
2. **剪切板记录来源应用未获取** — `source_app` 字段始终为空
3. **翻译缓存策略单一** — 仅按精确匹配，不支持相似文本复用
4. **终端 Ctrl+V 兼容性** — 已深入调查，根因是 SendInput 的 LLMHF_INJECTED 标志被 Electron/Chromium 应用拦截。已尝试 Shift+Insert、AllowSetForegroundWindow、PostMessageW 多种方案。PostMessageW 方案（绕过 SendInput）理论可行但未充分测试，代码已回滚。详见「径向菜单开发记录」
5. ~~**过期记录未自动删除** — `prune_old_records()` 函数已实现但从未被调用，需在启动时或定时触发~~ ✅ 已解决
6. **API 凭证硬编码** — 百度 AppID/Secret 写入 init_db SQL，需移除（审查 #1）
7. **SQL 注入风险** — get_clipboard_records 搜索拼接 SQL，需参数化（审查 #2）
8. **前端未监听 clipboard-update 事件** — 剪切板记录不实时更新（审查 #3）
9. **types/index.ts 类型定义不完整** — 缺少 link/file/google 类型（审查 #7）
10. **托盘图标单击事件未实现** — 仅右键菜单，无单击行为（审查 #12）
11. **NavigationButton 死代码** — 未使用的组件需清理（审查 #14）

## 历史下一步规划（2026-05）

当前两个任务与依赖以 [TODO](TODO.md) 为准；下表保留旧计划，不作为便签或优化的完整前置清单。

### Phase 2 — 完善与优化

| 任务 | 优先级 |
|------|--------|
| 调用 prune_old_records 实现过期记录自动清理 | P1 | ✅ 已完成 |
| 终端粘贴兼容（Shift+Insert / Ctrl+Shift+V 自动检测） | P1 |
| 应用内直接输入文本实时翻译 | P1 |
| 获取剪切板来源应用名 | P2 |
| 翻译引擎热切换（结果页切换引擎重新翻译） | P2 |
| 翻译缓存相似文本复用 | P2 |
| 开机启动 | P2 |

### Phase 3 — 发布准备

| 任务 | 优先级 |
|------|--------|
| Windows .msi 打包测试 | P0 |
| macOS .dmg 打包测试 | P0 |
| 自动更新（Tauri updater） | P1 |
| 开源准备（LICENSE、README、CONTRIBUTING） | P1 |

## 技术笔记

- Rust 工具链 `stable-x86_64-pc-windows-msvc`
- Tauri 2.x `tray-icon` 需在 Cargo.toml 显式开启 feature
- Tauri 2.x 系统托盘通过 Rust 代码（TrayIconBuilder）创建，tauri.conf.json 中 trayIcon 已废弃
- Tauri 2.x 插件配置 `clipboard-manager` / `global-shortcut` 接受 `null`（unit type），不接受 `{}`
- 数据库路径：Windows `%APPDATA%/copy-creator/data.db`
- 百度翻译签名算法：MD5(appid + query + salt + secretKey)
- Google 免费翻译：`translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=XX&dt=t&q=URL_ENCODED_TEXT`
- enigo 0.3 无需 feature flags，自动根据目标平台选择后端
- iOS 风格窗口：`decorations: false`, `transparent: true`, `shadow: true`, 440×500
- UI 已完全移除 MUI，使用纯 CSS 变量 + 类名体系（index.css）
- 百度默认凭据已内置（AppID: 20260513002612590）
- 剪切板图片处理流程：`read_image()` → `Image` (RGBA) → PNG 编码 → 保存 `app_data/images/{uuid}.png` → DB 存路径 → 前端 `get_image_base64` 转 base64 渲染缩略图
- 图片粘贴流程：读取 PNG → 解码 RGBA → `Image::new_owned()` → `write_image()` → Ctrl+V
- 粘贴聚焦唯一可靠方案：`window.hide()` + `window.show()`，配合前端 CSS opacity 消除视觉闪烁
- Notification Card 组件：`isolation: isolate` + `::before` 覆盖层在 WebView2 中会导致内容不可见，改用 `border-left` + `.notibar` 内部元素实现左侧彩色条
- Vite 8 (rolldown) 不支持跨模块 `export type` 导入，`import { Type }` 会导致 `MISSING_EXPORT` 错误，需在导入模块本地定义类型
- CSS `@font-face` 中含中文路径（如 `/字体/`）可能导致整个样式表解析失败（灰色窗口），应使用 JS `FontFace` API 动态加载或 URL 编码路径
- 剪切板类型检测：文本优先 → `is_url()` 检测 http/https/ftp 开头 → `is_file_path()` 检测盘符路径+存在性 → 兜底 text
- `tauri-plugin-dialog` 用于系统文件夹选择对话框，`app.dialog().file().pick_folder()` 返回 `FilePath` 类型，用 `.to_string()` 转换
- 导航栏 tooltip 箭头定位：用 `margin-top: -3px` 替代 `transform: translateY(-50%)`，避免与 `rotate(45deg)` 叠加导致错位
- `prune_old_records()` 函数已实现但从未被调用，过期记录不会自动删除
- 图片悬浮缩放 CSS `:hover` `transform: scale()` 在祖先容器有 `overflow-y: auto` 时被裁剪（overflow 强制作用于两轴），多次改 CSS 均无效，最终方案为 `onMouseEnter` 触发生成一个 fixed-position overlay（`pointer-events: none`），直接挂载到 DOM 顶层，完全绕过 overflow 和 stacking context 限制
- 图片粘贴 `window.minimize()` 在 Windows 11 上有约 300ms 动画导致明显卡顿，改为 `window.hide()` 即时无动画，配合 `std::thread::spawn` 将 hide/paste/show 放入后台线程执行，Tauri command 在 clipboard write 完成后立即返回，前端不阻塞
- 前端重构采用单一职责原则：每个组件只负责一个功能，页面组件负责组合子组件
- CSS 模块化策略：按功能域拆分（base/layout/components/clipboard/phrases/translation/settings），index.css 仅作为入口导入
- 页面文件夹组织：复杂页面使用文件夹（ClipboardPage/、PhrasePage/），简单页面保持单文件（TranslationPage.tsx）
- 设置组件拆分：按功能域分为 LanguageSection（语言+快捷键+保留时长）、StorageSection（存储位置）、TranslationSection（翻译引擎）

---

## 径向菜单（Radial Menu）开发记录 — 2026-05-16

### 功能概述

径向菜单是一个独立 Tauri 窗口（`radial-menu`），通过 **Ctrl+Alt+右键长按** 触发，在鼠标位置弹出，显示剪切板和快捷短语的内容列表。用户按住右键移动鼠标到目标条目上，松开右键即可将内容粘贴到之前的应用中。

### 架构要点

```
shortcut.rs (WH_MOUSE_LL 低层鼠标钩子)
  ├── Ctrl+Alt+RightButtonDown → show radial-menu window at cursor position
  ├── MouseMove (while right down) → emit "radial-menu-move" (throttled 16ms)
  └── RightButtonUp → emit "radial-menu-up"
        └── 前端 RadialMenu/index.tsx
              ├── 根据坐标做 hover 检测 (document.elementFromPoint)
              ├── Hover 1000ms 自动切换 tab/分类 (useHoverSwitch hook)
              └── 调用 pasteRecord/pastePhrase → paste.rs
                    └── paste_with_defocus: hide windows → restore focus → Ctrl+V
```

- 窗口定位：`SetWindowPos(HWND_TOPMOST)` → `SWP_SHOWWINDOW` → `HWND_NOTOPMOST`（瞬时置顶后恢复，避免常驻置顶干扰）
- 坐标转换：`screen_to_css` 函数处理 DPI 缩放（physical → CSS pixels）
- 前端 hover 检测：`document.elementFromPoint` + `closest("[data-radial-item-id]")` / `[data-radial-nav]` / `[data-radial-category]`

### 已解决的问题

#### 1. 窗口位置偏移 / 页面未填充窗口
- **问题**：弹出窗口有间隙，内容未撑满
- **修复**：移除 `calculatePopupPosition` 和 `VIEWPORT_PADDING`，popup 设置 `width: 100%; height: 100%`，移除 `border` 和 `border-radius`（DWM 已做圆角）

#### 2. 双击粘贴（Double Paste）
- **问题**：内容被粘贴两次
- **根因链**：
  1. 剪切板监控器 800ms 轮询，paste 线程写剪切板后监控器检测到"新变化"→ 重复记录
  2. `PASTING.swap(false)` 过早清除了 PASTING 标志，监控器在 paste 线程写剪切板之前重新同步了旧缓存
  3. WM_RBUTTONUP 同时触发了 radial-menu-up 和系统右键菜单
- **修复**：
  1. 添加 `PasteGuard`（RAII 模式，drop 时重置 PASTING）
  2. 监控器改用 `PASTING.load(Ordering::SeqCst)` 只读不写，PASTING 仅由 PasteGuard 清除
  3. 将缓存状态外部化为模块级 `pub static Mutex`（`LAST_CLIPBOARD_TEXT`、`LAST_CLIPBOARD_IMAGE_HASH`、`LAST_CLIPBOARD_FILES_KEY`），paste 函数写入剪切板后调用 `sync_monitor_cache()` 同步
  4. WM_RBUTTONUP 处理中返回 `LRESULT(1)` 阻止消息继续传播

#### 3. 粘贴输出字符 'V' 而非执行粘贴
- **问题**：模拟的 Ctrl+V 被拆解为独立的 'V' 字符输入
- **修复**：将 `enigo.key(Key::V, Direction::Click)` 改为 `Press` → 10ms sleep → `Release`，Control 和 V 之间有 30ms 间隔

#### 4. 图片缩略图比例
- **修复**：`ImageThumb` 组件设置 `width: 48, height: 36, objectFit: "cover", borderRadius: 5`，与主窗口一致

#### 5. 剪切板时间显示
- **修复**：添加 `formatTime()` 函数（M/D HH:mm 格式），items 中包含 `createdAt` 字段

#### 6. 快捷短语备注显示
- **修复**：items 中包含 `title` 字段，渲染为 `.radial-menu-item-remark`

#### 7. 导航栏按钮圆角
- **修复**：`.radial-menu-nav-tab` 的 `border-radius` 从 `10px 10px 0 0` 改为 `10px`（四个角）

#### 8. 暗色模式同步
- **问题**：径向菜单窗口不跟随主窗口的亮暗色切换
- **修复**：在每次 `radial-menu-down` 和首次 `radial-menu-move` 事件中通过 `invoke("get_setting", { key: "theme" })` 重新读取主题并设置 `data-theme` 属性

#### 9. 悬浮进度条颜色
- **修复**：亮色模式 `rgba(0,0,0,0.35)`，暗色模式 `rgba(255,255,255,0.6)`

### 尚未解决的问题

#### 终端 / Electron 应用粘贴失败

**现状**：`paste_with_defocus` 使用 enigo 模拟 Ctrl+V。enigo 底层调用 Windows `SendInput` API，该 API 会在键盘事件中设置 `LLMHF_INJECTED` 标志。Chromium/Electron 应用（包括 Trae IDE、VS Code、Windows Terminal 等）可能检测此标志并忽略合成的键盘输入。

**已尝试的方案**：

| 方案 | 结果 | 原因 |
|------|------|------|
| Ctrl+V (SendInput) | 普通应用 ✅ / 终端 ❌ | SendInput 的 INJECTED 标志被 Electron 拦截 |
| Shift+Insert (SendInput) | 同 Ctrl+V | 同样使用 SendInput，同样被拦截 |
| Ctrl+V + AllowSetForegroundWindow | 焦点恢复改善，但终端仍不工作 | 焦点正确恢复，但仍走 SendInput 路径 |
| PostMessageW 直接向目标 HWND 发送 WM_KEYDOWN/WM_CHAR/WM_KEYUP | **已回滚**（未充分测试） | 绕过 SendInput 和 INJECTED 标志检测，理论可行 |

**下一步方向**：
1. **方案 A**：完成 `PostMessageW` 方案的测试。该方案的思路是放弃 `SendInput`（enigo），改用 Windows `PostMessageW` API 直接将 `WM_KEYDOWN`（VK_CONTROL）→ `WM_KEYDOWN`（'V'）→ `WM_CHAR`（0x16）→ `WM_KEYUP` 序列投递到目标窗口的消息队列，完全绕过系统输入队列和注入检测。代码已在 `paste_ctrl_v_to_hwnd()` 函数中实现后被回滚。
2. **方案 B**：同时发送 Ctrl+V 和 Shift+Insert 两种按键，覆盖更多终端
3. **方案 C**：使用 Windows UI Automation（`uiautomation` crate）在目标应用中执行粘贴操作
4. **方案 D**：调查 enigo 是否有不使用 `SendInput` 的后端（如 `keybd_event` 旧 API）

**关键文件**：
- `src-tauri/src/paste.rs:64-121` — `paste_with_defocus` 函数
- `src-tauri/src/shortcut.rs:10-11` — `save_foreground_window` / `LAST_FOREGROUND_HWND`
- `src-tauri/src/clipboard.rs:4-7` — `PASTING` / `LAST_CLIPBOARD_*` 静态缓存

### 当前 paste_with_defocus 最终状态（截至交接时）

```rust
fn paste_with_defocus(app: &AppHandle) -> Result<(), String> {
    // 1. AllowForegroundWindow (ASFW_ANY) — 在隐藏窗口前授权
    // 2. Hide radial-menu 窗口
    // 3. Hide main 窗口（如可见）
    // 4. SetForegroundWindow(saved_hwnd) — 恢复目标应用焦点
    // 5. Sleep 200ms
    // 6. enigo 模拟 Ctrl+V (Press Control → Click V → Release Control)
}
```

---

*最后更新：2026-10-07；原开发记录主体保留截至 2026-05-16 的历史。*

### 2026-10-09 收尾验收归并补充

固定源码/分项指标和原字体发布集合经原始清单与哈希重核后，O-01/O-02 收回；完整 200% 矩阵与整体预算仍留原条目。连续物理唤起/原生粘贴补验存在偶发空文本，未因多轮成功而勾选。跳过监听重复读取的候选未消除失败，已恢复源码和原默认；所有受控轮停止 QA 后恢复/校验剪贴板。详见[决定、失败与范围](verification/2026-10-08-closeout.md#连续粘贴的未完成验收)。未提交、推送或发布。

### 2026-10-09：粘贴保护和可见失败提示收尾

受控对照观察到 Windows shell/input/clipboard 类别在 WM_CHAR 时占用剪贴板；不关闭系统历史、不认定某个组件解释全部历史失败。普通粘贴加入稳定等待、有界可用探测与序列/焦点/修饰键复核，失败在 V 前拒绝并释放 Ctrl；当前存储失败事件显示主窗可关闭提示，旧事件忽略。真实卡片 60 次、确定性原版空目标对照、短占用恢复、托盘/IME及 worker 排空证据保存；最终提示版负向/提示/旧事件和短占用恢复通过，但连续真实卡片第 17 次仍空、整轮未通过；不说偶发粘贴已完全修复，也不说所有旧功能在新 SHA 全量重跑。

类型/完整 lint/生产构建、前端 74 项及本轮全 Rust 137 项通过/3 忽略；最终 EXE 46,393,856 字节、NSIS/MSI 32,185,598/33,935,360 字节。20MB 为用户接受的尽力参考，停止扩大可选实验；整体内存和剩余验收缺口保留 TODO，未提交、推送或发布。详细报告、历史失败和恢复见[收尾](verification/2026-10-08-closeout.md#粘贴等待与失败提示收尾)。

### 2026-10-09：0.2.25 源码推送与 Release 草稿

用户另授权提交、推送及发布；原便签/优化 goal 保持暂停。源码 `8e76dabee6099ddd98c9a1fe475bf34d17eee5d5`、附注标签 `v0.2.25-baihejiangnan.1` 已推送 origin。由独立提交树构建正式标识 Windows x64 便携 EXE，46,393,856 字节，SHA `50513559c7ef7f96954e3dfb9186daacf32035b6365b7d49cbabfece81c3e378`，GitHub 草稿附件 digest 一致。归档中文目录解码问题已拒绝并修正，原字体与 Git 文件身份保留。

0.2.25 隔离版关于/版本/更新调度通过，但公开接口限流；普通物理快捷键与粘贴通过，随后真实托盘粘贴空目标、整轮未通过。两轮 8 格式剪贴板恢复/校验，精确夹具清理、原有全行哈希保持。正式 EXE 未访问实际用户数据，未把隔离 QA 称为同字节产物。保留 draft，未成为 Latest；公开预览或明确接受已知问题的发布选择待用户决定。详情见[发布记录](verification/2026-10-09-release-025.md)。
