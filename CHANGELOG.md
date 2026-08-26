# 更新日志

本项目使用 Keep a Changelog 的结构，并计划采用语义化版本。

## [尚未发布]

### 新增

- EPUB/PDF 本地书库、阅读进度、文件夹和 PDF 原版阅读。
- 单页/批量翻译、摘要、阅读导读、思维导图和书籍问答。
- OpenAI 兼容、Anthropic 兼容和 Ollama 原生模型服务。
- FolioPaw、Ollama 和模型引导服务的 Docker Compose 一键部署。
- Ollama 官方源与固定 ModelScope GGUF 回退，支持断点续传、SHA-256 校验和离线导入。
- schema v3 数据库迁移、迁移前备份和 Docker 托管模型配置。
- GitHub Actions、Dependabot、Issue/PR 模板、安全政策和第三方许可声明。

### 变更

- 用户界面、公开 API 提示、模型引导状态、AI 输出约束和开源文档统一使用简体中文。
- AI 长文本使用统一上下文预算；摘要、翻译、导读、思维导图和问答会按任务自动拆分或裁剪。
- 项目名称、应用界面、包元数据和容器服务统一使用 FolioPaw 品牌。
- Compose 内部项目 ID 和数据卷键保留旧标识，确保已有本地数据无迁移升级。
- Docker 仅向宿主机发布 FolioPaw 的 localhost 端口，Ollama 和引导接口保留在容器网络内。
- 默认开发/Docker 入口改为 `127.0.0.1:17890`，避免与 macOS AirPlay 的 5000 端口冲突。
- 第三方模型 API 只在设置页配置，不写入 `.env`。

### 移除

- 注册、登录和多用户能力；FolioPaw 明确为单设备、单人本地书库。
- Codex CLI 模型调用和本地进程配置。
