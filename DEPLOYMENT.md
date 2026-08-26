# 部署、离线使用与备份

FolioPaw 的支持范围是个人、本机、无账号部署。默认 Compose 仅将 FolioPaw 映射到 `127.0.0.1:17890`，Ollama 和模型引导接口只存在于容器内部网络。

## 服务拓扑

| 服务 | 职责 | 宿主机端口 |
| --- | --- | --- |
| `foliopaw` | React 静态页面、Express API、SQLite | `127.0.0.1:17890` |
| `ollama` | 本地推理和模型存储 | 无 |
| `model-bootstrap` | 模型检查、下载、断点续传、校验、导入、测试和重试 | 无 |

`foliopaw` 不依赖 Ollama 健康状态，因此页面会先启动。模型未就绪且没有已启用云服务时，AI 接口返回包含当前阶段和设置页指引的 503；阅读和书库功能继续可用。`model-bootstrap` 不挂载 Docker Socket。

第三方模型的 API 地址、模型 ID 和 API Key 统一在“设置 → 模型服务”中配置，不写入 `.env`。`.env` 只用于可选的部署参数覆盖。

## CPU 一键启动

```bash
docker compose up -d
docker compose ps
```

访问 <http://127.0.0.1:17890>。首次安装建议至少 8 GB 内存、约 20 GB 可用磁盘；默认 GGUF 为 `3,013,027,808` 字节，Docker 镜像和构建缓存还会占用额外空间。

## 模型下载来源

`MODEL_DOWNLOAD_SOURCE` 支持：

- `auto`：先 Ollama 官方源；连接失败、404 或连续 90 秒无进度时回退 ModelScope。
- `ollama`：仅使用 Ollama 官方源，失败后停在 `failed`。
- `modelscope`：直接下载固定 ModelScope 文件。
- `local`：从只读挂载的 `./models` 导入，不发起权重下载。

ModelScope 固定文件信息见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。下载使用 `.part` 文件；服务器正确返回 `206` 和匹配的 `Content-Range` 时续传。若服务器忽略 Range 并返回 `200`，引导服务会安全清空部分文件后从头写入。大小或 SHA-256 不匹配时不会导入，并清除损坏文件。

设置页通过以下公开接口读取状态和发起重试：

```text
GET  /api/model-services/bootstrap
POST /api/model-services/bootstrap/retry
```

正在运行或已经就绪时重试返回 409；失败状态返回 202 后开始新任务。公开响应只包含阶段、来源、模型、字节进度、百分比、简化错误、更新时间和 `canRetry`。

## 中国大陆网络与代理

ModelScope 回退只处理权重下载，不处理 Docker 镜像和 npm 包：

1. Docker Hub 不可达时，在 Docker Desktop/守护进程配置可信的 registry mirror 或代理，也可以在 `.env` 覆盖 `OLLAMA_IMAGE`、`OLLAMA_ROCM_IMAGE`、`NODE_IMAGE`。
2. npm 构建下载可覆盖 `NPM_REGISTRY`。
3. 权重下载代理设置 `HTTPS_PROXY`。按照 Ollama 的代理建议，不给 Ollama 传入 `HTTP_PROXY`。
4. `FOLIOPAW_NO_PROXY` 必须包含 `localhost,127.0.0.1,ollama,model-bootstrap,foliopaw`，避免内部流量绕到代理。

项目不内置来源不明的镜像站。参考 [Docker 镜像代理说明](https://docs.docker.com/docker-hub/image-library/mirror/) 和 [Ollama 代理说明](https://docs.ollama.com/faq)。

示例：

```env
NPM_REGISTRY=https://registry.npmmirror.com
HTTPS_PROXY=http://host.docker.internal:7890
FOLIOPAW_NO_PROXY=localhost,127.0.0.1,ollama,model-bootstrap,foliopaw
```

修改模型下载设置后：

```bash
docker compose up -d --force-recreate model-bootstrap
```

已下载的 `.part` 会从持久化缓存继续。

## 完全离线首次启动

1. 在有网络的设备提前获取固定 GGUF 和全部 Docker 镜像，并自行安全传输。
2. 把 GGUF 放到 `models/Qwen_Qwen3.5-4B-Q4_K_M.gguf`。
3. `.env` 设置 `MODEL_DOWNLOAD_SOURCE=local`。
4. 执行 `docker compose up -d`。

local 模式默认使用与 ModelScope 回退相同的大小和 SHA-256。若文件不一致，引导失败且不会污染 `ollama_data`。

## GPU 覆盖配置

NVIDIA Container Toolkit 已正确安装的 Linux 主机：

```bash
docker compose -f compose.yaml -f compose.nvidia.yaml config
docker compose -f compose.yaml -f compose.nvidia.yaml up -d
```

支持 ROCm 且存在 `/dev/kfd`、`/dev/dri` 的 Linux 主机：

```bash
docker compose -f compose.yaml -f compose.amd.yaml config
docker compose -f compose.yaml -f compose.amd.yaml up -d
```

CPU、NVIDIA、AMD 三套配置都应在发布前运行 `docker compose ... config`。硬件驱动和容器运行时仍由部署者负责。官方示例见 [Ollama Docker 文档](https://docs.ollama.com/docker)。

## macOS 宿主机原生 Ollama

Docker Desktop 中的 Ollama 走 CPU。若要使用 Apple GPU：

1. 在宿主机运行 Ollama，并让它监听 Docker 可达地址：`OLLAMA_HOST=0.0.0.0:11434 ollama serve`。
2. 另开终端执行 `ollama pull qwen3.5:4b`，然后只启动 FolioPaw：

   ```bash
   OLLAMA_BOOTSTRAP_ENABLED=false docker compose up -d --build foliopaw
   ```

3. 设置页手动创建 Ollama 配置，地址为 `http://host.docker.internal:11434`。

这种模式不使用 Docker 托管配置和引导状态。应通过主机防火墙避免端口被局域网非可信设备访问。

## 数据持久化与备份

| 卷 | 数据 | 丢失影响 |
| --- | --- | --- |
| `readcat_data` | 数据库、配置、迁移备份 | 书库元数据、译文、API Key、阅读进度丢失 |
| `readcat_uploads` | 上传书籍和提取资源 | 原始文件与阅读资源丢失 |
| `ollama_data` | Ollama 模型 | 需要重新下载/导入模型 |
| `model_download_cache` | `.part`、引导状态 | 失去断点续传进度 |

常规停止不会删除卷：

```bash
docker compose down
```

为兼容已有安装，Compose 的内部项目 ID 和卷键仍使用原有的 `readcat` 标识；它们只影响 Docker 内部命名。产品界面、服务、镜像和包名均为 FolioPaw，项目改名不会创建空白书库或要求重新下载模型。

`docker compose down -v` 会删除上述全部数据，通常不可恢复。迁移数据库前，FolioPaw 会先创建 SQLite 一致性备份并只保留最近 5 份，但它不能代替卷外备份。

可使用经过审查的 Docker 卷备份流程，把卷内容复制到加密存储。备份与恢复期间应停止 FolioPaw，恢复时保留文件所有权；模型 API Key 可能存在于数据库及备份中。

## 数据库升级与托管配置

schema v3 会在自动备份后重建模型配置表：

- 增加 `ollama` provider、`context_window` 和 `managed_by`。
- 保留现有配置 ID、测试状态、启用状态和任务中的 `model_config_id`。
- Docker 启动时幂等维护一条 `managed_by=docker-bootstrap` 的配置。
- 模型、URL、上下文等参数变化时 revision 递增并重新测试。
- 托管期间设置页禁止编辑/删除；`OLLAMA_BOOTSTRAP_ENABLED=false` 后只清除托管标记，配置仍保留。
- 已启用第三方配置不会被本地 Ollama 抢占。

## 健康检查

```bash
curl --fail http://127.0.0.1:17890/health
docker compose ps
docker compose exec ollama ollama list
```

FolioPaw 健康只表示页面/API/数据库进程可用，不代表模型已下载。模型状态以设置页或 bootstrap API 为准。

## 可信局域网

Compose 有意固定绑定 `127.0.0.1`。若确需跨设备访问，应修改端口映射，并由反向代理终止 HTTPS、提供身份验证、限制来源。FolioPaw 自身没有访问控制；`CORS_ORIGINS` 不是身份验证或防火墙的替代品。不要直接转发到公网。

## 发布验收清单

- CPU、NVIDIA、AMD Compose 均通过配置校验。
- `docker compose up -d` 后 FolioPaw 页面先于模型下载可访问。
- 官方源模拟失败后自动切换 ModelScope，进度、校验、导入和测试阶段可见。
- 全新库在模型就绪后启用 Ollama；已有第三方启用状态不变。
- 停止外网后重启，聊天、翻译、摘要、导读和思维导图仍可运行。
- `foliopaw` 进程为非 root，只有 localhost 端口被发布，所有卷可写并可恢复。
- CI 使用模拟 Ollama/微型文件，不下载真实 3 GB 权重。
- 发布前至少完成一次中国大陆普通网络真实首次安装，并记录 Docker 镜像与权重来源表现。
