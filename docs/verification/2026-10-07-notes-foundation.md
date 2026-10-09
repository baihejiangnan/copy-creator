# 2026-10-07：便签数据层与字体发布集合验证

本记录只描述第一批已实现内容及验证证据；任务勾选统一维护在 [TODO](../TODO.md)。便签页面、保存协调器、v3 备份和便签搬迁尚未接入，不代表功能首发完成。

## 实现范围

- [notes.rs](../../copy-creator/src-tauri/src/notes.rs)：独立便签/引用表；正文和引用同事务；revision CAS；创建身份和最后变更请求 SHA-256；全文读取、摘要游标分页、字面子串搜索；归档、软删除及七天内恢复；普通剪贴板全文/链接/明确文件路径快照；提交后无正文的变更事件。
- [db.rs](../../copy-creator/src-tauri/src/db.rs)：启动与目标库共用 `initialize_connection`。WAL、synchronous=NORMAL、8 MiB 页缓存、外键及 5s busy timeout 一致。版本 1 为既有表迁移，版本 2 为便签；各步事务提交，失败保持上一个版本，未来版本拒绝打开。目标初始化不再无条件删除现有 `api_key_labels`。
- 后端 `storage_epoch` 随连接切换提升；便签持锁后校验预期身份，结果/事件携带实际身份。前端调用、事件和缓存尚未整体接入。
- 便签命令在 `spawn_blocking` 中执行；最多接受 4 个读任务/32 个写任务，包含排队和在途；写入待处理时拒绝新增查询，超额返回 `notes.busy`。有排队/锁等待/执行持锁 debug 日志；这不是已经完成尾延迟或独立 SQL 测量。
- 37 个未引用原始字体移至 [assets-source](../../copy-creator/assets-source/README.md)，当前 5 个字体仍在 public；没有字体转换、裁剪或字重替换。

当前没有便签侧栏入口。原生引用操作与文件选择归 N-02；前端查询代次、草稿、过期便签物理清理仍需后续实现。现有备份格式为 v2，尚不含便签；目录迁移遇到源库或目标库存在便签时拒绝切换，避免尚未接入的迁移遗漏数据。保存交接、N-05/N-06 完成前保持保护。

## 环境与隔离

| 项目 | 本次环境 |
| --- | --- |
| 系统 | Windows 11，NT 10.0.22631.0 |
| Node | v24.19.0 |
| Rust | rustc 1.98.1，48a229cea，2026-09-01 |
| Cargo | 1.98.1，797e8a9bc，2026-08-05 |
| 前端 | 项目锁定依赖，Vite 8.0.12，TypeScript 6.0.2 |
| 源码基线 | HEAD `2fca698` 加开始本批之前全部已跟踪/未忽略未跟踪文件及原有未提交差异 |

未启动桌面应用，未读取用户数据库。SQLite 测试使用内存库或唯一命名临时文件；文件引用测试只操作临时夹具，不读取外部文件正文。未覆盖原有未提交修改。

R0 先保存 184 个源文件，共 98,993,234 字节，附逐文件 SHA-256、完整 HEAD、Node 版本及 `git diff --binary HEAD`。本地证据目录被 Git 忽略，不随仓库提交：

```text
output/optimization/R0-20261007/source/
output/optimization/R0-20261007/manifest.json
output/optimization/R0-20261007/working-tree.patch
output/optimization/R0-20261007/frontend/
output/optimization/R1-fonts-20261007/frontend/
output/optimization/R1-fonts-20261007/comparison.json
```

后续实验另建目录，不覆盖 R0/R1。不能使用当前已精简的 public 重新生成并冒充 R0；恢复基线需使用其源码快照与固定依赖。

## Rust 验证

工作目录 `copy-creator/src-tauri/`：

```powershell
cargo test --offline --lib
```

最终结果：**85 passed，0 failed**，其中新增 20 项（14 项便签、6 项共享数据库/迁移/清理隔离），原有 65 项全部通过。

| 验证组 | 覆盖内容 |
| --- | --- |
| 输入与引用 | UTF-8 字节/Unicode 标题上限、保留正文空白、空草稿不落库、20 引用上限、重复引用及危险 URL/相对路径拒绝 |
| 幂等与冲突 | 创建重试不覆盖后续保存、mutation 改内容拒绝、响应丢失重放、旧 revision 返回当前版本、不覆盖新稿 |
| 原子性 | 引用唯一键冲突时正文、revision、原引用和新建记录全部回滚 |
| 整理与查询 | 归档过滤、删除后晚保存拒绝、保留期恢复、并列时间游标无重漏、摘要响应不含正文、活动索引 EXPLAIN 命中 |
| 搜索 | `%`、`_`、反斜杠、引号及单字中文作为普通输入；注入样例不扩展结果 |
| 捕获 | 2,500 个中文字全文、源记录删除后重试仍确认同条、链接正文与结构化引用、不同主动动作允许各建一条 |
| 数据边界 | DPAPI 标记/识别 Key/手动 Key/带标签 Key 拒绝，图片和非明确路径拒绝；删除便签不动外部临时文件 |
| 身份与事件 | 切换后旧 epoch 拒绝；事件仅含身份、版本、mutation 和变更类别，幂等重放不重复通知 |
| 连接与迁移 | 重复初始化保留数据、NORMAL/缓存/外键/超时配置、磁盘 WAL、迁移两步失败回滚、未来版本拒绝、剪贴板 TTL 不删便签和引用 |
| 原有回归 | 剪贴板、受保护 Key、密码箱、加密备份、设置、更新和快捷键已有单元测试 |

最初在受限环境执行时，原有 10 个 DPAPI 相关用例返回系统错误 `0x80070002`；在正常 Windows 用户环境执行全部通过。未替换加密实现、跳过测试或写入明文来规避此限制。

## 前端与字体验证

在 `copy-creator/` 中执行 TypeScript 检查。两个 Vite 命令分别在移动字体前后执行，前端业务源码相同：

```powershell
node ./node_modules/typescript/bin/tsc -b
node ./node_modules/vite/bin/vite.js build --outDir ../output/optimization/R0-20261007/frontend
node ./node_modules/vite/bin/vite.js build --outDir ../output/optimization/R1-fonts-20261007/frontend
```

TypeScript 和两个构建通过。逐文件读取输出、累加实际文件字节并比较 SHA-256：

| 指标 | R0 | R1 |
| --- | --- | --- |
| 文件数 | 50 | 13 |
| 前端发布目录 | 97,489,964 字节 | 45,974,752 字节 |
| 发布字体 | 42 个 | 5 个 |
| 减少量 | — | 51,515,212 字节，约 52.84% |
| 保留产物 | 基线 | 全部 13 个文件逐文件哈希一致 |
| 原始字体 | 42 个 | 原位置 5 个 + 非发布目录 37 个，全部哈希一致 |

保留字体为 PingFang Light/Regular/Medium/Semibold 和 SF Pro Display Black；JS、CSS、HTML、图片和图标同样保持哈希。Vite 仍提示主 JS 超过 500 kB；入口/页面分包按 O-07 后续处理，不能将字体移动算作 JavaScript 优化。

本次没有测 Rust Release EXE/安装包、字体实际渲染、不同 DPI/主题、WebView2 进程树、启动、CPU、输入或数据库尾延迟。字体文件一致提供资源未变的证据，不能代替桌面视觉回归；O-02 和整体优化验收因此保持未勾选。

收尾文档检查：14 个相关文档的 114 个本地链接、代码块闭合和 22 个唯一任务 ID 通过；R0 的 184 个文件哈希再次核对一致，本批范围外的 125 个原文件保持原样，`git diff --check` 通过。
