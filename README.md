<p align="center">
  <img src="frontend/public/foliopaw-icon.png" alt="FolioPaw 项目图标" width="128" height="128" />
</p>

# FolioPaw 阅读猫

FolioPaw 是一个面向个人的 EPUB/PDF 阅读与 AI 翻译工具，支持翻译、摘要、阅读导读、思维导图和书籍问答。

FolioPaw 同时支持第三方模型 API 和本地 Ollama，数据使用 SQLite + FTS 保存，不需要额外的向量数据库。

> FolioPaw 按“单设备、单人书库”设计，没有账号和权限系统，请勿直接暴露到互联网。

## 主要功能

- EPUB/PDF 导入、书架管理和阅读进度
- 单页翻译与后台批量翻译
- 章节/全书摘要、阅读导读和思维导图
- 基于当前页和全书内容的 AI 问答
- OpenAI 兼容、Anthropic 兼容和 Ollama 本地模型

## 选择启动方式

### 方式一：命令启动 + 第三方模型 API

适合已经有 OpenAI、Anthropic 或兼容 API 服务的用户。

需要 Node.js `>= 22.12`：

```bash
npm ci
npm start
```

打开 <http://127.0.0.1:17891>，进入“设置 → 模型服务”，填写 API 地址、模型 ID 和 API Key，测试成功后即可使用。

第三方模型配置全部在设置页管理，不需要写入 `.env`。这种方式也不会自动下载本地模型。

需要停止服务时，在运行命令的终端按 `Ctrl+C`。

### 方式二：Docker 一键启动 + 免费本地模型

适合希望使用本地模型、不支付模型 API 费用的用户。

需要 Docker Desktop，或 Docker Engine + Compose v2。建议至少 8 GB 内存和约 20 GB 可用磁盘：

```bash
docker compose up -d
```

打开 <http://127.0.0.1:17890> 即可使用阅读功能。Docker 会在后台启动 FolioPaw、Ollama 和模型引导服务，设置页会显示下载进度；模型准备完成后会自动启用，无需填写 API Key。

默认模型为 `qwen3.5:4b`，首次需要联网下载约 3–3.4 GB 权重和 Docker 镜像。下载完成后，模型和项目数据会保存在 Docker 卷中，后续可以断网重启和使用。

> “免费”指不产生模型 API 调用费用，仍会使用本机的 CPU/GPU、内存、磁盘和电力。

如果 FolioPaw 中已有启用的第三方模型，Docker 启动后不会覆盖它。

## 中国大陆下载说明

默认会先尝试 Ollama 官方源。如果连接失败、404 或连续 90 秒没有下载进度，会自动切换到 ModelScope，并支持断点续传和 SHA-256 校验。

模型权重下载和 Docker 镜像下载是两件事。如果 Docker Hub 无法访问，需要为 Docker 配置可信的镜像源或代理。

更多代理、GPU、macOS 原生 Ollama 和完全离线安装方法，请查看 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

## 常用 Docker 命令

```bash
docker compose ps
docker compose logs -f model-bootstrap
docker compose down
```

`docker compose down` 会保留书库和模型数据。

> `docker compose down -v` 会删除本地模型、数据库、上传书籍和备份，通常无法恢复。

## 开发与检查

```bash
npm run dev
npm run check
```

开发模式前端为 <http://127.0.0.1:17890>，后端为 <http://127.0.0.1:17891>。
按 `Ctrl+C` 可同时停止前后端开发服务。

## 数据与隐私

- Docker 默认只把 FolioPaw 映射到 `127.0.0.1:17890`。
- 使用本地 Ollama 时，书籍文本只在本机处理。
- 使用第三方 API 时，翻译、问答和摘要所需的文本会发送给对应服务商。
- API Key 仅通过设置页录入并保存在本机 SQLite 数据库中，请勿提交数据库或上传目录。

## 更多文档

- [部署说明](DEPLOYMENT.md)
- [安全政策](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [第三方组件与模型声明](THIRD_PARTY_NOTICES.md)

项目采用 [MIT License](LICENSE)。
