# 网站资料样式与动画同步验证

日期：2026-10-10。用户要求在随记/剪贴板样式同步后，继续统一网站资料外观与动画。本轮只调整前端组件和样式，未修改 Rust、加密、权限、存储身份或系统剪贴板/填入路径；版本仍为 0.2.28，未提交、推送或发布。

## 实现范围

- 修复 `vault.css` 通用 input 规则覆盖搜索的问题，网站资料与剪贴板/随记共用 `SearchInput`。搜索与紧凑新增按钮同排，列表去除额外英文大标题，保留中文标题、账号数量和生成器入口。
- 列表卡片固定 116px，统一圆角、浅色头像与标签、悬停/聚焦状态；长内容列表省略，详情完整呈现。详情的填入使用浅蓝背景，删除操作浅红；编辑、主密码、解锁和生成器沿用同一输入框/卡片样式。
- 抽取 `SelectMenu`，随记分组包装器、自动锁定、个人资料模板、验证方式模板复用。菜单 portal 到 body，最大 232×240px，边缘留 12px，内部滚动，长名称省略；键盘/焦点与减少动态效果支持保持。实际检测到滚动到按钮后，排队滚动事件会误关刚打开的菜单；改为触发器位置实际移动才关闭，随后模板选择通过。
- 模式切换容器 220ms 入场，卡片 350ms 入场并最多延迟 200ms，菜单/箭头/按钮有过渡。没有保留旧页面的退场动画；锁定立即清除资料/草稿并卸载敏感页面。

## 环境与证据

Windows、本地 Vite、Playwright CLI Chromium，540×680 和 380×480，亮/暗主题与中/英文。仅使用内存 Tauri IPC mock、虚构网站资料（初始 3 条、另新建 1 条）和 18 个随记分组；未访问用户数据库、真实密码箱、剪贴板或外部应用，复制/填入仅检查命令调用。

执行脚本及原始结果保存于 `output/playwright/vault-sync-check.js/.txt`、`vault-sync-artifacts.js/.txt`、`vault-sync-groups-regression.js/.txt`。夹具为 `vault-sync-fixture.tsx/.html` 和 `vault-sync-groups-fixture.tsx/.html`，验证后移出应用根目录；如需重放，分别复制回内层工程为 `vault-qa.tsx/.html`、`groups-regression-qa.tsx/.html`，用 5178 端口启动前端。复验后关闭两个浏览器会话并停止本轮 Vite，夹具不进入生产入口。

| 检查 | 实测结果 |
| --- | --- |
| 搜索一致性 | 亮/暗普通和聚焦的高度、边框、圆角、背景、阴影、输入字号/内边距与剪贴板相同；36px 高、10px 圆角，局部表单规则不再覆盖 |
| 列表高度与溢出 | 三条卡片均为 116px；长标题、网址、账号及标签省略；英文 380×480 列表/编辑及中文暗色详情无横向溢出 |
| 自动锁定菜单 | 232×132px；小窗口坐标 (136,93)，在视口内；End/Enter 选择第一次打开应用时，Escape 关闭并返回触发器焦点 |
| 新建、编辑及模板 | 新建保存返回详情；工作模板加入 5 字段（原 2 字段变为 7），通行密钥模板加入 1 项（原 1 项变为 2）；保存后详情保留；脏稿返回显示放弃确认，继续编辑可保存 |
| 详情行为 | 密码/敏感字段/恢复码默认遮罩；显示/隐藏正常；删除先确认，可取消；私密复制/填入仍调用 `copy_vault_field` / `paste_vault_field`，传记录 ID 和字段标识 |
| 锁定与解锁 | 未确认新稿下手动锁定，编辑/详情立即消失，store 记录为空、selected 为 null；错误主密码提示，正确合成密码重新显示列表 |
| 生成器与主密码 | 合成生成结果可展示；主密码表单保留 3 个 password 输入。未以 mock 验证随机安全性或真实主密码旋转 |
| 动画偏好 | 正常模式实际为 `pageEnter` / `cardEnter`；减少动态效果下 view animation 为 none，菜单/箭头也通过共享规则关闭动画 |
| 随记共用菜单回归 | 18 个分组加未分组均显示；End/Enter 选末项，正文保持；收起后选择器和 Escape 焦点正常；暗色 380×480 菜单 (29,12)，232×233px 向上展开且全部在视口内 |

连续切换后的英文小窗口另测实际几何：panel scrollLeft=0、scrollWidth=clientWidth=380；内部页面/标题/搜索/元信息均 x=16、宽 348px，没有内部横向滚动。结果保存于 `output/playwright/vault-sync-final-narrow.txt`，截图重新采集后显示完整。

截图已人工检查：

- [列表亮色](../../output/playwright/vault-sync-list-light.png)、[详情亮色](../../output/playwright/vault-sync-detail-light.png)、[新建亮色](../../output/playwright/vault-sync-editor-light.png)、[解锁亮色](../../output/playwright/vault-sync-gate-light.png)。
- [英文暗色小窗口列表](../../output/playwright/vault-sync-list-dark-narrow-en.png)、[暗色菜单](../../output/playwright/vault-sync-menu-dark-narrow-en.png)、[英文暗色编辑](../../output/playwright/vault-sync-editor-dark-narrow-en.png)、[中文暗色详情](../../output/playwright/vault-sync-detail-dark-narrow.png)。
- [随记分组回归](../../output/playwright/vault-sync-groups-dark-regression.png)。

## 工程检查与边界

内层工程执行 `pnpm exec tsc -b`、`pnpm lint`、`pnpm test:unit`（84/84）、`pnpm build`，全部通过；`git diff --check` 通过。临时夹具中未使用变量的 lint 问题已修正，夹具移出后完整 lint 再次通过。未因本轮纯前端修改重复执行 Rust 测试。

浏览器结果不代表真实 WebView2、Windows 100%–200% 缩放或系统焦点/外部私密填入验收。本轮没有启动原生 QA，也未访问实际用户资料或更改系统剪贴板；这些联合桌面项继续保持待验，TODO 不勾选整项。
