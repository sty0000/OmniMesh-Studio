# Qwen vLLM Web UI

这是一个专为基于 vLLM 部署的 Qwen 模型定制的轻量级 Web 前端页面。它允许你直接通过浏览器连接到部署在 Linux 服务器并通过 SSH 转发到本地端口（如 `localhost:8000`）的 vLLM 服务。

## 特性

- **开箱即用**: 原生 HTML/CSS/JS (基于 Vue 3 和 Tailwind CSS CDN)，无需编译，静态资源直接双击 `index.html` 即可使用。
- **自动解析配置**: 能够读取同目录下的 `service_start_log.txt` 自动提取服务 API 地址、模型名称、最大上下文和 API Key。
- **流式输出**: 实时流式响应（SSE），支持打字机效果。
- **多轮对话**: 支持切换多轮对话/单轮对话模式。
- **参数调节**: 可视化调节 Temperature, Top P, Max Tokens。
- **性能体验**: 自动捕获首字响应时间 (TTFT) 与 Token 消耗统计，具备网络异常与超限报错的一键重试功能。

## 启动与使用步骤

### 1. 服务部署与端口转发

假设你的 vLLM 部署在远程 Linux 服务器，使用以下命令将服务器的 8000 端口转发到本地：

```bash
ssh -L 8000:localhost:8000 user@your_server_ip
```

或者如果你在本地 WSL 中运行：

```bash
# 本地 WSL 默认共享网络，通常直接通过 localhost:8000 即可访问。
```

### 2. 生成日志文件

在启动 vLLM API Server 时，将启动日志保存到 `service_start_log.txt` 中。例如：

```bash
python -m vllm.entrypoints.openai.api_server --model Qwen/Qwen1.5-7B-Chat --max-model-len 32768 --api-key sk-123456789 > service_start_log.txt 2>&1
```

将该日志文件拷贝到与 `index.html` 相同的目录下。

### 3. 打开页面

直接在文件管理器中双击 `index.html`。

> **注意**: 现代浏览器由于跨域和安全策略（CORS），在通过 `file://` 协议打开时无法自动读取同目录下的 txt 文件。页面会弹出一个提示框，要求你**手动选择** `service_start_log.txt` 文件，即可完成初始化。
>
> 如果你想让其自动读取，可以在该目录下启动一个简单的本地 HTTP 服务：
>
> ```bash
> python -m http.server 3000
> ```
>
> 然后在浏览器访问 `http://localhost:3000/index.html`。

## 开发与测试

本项目提供了完整的单元测试（Vitest）和代码规范检查（ESLint + Prettier）。

### 安装依赖

```bash
npm install
```

### 运行测试 (覆盖率 >= 80%)

```bash
npm run test
```

### 代码格式化与检查

```bash
npm run lint
npm run format
```

## 技术栈

- Vue 3 (CDN)
- Tailwind CSS (CDN)
- Marked.js (CDN, 用于 Markdown 渲染)
- Vitest (单元测试)
