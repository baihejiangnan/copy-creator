# Copy Creator — Agent 工作指南

本文件是 Agent 接手本仓库的首要入口，适用于整个仓库。开始工作时先了解这里的项目结构与约束，再按任务读取对应文档和源码。

## 先建立项目上下文

1. 检查当前分支、工作区和任务相关 diff，识别用户或其他 Agent 已有的修改。
2. 阅读 [TODO](docs/TODO.md) 的任务关系、当前接手顺序及相关条目，确认实现进度、待验证项和验收条件。
3. 阅读下表中与本次任务相关的需求、架构和功能设计，再核对实际源码。首次接手跨模块任务时，先读 PRD 与架构的概览。
4. 按本文件的开发约束实施，收尾时同步受影响文档并报告实际验证结果。

任务进度统一维护在 TODO；本文件维护稳定的项目上下文、必要约束和文档入口。历史日志和旧交接记录提供背景，旧条目须核对当前源码后再处理。

## 项目整体

Copy Creator 是以 Windows 桌面为主要运行环境的本地效率工具，提供剪贴板历史、快捷短语、翻译、网站资料密码箱、便签、加密备份和设置。应用有主窗口与快捷轮盘窗口，涉及系统托盘、全局快捷键、剪贴板与原生粘贴。

- 前端：React 19、TypeScript、Vite、Zustand；界面使用自定义 CSS、CSS Variables 和现有字体，支持中文与英文。
- 原生层：Tauri 2、Rust；通过 Tauri commands/events 与前端交互，SQLite 数据由 Rust 层管理。
- 主窗口与轮盘是独立 WebView，各有自己的 JS 状态和请求队列；不能把单窗口的限流或缓存预算当作全应用预算。
- 当前开发分为便签 N、性能与体积优化 O，以及两者复用的保存、迁移、存储身份和后台调度 S。依赖与完成条件见 TODO，S 项只实现和验收一次。

## 代码与目录入口

仓库根目录承载 Agent 指令、项目说明、文档、辅助脚本及产物；**应用工程位于内层 `copy-creator/`**。执行开发命令前确认工作目录。

| 位置 | 职责 |
| --- | --- |
| [copy-creator/package.json](copy-creator/package.json) | 前端依赖和开发、构建、检查脚本 |
| [copy-creator/src/main.tsx](copy-creator/src/main.tsx)、[App.tsx](copy-creator/src/App.tsx) | 主窗口入口、页面与全局协调 |
| [copy-creator/src/radial.tsx](copy-creator/src/radial.tsx)、[vite.config.ts](copy-creator/vite.config.ts) | 轮盘入口和双入口构建配置 |
| [copy-creator/src/pages/](copy-creator/src/pages/)、[components/](copy-creator/src/components/) | 业务页面和复用组件 |
| [copy-creator/src/stores/](copy-creator/src/stores/)、[lib/](copy-creator/src/lib/) | 状态、保存协调器、请求调度及存储身份等逻辑 |
| [copy-creator/src/styles/](copy-creator/src/styles/)、[i18n/](copy-creator/src/i18n/) | 样式、主题和中英文文案 |
| [copy-creator/src-tauri/src/lib.rs](copy-creator/src-tauri/src/lib.rs) | 原生启动、模块接入和 command 注册 |
| [copy-creator/src-tauri/src/single_instance.rs](copy-creator/src-tauri/src/single_instance.rs) | Windows 启动前单实例门闸、重复启动唤起和原生重启锁交接 |
| [copy-creator/src-tauri/src/db.rs](copy-creator/src-tauri/src/db.rs) | SQLite、连接初始化和版本迁移 |
| [copy-creator/src-tauri/src/clipboard.rs](copy-creator/src-tauri/src/clipboard.rs)、[clipboard_wake.rs](copy-creator/src-tauri/src/clipboard_wake.rs)、[paste.rs](copy-creator/src-tauri/src/paste.rs) | 剪贴板采集、Windows 有界事件唤醒与原生复制/粘贴保护 |
| [copy-creator/src-tauri/src/maintenance.rs](copy-creator/src-tauri/src/maintenance.rs)、[db_metrics.rs](copy-creator/src-tauri/src/db_metrics.rs) | 周期清理、暂停重试及可选数值诊断 |
| [copy-creator/src-tauri/src/notes.rs](copy-creator/src-tauri/src/notes.rs)、[note_files.rs](copy-creator/src-tauri/src/note_files.rs) | 便签数据与原生文件引用操作 |
| [copy-creator/src-tauri/src/note_search.rs](copy-creator/src-tauri/src/note_search.rs) | 便签/引用的派生候选索引、短词回退与有界查询 |
| [copy-creator/src-tauri/src/lifecycle.rs](copy-creator/src-tauri/src/lifecycle.rs)、[storage.rs](copy-creator/src-tauri/src/storage.rs) | 生命周期交接、存储目录切换 |
| [copy-creator/src-tauri/src/updates.rs](copy-creator/src-tauri/src/updates.rs)、[update_package.rs](copy-creator/src-tauri/src/update_package.rs)、[update_signature.rs](copy-creator/src-tauri/src/update_signature.rs) | 公开更新元数据、运行模式、签名下载和保存后升级；独立发行验证器复用原生验签代码 |
| [copy-creator/src-tauri/src/backup.rs](copy-creator/src-tauri/src/backup.rs)、[note_backup.rs](copy-creator/src-tauri/src/note_backup.rs) | 加密备份、导入与便签恢复 |
| [copy-creator/src-tauri/src/vault.rs](copy-creator/src-tauri/src/vault.rs)、[vault_crypto.rs](copy-creator/src-tauri/src/vault_crypto.rs) | 密码箱权限、会话与加密 |
| [copy-creator/tests/](copy-creator/tests/) | 前端逻辑单元测试；Rust 测试位于原生源码中 |
| [copy-creator/public/](copy-creator/public/)、[assets-source/](copy-creator/assets-source/) | 随应用发布的资源、保留但不发布的原始素材 |
| [scripts/](scripts/) | 辅助验证脚本；运行前确认其目标和数据隔离方式 |

## 按任务阅读文档

| 要解决的问题 | 主要文档 |
| --- | --- |
| 项目目标、功能范围、产品要求 | [PRD](docs/specs/PRD.md) |
| 模块边界、前后端交互、数据流和技术决策 | [架构](docs/specs/ARCHITECTURE.md) |
| 当前任务、依赖、完成条件、接手顺序 | [TODO](docs/TODO.md) |
| 便签界面、捕获、自动保存、草稿恢复、搜索和验收 | [便签设计](docs/features/notes-design.md) |
| 资源体积、双窗口图片、查询/数据库热点、分包和性能测量 | [性能与体积优化方案](docs/features/performance-design.md) |
| 备份格式、容量边界、兼容、导入事务和恢复规则 | [加密备份与恢复](docs/features/encrypted-backup.md) |
| 密码箱、主密码、权限、复制/填入与资料保护 | [网站资料功能说明](docs/features/website-vault.md) |
| 更新检查、启动行为、MSI 升级及两个入口/安装后启动验收 | [更新说明](docs/features/updates.md) |
| 推送规则：提交、远端更新、版本号、便携构建和 GitHub Release 发布 | [推送规则（含构建与 Release 发布）](docs/features/release-rules.md) |
| 已执行检查的环境、结果和剩余验证边界 | [验证记录](docs/verification/)；优先读取 TODO 相关条目链接的记录；本轮入口为[轮盘随记与 Key 验证](docs/verification/2026-10-10-radial-notes-and-key.md) |
| 代码评审发现的缺陷、风险、死代码与建议修复顺序 | [代码修复清单](docs/reviews/2026-10-10-code-fix-list.md)；修复前先按清单核对行号是否仍有效 |
| 阶段变化、历史问题背景和 Windows 发行故障恢复 | [开发日志](docs/project_process.md)、[问题与解决方案](docs/problems_and_solutions.md) |
| 用户使用、安装及基础开发步骤 | [中文 README](README.md)、[English README](README_EN.md)、[应用 README](copy-creator/README.md) |

涉及多个主题时读取相应文档。例如修改目录切换，应同时检查架构、便签设计、备份与密码箱合同；修改发布体积，应读取优化方案并核对实际构建配置与资源。

接手提交、推送更新远端仓库、编译构建或 Release 发布任务时，须先阅读上表的[推送规则](docs/features/release-rules.md)，按用户本次授权范围执行。仅要求推送源码时不自动发布 Release；同时授权发布时按规则完成构建、验证、标签与发布。

## 开发必须遵守的约束

### 工作区与数据

- 保留用户及其他贡献者的未提交修改；修改前重读目标文件及相关 diff，合并针对性补丁，不覆盖无关内容。
- 默认使用合成夹具、临时数据库和隔离的测试应用标识进行验证。访问实际用户数据库、密码箱、剪贴板记录或备份前，确认本次任务已明确授权该访问。
- 隔离 identifier 不代表系统集成也隔离。核对自动启动等插件实际按标识、产品名还是全局项定位；非生产标识的自动启动名称必须独立，图片粘贴临时目录及过期回收也必须按应用标识隔离；旧共享目录 QA 产物不能直接重放。受控系统剪贴板/快捷键测试保留授权和恢复证据，发现测试副作用时先恢复并修正隔离。
- QA 启动前与验收收尾通过 `scripts/qa-process-isolation.ps1` 核对全部测试根目录的实时可执行路径；当前 `process.json` 的 PID 不能证明旧搜索/profile/基线实例已停止。旧搜索实验启动器已停用，基线缺少系统隔离时先重建。
- 日志、验证记录和文档不得包含真实 API Key、密码、恢复码或用户内容。保护和脱敏规则必须在原生层成立。

### 保存、存储与保护边界

- 退出、重启、备份和目录切换遵守统一保存屏障与原生交接；失败或超时不能当作保存成功，未确认草稿必须保留并可恢复。
- 保留请求幂等、revision 冲突校验及存储身份检查；目录切换后旧响应、事件和写入不能污染新存储。待保存草稿不能靠清空缓存或 LRU 淘汰处理。
- 便签有独立生命周期，不参与剪贴板 TTL/容量淘汰；删除文件引用或便签不得删除外部文件。
- 密码箱与受保护 API Key 的权限、加密和清理保护必须保留；不得把受保护资料自动转存到普通便签或明文索引。
- 备份保留旧格式读取、认证、容量限制和原子回滚；存储迁移不得覆盖目标原有资料，失败保留原连接与可恢复路径。详细合同以对应设计为准。

### 界面与性能

- 保留现有功能、字体、美化、主题与完整图片预览，复用已有设计 token；用户可见文案同步中文和英文。
- 队列、缓存、后台任务和大数据读取应有边界；重操作与锁内工作按具体测量改进。
- 优化须提供相同环境的对照证据。前端资源体积、EXE/安装包体积、进程内存和运行延迟分别报告；构建通过不能替代桌面功能、视觉或 Release 性能验收。
- 便签可靠性及自身运行预算是首发要求；其他旧模块优化仅在证据成立时成为前置条件，依赖变化记录到 TODO。

## 开发与验证命令

以下命令从内层 `copy-creator/` 执行，前提是相关依赖和工具链已经准备好。具体依赖版本以 package.json、pnpm-lock.yaml、Cargo.toml 和 Cargo.lock 为准。

| 用途 | 命令 |
| --- | --- |
| 启动完整桌面开发环境 | `pnpm exec tauri dev` |
| 仅启动前端开发服务 | `pnpm dev`（不包含真实 Tauri 原生能力） |
| 前端类型检查 | `pnpm exec tsc -b` |
| 前端逻辑单元测试 | `pnpm test:unit` |
| 前端完整 lint | `pnpm lint`；局部修改可用 `pnpm exec eslint` 指定相关文件 |
| 前端生产构建 | `pnpm build` |
| Rust 单元测试 | `cargo test --manifest-path src-tauri/Cargo.toml` |
| 正式桌面构建 | `pnpm exec tauri build` |

按改动范围执行必要检查。纯文档修改检查链接、导航、事实和 `git diff --check` 即可。涉及系统快捷键、剪贴板/粘贴、原生文件操作、窗口焦点或生命周期时，还需隔离桌面验证；未执行的项目明确标为待验证。性能结论需来自对应 Release 产物和参考环境。

## 文档维护与交付

- 文档按实际变化增量更新，保留既有结构、语言和未涉及章节。更换 Agent、模型或重复运行技能不构成重建文档体系的理由。
- 每个主题只维护一个主要位置。新文档或路径变化同步更新本文件中的入口；README 面向使用者，Agent 的项目上下文、导航和维护规则集中在本文件。
- 相关开发收尾同步 TODO、对应方案及受影响的 PRD/架构/功能说明。TODO 是唯一任务状态清单；日志记录阶段变化，验证记录保存实际证据。
- 区分当前实现、项目要求、计划与实测结果。代码存在但缺验收证据时保持未完成，并说明验证缺口；规范与实现冲突时记录差距，不把要求悄悄改成当前缺陷。
- 没有事实变化时不刷新日期、不新增重复检查记录。新增或重组文档须有实际用途，并维护相关引用。
- 交付说明修改内容、原因、执行过的检查及剩余问题；提交和推送状态按事实报告。
