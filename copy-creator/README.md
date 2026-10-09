# Copy Creator

0.2.25 已在用户明确接受已知问题后[正式发布](https://github.com/baihejiangnan/copy-creator/releases/tag/v0.2.25-baihejiangnan.1)。普通/托盘粘贴偶发失败、内存与部分验收缺口继续保留；构建、校验和边界见[发布记录](../docs/verification/2026-10-09-release-025.md)，任务 goal 保持暂停。

2026-10-07：便签、共享保存与性能优化开发中，部分原生流程与容量统计对照已验证，联合验收尚未收齐；当前任务见 [TODO](../docs/TODO.md)，实测结果与限制见[验证记录](../docs/verification/2026-10-07-durability-pressure.md)。
PC 端效率辅助工具 —— 剪切板管理、快捷短语、翻译和网站资料，桌面悬浮窗形态，关闭后驻留系统托盘。

## 功能

- **设置分类与自动保存** — 设置按常规、剪贴板、翻译、数据、更新分类；选项立即保存，输入完成后自动保存，失败可重试，容量清理先确认

- **检查更新与关于** — 侧边栏「关于」展示项目信息和版本，「设置 → 更新」支持手动检查、自动检查开关及前往发布页下载；详见 [更新说明](../docs/features/updates.md)

- **剪切板管理** — 自动记录文本/图片复制历史，支持搜索和一键粘贴到当前光标位置，可设置保留时长自动清理
- **快捷短语** — 按场景分组管理常用话术/代码片段，点击即粘贴
- **翻译** — 支持 AI 翻译（兼容 OpenAI API 格式，可自定义端点和模型）和内置免费翻译，翻译结果本地缓存
- **网站资料** — 独立主密码加密的网站账号库，包含强密码生成、个人信息、自定义字段、二次验证联系方式和恢复码，支持单项复制与快速填入；详见 [功能说明](../docs/features/website-vault.md)
- **加密备份** — 设置、收藏、API Key 与密码箱统一加密导出，支持跨设备恢复、密码箱合并及旧 JSON 导入；详见 [备份说明](../docs/features/encrypted-backup.md)
- **系统功能** — 全局快捷键唤起/隐藏、窗口置顶、亮色/暗色主题、开机自启

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面框架 | [Tauri 2.x](https://tauri.app/) (Rust) |
| 前端 | React 19 + TypeScript + Vite |
| UI | 纯 CSS（iOS 风格磨砂玻璃） |
| 状态管理 | [Zustand](https://zustand-demo.pmnd.rs/) |
| 本地存储 | SQLite (rusqlite, bundled) |
| 国际化 | react-i18next（简体中文 / English） |

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm tauri dev

# 构建
pnpm tauri build
```

## Agent 协作

Agent 接手项目请先阅读仓库根目录 [AGENTS.md](../AGENTS.md)，了解项目整体、文档入口、开发约束与验证方式。

## 许可

MIT
