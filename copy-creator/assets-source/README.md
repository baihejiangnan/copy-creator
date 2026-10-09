# 非发布资源

`fonts/` 保存当前界面未引用的 37 个原始字体（51,515,212 字节）。这些文件从 `public/字体/` 移到此处，保留源文件，避免 Vite 将未使用的字体复制到每次发布中。

当前使用的 PingFang Light、Regular、Medium、Semibold 和 SF Pro Display Black 仍放在 `public/字体/`，未转换、裁剪或修改。需要新增字重时，先更新 CSS 引用，再将对应原文件移回 public；同步核对发布体积及字体渲染。
