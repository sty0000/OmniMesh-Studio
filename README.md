# Qwen vLLM Web Client

这是一个专为 Qwen (特别是 Qwen3-Omni-Thinking 等多模态强推理模型) 打造的纯静态、高性能本地 Web 客户端。它支持流式打字机输出、思考过程折叠、多模态输入（图片/视频/音频上传与麦克风录音）、多对话并发管理以及基于 IndexedDB 的无限容量本地历史记录存储。

## 如何部署与使用 (适合团队共享)

为了让团队中的其他人也能通过 SSH 轻松使用这个客户端，请按照以下步骤在您的 Linux 服务器（如 DRX Spark）上进行部署和重启服务。

### 1. 准备代码与启动脚本
确保您的服务器上有一个专门的目录存放这些文件（例如 `~/qwen-web-client`）。将本项目的 `index.html`, `utils.js` 等文件放入其中。

同时，确保您的启动脚本（如 `start_vllm.sh`）也放在同级目录，或者能在该目录下执行。
**注意**：为了支持音频输入，请确保您的脚本中 `--limit-mm-per-prompt` 参数包含了 `audio`（如：`'{"image":2,"video":1,"audio":1}'`）。

### 2. 重启 vLLM 服务
如果之前有旧的 vLLM 服务在运行，需要先将其停止：
```bash
# 查找正在运行的 vLLM 进程
ps aux | grep vllm.entrypoints.openai.api_server

# 杀掉对应的进程 (替换 PID 为实际进程号)
kill -9 <PID>

# 重新运行您的启动脚本 (它会自动在后台运行并监听 8000 端口)
bash start_vllm.sh
```

### 3. 启动前端静态文件服务
为了让前端能被访问，我们需要在这个目录下启动一个轻量级的 Web 服务器。推荐使用 Python 自带的 `http.server`，并将其放到后台运行（例如监听 3000 端口）：
```bash
# 在存放 index.html 的目录下执行：
nohup python3 -m http.server 3000 > frontend.log 2>&1 &
```

### 4. 团队成员如何访问 (通过 SSH)
现在，服务已经在服务器上跑起来了（vLLM 在 8000 端口，前端在 3000 端口）。
任何有服务器 SSH 登录权限的团队成员，只需要在**他们自己的电脑（Windows/Mac）**上打开终端，执行以下命令建立端口转发：

```bash
ssh -L 8000:localhost:8000 -L 3000:localhost:3000 user@您的服务器IP
```
*(注意：保持这个终端窗口打开，不要关闭)*

建立隧道后，团队成员只需在自己电脑的浏览器中访问：
👉 **http://localhost:3000**

即可直接进入现代化、全屏响应式的 AI 对话界面，享受 64k 长上下文与极致的推理体验！所有的对话记录和系统提示词设置都会保存在他们各自浏览器的本地数据库中，互不干扰。

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
