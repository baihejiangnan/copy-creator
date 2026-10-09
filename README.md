<div align="right">


2026-10-07：便签、共享保存与性能优化开发中，部分原生流程与容量统计对照已验证，联合验收尚未收齐；当前任务见 [TODO](docs/TODO.md)，实测结果与限制见[验证记录](docs/verification/2026-10-07-durability-pressure.md)。
[English](./README_EN.md) | 中文

</div>

<div align="center">

<img src="copy-creator/public/logo.png" alt="Copy Creator Logo" width="120">

# Copy Creator

**PC 端效率辅助工具**

剪切板管理 · 快捷短语 · 翻译 · 网站资料

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Windows%2010+-brightgreen.svg)
![Tauri](https://img.shields.io/badge/Tauri-2.x-ffc131.svg)
![React](https://img.shields.io/badge/React-19-61dafb.svg)

</div>

---

## 项目简介

Copy Creator 是一款轻量级的 Windows 桌面效率工具，以悬浮窗形式呈现，关闭后自动驻留系统托盘。它集成了剪切板历史管理、快捷短语、翻译和网站账号资料管理，帮助用户处理常用文本并集中保存网站信息。

## 界面截图

**剪贴板去重与批量清理设置**

![剪贴板设置界面，包含重复内容合并时间、主动去重和按日期批量删除](./docs/screenshots/clipboard-settings.png)

**翻译示例**

![翻译界面，展示英文示例文本及中文翻译结果](./docs/screenshots/translation.png)

## 主要功能

### 检查更新与关于

- 侧边栏「关于」展示项目、安装版本、许可证及仓库链接。
- 「设置 → 更新」和「关于」共用检查更新功能，支持启动时自动检查、更新说明和前往发布页下载；详见 [更新说明](./docs/features/updates.md)。

### 📋 剪切板管理
- 自动记录文本和图片的复制历史
- 支持关键词搜索，快速定位历史内容
- 一键粘贴到当前光标位置
- 相同类型和内容在可设置的时间内重复复制时，更新已有记录到列表顶部（默认 15 分钟，可选 1 秒等时长）
- 可主动清理历史重复记录，或按两个月、一个月、7 天、3 天及今天前的日期批量删除；执行前可查看数量并确认
- 可设置保留时长，自动清理过期记录

### ⚡ 快捷短语
- 按场景分组管理常用话术和代码片段
- 支持自定义分组，灵活组织内容
- 点击即粘贴，无需手动复制

### 🌐 翻译
- **AI 翻译**：兼容 OpenAI API 格式，可自定义端点和模型
- **内置翻译**：免费翻译服务，开箱即用
- 翻译结果本地缓存，避免重复请求

### 🗝️ 网站资料与密码箱

- 按网站保存多个账号，完整记录用户名、密码、注册邮箱和手机号；按网站、网址、账号、联系方式或标签搜索。
- 生成 12–64 位强密码，可选择字符类型并排除相似字符，默认 24 位。
- 提供个人 / 工作资料模板，支持任意文字字段，并可标记敏感信息。
- 提供邮箱、短信、恢复码、安全问题、验证器应用、通行密钥和自定义验证方式模板；保存联系方式、恢复码和说明。
- 使用独立主密码，通过 Argon2id 和 AES-256-GCM 加密全部网站资料；支持修改主密码。
- 单项资料支持「复制」和「填入」；先选中输入框，再呼出窗口点击「填入」，即可返回此前窗口粘贴。固定窗口可连续操作。
- 空闲 5 分钟、隐藏或最小化窗口后锁定；复制内容不进入本应用历史，并设置 Windows 历史与云剪贴板排除标记，30 秒后按剪贴板归属清除。

本功能已在源码中实现，现有 v0.2.24 下载包尚未包含。操作说明和存储边界见 [网站资料功能说明](./docs/features/website-vault.md)。

### 🔒 本地凭据保护

- 翻译 API Key 与识别或手动标记的剪贴板 API Key 使用 Windows DPAPI 按当前用户加密后存入本地数据库；旧版明文记录在首次启动新版时迁移。
- 设置页只显示 Key 是否已配置；导出使用独立备份密码加密设置、收藏、API Key 和完整密码箱，支持跨设备恢复、密码箱合并及旧 JSON 导入。详见 [加密备份与恢复](./docs/features/encrypted-backup.md)。旧版备份仍可能包含明文 Key，请妥善处理。
- 加密数据依赖当前 Windows 用户环境，直接复制数据库到另一台电脑通常无法解密。程序无法识别所有格式的密钥；未识别的敏感文本应手动标记或删除。

### ⚙️ 系统功能
- 设置按常规、剪贴板、翻译、数据、更新分类；选项立即保存，输入完成后自动保存，失败可重试
- 全局快捷键唤起/隐藏窗口
- 窗口置顶显示
- 亮色/暗色主题切换
- 开机自启动

## 技术栈

| 层级 | 技术选型 |
|:---:|:---|
| 桌面框架 | [Tauri 2.x](https://tauri.app/) (Rust) |
| 前端框架 | React 19 + TypeScript |
| 构建工具 | [Vite](https://vitejs.dev/) |
| UI 样式 | 纯 CSS（iOS 风格磨砂玻璃效果） |
| 状态管理 | [Zustand](https://zustand-demo.pmnd.rs/) |
| 本地存储 | SQLite (rusqlite, bundled) |
| 国际化 | react-i18next（简体中文 / English） |

## 下载

0.2.25 源码已推送，便携 EXE 已上传为 Release 草稿，尚未公开。连续粘贴及部分性能验收仍有缺口，当前可下载正式版仍为下列 0.2.24。详情见 [0.2.25 发布记录](./docs/verification/2026-10-09-release-025.md)。安装

前往 [本仓库 Releases](https://github.com/baihejiangnan/copy-creator/releases/tag/v0.2.24-baihejiangnan.1) 下载最新便携版：

| 文件 | 说明 |
|:---|:---|
| [Copy-Creator-0.2.24-portable.exe](https://github.com/baihejiangnan/copy-creator/releases/download/v0.2.24-baihejiangnan.1/Copy-Creator-0.2.24-portable.exe) | Windows 便携版，下载后直接运行，无需安装 |

**系统要求**：Windows 11

## 操作说明

### 基本使用

1. **启动应用**：双击便携版 EXE，应用将以悬浮窗形式显示
2. **驻留托盘**：关闭窗口后，应用会隐藏并继续在系统托盘运行
3. **唤起窗口**：使用全局快捷键（默认可在设置中查看）快速唤起/隐藏窗口

### 剪切板功能

1. 复制任意文本或图片，系统会自动记录到剪切板历史
2. 点击托盘图标或使用快捷键打开主窗口
3. 切换到「剪切板」标签页，浏览或搜索历史记录
4. 点击任意记录即可一键粘贴到当前光标位置

### 快捷短语功能

1. 切换到「短语」标签页
2. 点击「新建分组」创建场景分组（如：客服话术、代码片段等）
3. 在分组中添加常用短语
4. 需要使用时，点击短语即可粘贴到当前输入位置

### 翻译功能

1. 切换到「翻译」标签页
2. 输入或粘贴需要翻译的文本
3. 选择翻译方向（如：中文 → 英文）
4. 点击翻译按钮获取结果
5. 如需使用 AI 翻译，请在设置中配置 API 端点和密钥

### 网站资料功能

1. 切换到「网站资料」，设置独立主密码，长度自行决定（例如 6 位），不能为空或全是空白；主密码无法找回。
2. 点击「新增账号」，填写网站和基础账号信息，可生成强密码。
3. 按需加入个人资料和验证方式模板，也可自行添加、命名文字字段。
4. 保存后输入网站名称或网址搜索，打开详情即可查看、复制或「填入」单项资料。填入前先选中目标输入框，再用快捷键呼出本窗口。
5. 已复制内容可在窗口隐藏后继续粘贴，30 秒后自动清除；新的读取和复制必须先解锁。

设置页加密备份包含全部网站资料，恢复时仍需对应的密码箱主密码。目前不提供网站资料图片、TOTP 动态验证码、云同步或自动识别网页字段的浏览器扩展。

### 个性化设置

- **快捷键**：自定义全局快捷键
- **主题**：切换亮色/暗色主题
- **开机自启**：设置是否开机自动启动
- **存储管理**：配置剪切板历史保留时长
- **历史清理**：设置重复内容合并时间，主动去重或按日期批量删除

## 开发指南

### 环境准备

- [Node.js](https://nodejs.org/) (推荐 18+)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/)
- [Tauri CLI](https://tauri.app/)

### 本地开发

```bash
# 克隆项目
git clone https://github.com/baihejiangnan/copy-creator.git
cd copy-creator/copy-creator

# 安装依赖
pnpm install

# 启动开发模式
pnpm tauri dev

# 构建生产版本
pnpm tauri build
```

## 项目结构

```
copy-creator/
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   ├── pages/              # 页面组件
│   ├── stores/             # Zustand 状态管理
│   ├── styles/             # CSS 样式文件
│   ├── i18n/               # 国际化配置
│   └── types/              # TypeScript 类型定义
├── src-tauri/              # Tauri 后端源码
│   ├── src/                # Rust 源码
│   └── Cargo.toml          # Rust 依赖配置
├── public/                 # 静态资源
├── assets-source/          # 保留但不随应用发布的原始素材
└── package.json            # 前端依赖配置
```

## Agent 协作

Agent 接手项目请先阅读根目录 [AGENTS.md](AGENTS.md)，其中包含项目整体、代码入口、文档阅读路径、开发约束与验证方式。

## 许可证

本项目采用 MIT 许可证开源。

---

<div align="center">

如果觉得这个项目对你有帮助，欢迎点个 Star 支持一下！

感谢baihejiangnan的贡献！


</div>
