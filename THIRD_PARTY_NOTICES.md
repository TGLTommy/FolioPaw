# 第三方组件与模型声明

FolioPaw 项目代码采用仓库根目录中的 [MIT License](LICENSE)。以下组件和模型仍受各自许可证约束。

## Ollama

- 组件：Ollama 服务端和 CLI
- 容器镜像：`ollama/ollama:0.32.15`（ROCm 使用 `0.32.15-rocm`）
- 源码：<https://github.com/ollama/ollama>
- 许可证：MIT
- 许可证副本：[`licenses/OLLAMA_LICENSE`](licenses/OLLAMA_LICENSE)

Compose 直接使用官方 Ollama 镜像；`model-bootstrap` 镜像从同版本官方镜像复制 Ollama CLI，并同时包含上述许可证副本。

## Qwen3.5-4B 模型

- 运行时模型标签：`qwen3.5:4b`
- 上游模型系列：Qwen3.5
- 许可证：Apache License 2.0
- Ollama 官方页面：<https://ollama.com/library/qwen3.5:4b>
- ModelScope 仓库：<https://modelscope.cn/models/bartowski/Qwen_Qwen3.5-4B-GGUF>

固定的 ModelScope 回退文件：

- 提交：`71b231d64df1bbbe8a03f63ea4274c3921da4700`
- 文件：`Qwen_Qwen3.5-4B-Q4_K_M.gguf`
- 大小：`3,013,027,808` 字节
- SHA-256: `13c16f426047e2de38cd075bdade4a7bcbc8c774384876f677740cda65f8a983`

模型权重不包含在本仓库或 FolioPaw 应用镜像中。首次使用时由用户环境直接下载到本地持久化卷；用户仍应在使用前核对上游模型卡和许可证。

## JavaScript 依赖

Node.js 依赖及精确版本记录在 `package-lock.json` 中。依赖主要使用 MIT、ISC、BSD、Apache-2.0 或其他兼容的宽松许可证；每个包的许可证文本随其 npm 包分发。发布前可运行：

```bash
npm ci
npm audit
```

本声明不是法律意见。重新分发容器、模型或修改后的第三方组件时，应重新检查对应版本的许可证义务。
