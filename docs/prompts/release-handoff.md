# 推送与发布任务提示词

供用户复制给新 Agent。执行规则以 [发布规则](../features/release-rules.md) 为唯一主位置；这里负责明确当次授权，不替代规则或 TODO。

## 仅推送源码

```text
请接手 Copy Creator，仓库为 C:\Users\ABD18\Documents\Codex\copy-creator，应用在内层 copy-creator/。
本次只授权整理、验证、提交并推送本次任务的源码与文档到 origin/main。
先读 AGENTS.md、docs/TODO.md、docs/features/release-rules.md 及本次功能/验证记录，核对分支、所有 diff、未跟踪文件、远端 main。
选择性提交，保留其他任务的修改；混合文件按内容拆分，不用 git add .，不提交 output 内的数据库、备份、缓存、日志或私钥。
按实际改动执行必要检查，正常快进推送，不强推、不推 upstream；核验远端 SHA，并同步真实文档状态。
不改发行版本、不打包、不推发布标签、不创建或公开 Release。分别报告检查、提交、推送结果及剩余问题。
```

## 推送并发布新版 Windows Release

复制前填写「本次范围」和「验收取舍」。默认不把其他任务或历史接受自动纳入本次授权。

```text
请接手 Copy Creator，仓库为 C:\Users\ABD18\Documents\Codex\copy-creator，应用在内层 copy-creator/。
本次授权提交、推送并公开新版 Windows x64 正式 Latest Release；不发布 macOS/Linux，也不改 GitHub Pages 设置。
本次范围：[填写功能与文档；例如保险箱升级及必要配套文档]。
验收取舍：[填写本次明确接受的具体缺口；若留空，按规则完成可审查草稿后，才请求对无法补齐的缺口作决定]。

先阅读 AGENTS.md、docs/TODO.md、docs/features/release-rules.md、docs/features/updates.md 和本次功能/最新验证记录。
独立核对分支、暂存/工作区 diff、未跟踪文件、实际远端、远端 main、已公开版本和远端标签，不沿用提示词中的历史版本号。
列明本次包含/排除范围，选择性暂存，混合文件按内容拆分；保留其他任务的修改，不用 git add .，不提交数据库、备份、WebView 缓存、日志、旧源码归档或私钥。
仅使用合成资料与隔离环境；不能把单测、窗口启动或 MSI 表检查当成桌面验收。尽力补本次必要检查，不能补齐且未获本次接受的缺口按规则保留公开门槛。

选高于已分发版本的基础版本，同步 package.json、tauri.conf.json、Cargo.toml、Cargo.lock 的应用版本，固定完整提交 SHA。
在该提交的独立干净检出中安装锁定依赖，沿用匹配现有公钥的签名私钥，用 pnpm release:windows 正式构建；不使用 AllowDirty，不换 identifier 或发行密钥。
本轮成功摘要须 validationOnly=false、assets=6；最终 HEAD 等于 sourceCommit，检出干净，版本/MSI 标记一致。脚本已执行的整套检查不要无理由重复，额外检查按改动补齐。
正常快进推送 origin/main，不强推、不推 upstream；附注标签只绑定本次实际构建 SHA，仅推本次标签。
六附件使用明确路径上传草稿，按发行 ID 核对正文、标签解析、资产名、大小、uploaded 状态和摘要。满足当次公开条件后按已有授权转正式 Latest。
不移动旧标签或替换公开二进制；异常先查日志与远端状态，只恢复失败步骤。
公开后不带 token/Authorization，匿名独立下载全部六文件，比对本次成功构建摘要，并用可信源码构建的验证器检查签名、元数据、大小与 SHA256SUMS。
同步 TODO、相关说明与验证记录；源码推送、构建、草稿、公开、匿名核验和桌面验收分别报告，不把未验项目勾选为完成。
最后给出 Release URL、分支/已推 SHA、版本/标签/构建 SHA、六附件大小和哈希，以及剩余或本次明确接受的缺口。
```

本轮独立 Agent 审查与实际执行证据见[0.4.0 发行记录](../verification/2026-10-14-release-040.md)。
