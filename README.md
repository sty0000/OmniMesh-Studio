# Qwen vLLM Web Client（运维增强版）

> 当前唯一推荐的长期运行方式：用 `systemd` 持久化托管，并通过 `sudo bash ops/restart_persistent.sh` 完成“停止旧进程 → 同步服务资产 → 从头重启”。不要继续使用 `node gateway.server.js` 或 `nohup ...` 作为长期运行方案。

本仓库现在提供一套可长期维护的内网部署方案：

- `qwen-vllm.service`：模型推理服务（vLLM）
- `qwen-gateway.service`：统一接入层（Web 静态托管 + OpenAI 兼容 API）
- `qwen-alert.timer`：每分钟采集指标并按阈值告警

> 目标：单机单实例（20-50 并发）稳定运行，具备自愈、可观测、可回滚能力。

---

## 1. 项目边界与运行模式

本项目的目标是把本地/内网多模态模型服务从“能跑起来”打磨成“能长期稳定服务”的 Web + Gateway 底座。它负责用户入口、API 网关、请求治理、upstream 观测与部署辅助，但不替代模型训练、GPU 驱动管理或完整集群平台。

### 1.1 项目负责

- Web Chat UI：提供内网用户使用的基础聊天入口，并为后续图文/多模态交互预留扩展空间。
- OpenAI 兼容 API 网关：统一转发 `/v1/models`、`/v1/chat/completions` 等请求到 vLLM/OpenAI 兼容上游。
- 鉴权、限流、排队、超时：在网关层提供 API Key、同源 Web bypass、rate limit、并发上限、全局队列和 upstream timeout。
- upstream 管理与故障跳过：支持 `VLLM_BASE` 单上游和 `VLLM_BASES` 多上游，提供 round-robin、failover、temporary circuit breaker。
- 健康与观测接口：提供 `/health`、`/ready`、`/internal/metrics`，用于区分进程健康、服务就绪和内部指标。
- systemd 与 ops 脚本：提供安装、启动、停止、重启、发布、状态检查、告警和 Ray dry-run 辅助脚本。
- 部署辅助：支持 `single`、`replica`、`ray` 三种运行模式的配置、脚本和排障入口。

### 1.2 项目不负责

- 训练模型或微调模型。
- 安装和维护 NVIDIA 驱动、CUDA、OFED、GPU 固件等底层依赖。
- 自动下载、同步或授权访问大模型权重。
- 替代 Kubernetes、Slurm、Ray Cluster Launcher 或云平台级资源调度系统。
- 自动完成真实 Ray 集群调度；本项目只提供 Ray 启停脚本、dry-run 验证、端口约定和 vLLM 参数入口。

### 1.3 运行模式

| 模式      | 适用场景                                             | 网关配置                                                                                                   | 关键特征                                                   |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `single`  | 一台机器、一个 vLLM 实例，优先用于最小内网服务       | `VLLM_BASE=http://127.0.0.1:8000`，`VLLM_BASES=`                                                           | 最简单，适合单机长期运行和基础验证                         |
| `replica` | 模型单机可容纳，需要双机吞吐或简单容灾               | `VLLM_BASES=http://node1:8000,http://node2:8000`                                                           | 网关 round-robin，多上游失败跳过和 per-upstream metrics    |
| `ray`     | 模型单机不可容纳，需要两台机器共同承载一个 vLLM 实例 | `VLLM_BASE=http://127.0.0.1:8000`，`VLLM_BASES=`，`EXTRA_VLLM_ARGS=--distributed-executor-backend ray ...` | Ray head/worker 先启动，入口节点只暴露一个 vLLM OpenAI API |

### 1.4 模式选择建议

- 如果模型能放进单机，优先使用 `single` 或 `replica`；需要吞吐和容灾时选择 `replica`。
- 只有在模型单机放不下时，再使用 `ray` 模式。
- `/health` 只表示网关进程健康；是否真正可服务以 `/ready` 为准；排障和趋势观察以 `/internal/metrics` 与 `ops/status.sh` 为准。

---

## 2. 目录与约定

推荐线上目录：

- 代码：`/opt/qwen-web`
- 配置：`/etc/qwen-web/*.env`
- 日志：`/var/log/qwen-web/*.log`

仓库内对应资产：

- systemd 模板：`deploy/systemd/`
- 环境变量模板：`deploy/env/`
- 日志轮转模板：`deploy/logrotate/qwen-web`
- 运维脚本：`ops/`

### 2.1 配置契约

`/etc/qwen-web/*.env` 是长期运行的正式配置入口。安装脚本只在文件缺失时复制示例，不会覆盖已有生产配置。

| 文件                        | 示例来源                         | 读取方                                                  | 作用                                                     |
| --------------------------- | -------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `/etc/qwen-web/gateway.env` | `deploy/env/gateway.env.example` | `qwen-gateway.service`、`ops/status.sh`                 | 网关监听、鉴权、限流、单/多 upstream。                   |
| `/etc/qwen-web/vllm.env`    | `deploy/env/vllm.env.example`    | `qwen-vllm.service`、`ops/status.sh`                    | 模型路径、vLLM 参数、多模态限制、Ray/vLLM 附加参数。     |
| `/etc/qwen-web/ray.env`     | `deploy/env/ray.env.example`     | `ops/ray_head.sh`、`ops/ray_worker.sh`、`ops/status.sh` | Ray head/worker IP、固定端口、worker 端口范围、dry-run。 |
| `/etc/qwen-web/alert.env`   | `deploy/env/alert.env.example`   | `qwen-alert.timer`                                      | 告警 URL、健康检查 URL、阈值。                           |

---

## 3. 首次安装（systemd）

```bash
cd qwen-vllm-web-client
chmod +x ops/*.sh
sudo bash ops/install_systemd.sh
```

安装完成后会自动：

1. 同步代码到 `/opt/qwen-web`
2. 安装 systemd 单元到 `/etc/systemd/system/`
3. 初始化配置文件（若不存在）到 `/etc/qwen-web/`
4. `daemon-reload` 并 `enable` 服务

然后编辑配置：

- `/etc/qwen-web/vllm.env`
- `/etc/qwen-web/gateway.env`
- `/etc/qwen-web/alert.env`（如需告警）

最后启动：

```bash
bash /opt/qwen-web/ops/start.sh
```

如果是“从头重启并切换到持久化启动”，建议直接看下一节，优先使用一键脚本。

---

## 4. 推荐重启方式：停止旧服务后，用 `systemd` 从头启动

最推荐的执行方式：

```bash
cd qwen-vllm-web-client
chmod +x ops/*.sh
sudo bash ops/restart_persistent.sh
```

这个脚本会按固定顺序执行：

1. 停掉现有 `systemd` 服务
2. 清理仍占用 `3000/8000` 的旧手工进程
3. 重新同步代码和 `systemd` 单元到目标目录
4. 保留并继续使用 `/etc/qwen-web/*.env`
5. 重新启动服务并打印状态

如果端口被“非本项目进程”占用，脚本会拒绝自动 `kill`，避免误杀其他服务；这时按提示手工处理后再重跑即可。

如果你现在怀疑服务状态已经混乱，或者之前用过：

```bash
node gateway.server.js
./start_gateway.sh
nohup node gateway.server.js ...
python -m vllm.entrypoints.openai.api_server ...
```

那么最稳妥的做法不是“在原进程上补救”，而是统一执行上面的脚本。

### 一键步骤

```bash
cd qwen-vllm-web-client
chmod +x ops/*.sh
sudo bash ops/restart_persistent.sh
```

### 脚本内部等价流程

1. 找到并停止旧的手工进程
2. 清理端口占用
3. 重新安装/同步 `systemd` 资产
4. 用 `/etc/qwen-web/*.env` 作为唯一配置来源
5. 通过 `systemd` 重新拉起服务

这样做的好处是：

- 退出 SSH 或关闭终端后服务不会丢
- 机器重启后服务能自动恢复
- 配置固定保存在 `/etc/qwen-web/*.env`
- 启停方式统一为 `start / stop / restart / status`
- 故障排查统一走 `systemctl` 和 `journalctl`

### 手工分步执行（仅在你想逐步排查时）

#### 第 1 步：停止旧进程

先检查 `3000` 和 `8000` 是否还被旧进程占用：

```bash
ss -ltnp | grep ':3000\|:8000'
```

如果看到了旧的 `node` 或 `python` 进程，先停止它们：

```bash
kill <旧网关PID>
kill <旧vllm PID>
```

如仍未退出，再强制停止：

```bash
kill -9 <PID>
```

如果之前已经装过 `systemd` 服务，也建议先停掉一次，确保干净：

```bash
sudo systemctl stop qwen-gateway.service qwen-vllm.service qwen-alert.timer
```

#### 第 2 步：重新安装/同步持久化启动资产

在仓库目录执行：

```bash
cd qwen-vllm-web-client
chmod +x ops/*.sh
sudo bash ops/install_systemd.sh
```

这个脚本会做几件事：

1. 把当前代码同步到 `/opt/qwen-web`
2. 把 `systemd` 单元安装到 `/etc/systemd/system/`
3. 如果配置文件还不存在，就初始化到 `/etc/qwen-web/`
4. 执行 `systemctl daemon-reload`
5. 执行 `systemctl enable ...`，保证开机自启

#### 第 3 步：确认持久化配置

重点检查下面两个文件：

```bash
sudo vim /etc/qwen-web/vllm.env
sudo vim /etc/qwen-web/gateway.env
```

至少要确认这些值是对的：

- `/etc/qwen-web/vllm.env` 的 `MODEL_PATH`
- `/etc/qwen-web/vllm.env` 的 `SERVED_MODEL_NAME`
- `/etc/qwen-web/vllm.env` 的 `PYTHON_BIN`（如 vLLM 在 venv / conda 中）
- `/etc/qwen-web/gateway.env` 的 `TEAM_API_KEY`
- `/etc/qwen-web/gateway.env` 的 `WEB_ROOT=/opt/qwen-web`
- `/etc/qwen-web/gateway.env` 的 `VLLM_BASE=http://127.0.0.1:8000`

如果你要启用告警，再检查：

```bash
sudo vim /etc/qwen-web/alert.env
```

#### 第 4 步：从头启动持久化服务

```bash
bash /opt/qwen-web/ops/start.sh
```

如果你只是修改了配置并想重新加载，也可以用：

```bash
bash /opt/qwen-web/ops/restart.sh
```

#### 第 5 步：验证重启结果

```bash
bash /opt/qwen-web/ops/status.sh
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/ready
curl -s http://127.0.0.1:3000/frontend/config
curl -s http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer <TEAM_API_KEY>"
```

只要这些检查正常，后续就不要再手工执行：

```bash
node gateway.server.js
./start_gateway.sh
python -m vllm.entrypoints.openai.api_server ...
```

统一交给 `systemd` 管理。

---

## 5. 从手工启动切换到持久化启动

如果你之前是直接在仓库目录里手工执行：

```bash
node gateway.server.js
python -m vllm.entrypoints.openai.api_server ...
```

建议切换到 `systemd` 托管，避免出现：

- 退出 SSH 后进程丢失
- 端口 `3000` / `8000` 被旧进程占用
- 环境变量只在当前 shell 生效，重启后丢失
- 无法统一使用 `start / stop / restart / status`

### 迁移步骤

1. 停掉旧的手工进程

```bash
ss -ltnp | grep ':3000\|:8000'
kill <旧网关PID>
kill <旧vllm PID>
```

如需强制停止：

```bash
kill -9 <PID>
```

2. 安装并启用 `systemd`

```bash
cd qwen-vllm-web-client
chmod +x ops/*.sh
sudo bash ops/install_systemd.sh
```

3. 编辑持久化环境变量文件

```bash
sudo vim /etc/qwen-web/vllm.env
sudo vim /etc/qwen-web/gateway.env
sudo vim /etc/qwen-web/alert.env
```

其中至少确认：

- `/etc/qwen-web/vllm.env` 中的 `MODEL_PATH`
- `/etc/qwen-web/vllm.env` 中的 `PYTHON_BIN`（默认 `python3`，独立环境建议写绝对路径）
- `/etc/qwen-web/gateway.env` 中的 `TEAM_API_KEY`
- `/etc/qwen-web/gateway.env` 中的 `VLLM_BASE=http://127.0.0.1:8000`

4. 通过 `systemd` 启动

```bash
bash /opt/qwen-web/ops/start.sh
```

5. 验证服务

```bash
bash /opt/qwen-web/ops/status.sh
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/ready
curl -s http://127.0.0.1:3000/frontend/config
curl -s http://127.0.0.1:3000/v1/models \
  -H "Authorization: Bearer <TEAM_API_KEY>"
```

验证通过后，后续就不要再手工执行 `node gateway.server.js` 了，统一交给 `systemd` 管理。

---

## 6. 服务启停与发布

### 推荐恢复命令

当你不确定当前机器上是否还残留了旧的 `nohup` / 手工 `node` / 手工 `python -m vllm ...` 进程时，优先执行：

```bash
cd qwen-vllm-web-client
sudo bash ops/restart_persistent.sh
```

这是默认恢复动作，适用于：

- 首次切换到持久化启动
- 手工调试后想回到受控状态
- 端口疑似被旧进程占用
- 修改代码后想按标准方式重新拉起
- 怀疑服务状态已经混乱

### 6.1 统一 ops 命令

| 命令                                | 用途                                               | 预期结果                                                        |
| ----------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `sudo bash ops/install_systemd.sh`  | 安装/同步 `/opt/qwen-web`、env 示例和 systemd 单元 | 不覆盖已有 `/etc/qwen-web/*.env`，启用服务单元。                |
| `bash /opt/qwen-web/ops/start.sh`   | 启动 vLLM、gateway、alert timer                    | 启动后自动调用 `status.sh` 展示状态。                           |
| `bash /opt/qwen-web/ops/stop.sh`    | 停止 alert timer、gateway、vLLM                    | 按依赖逆序停止，允许服务本来未运行。                            |
| `bash /opt/qwen-web/ops/restart.sh` | 重启 vLLM、gateway、alert timer                    | 重启后自动调用 `status.sh` 展示状态。                           |
| `bash /opt/qwen-web/ops/status.sh`  | 查看运行状态                                       | 展示模式、env 摘要、systemd、health、ready、metrics/upstreams。 |
| `sudo bash ops/rollout.sh`          | 单实例发布与回滚                                   | ready 失败时恢复上一版并重启 gateway。                          |
| `RAY_DRY_RUN=1 ./ops/ray_head.sh`   | Ray head 命令预检                                  | 打印 Ray head 启动命令，不真实启动。                            |
| `RAY_DRY_RUN=1 ./ops/ray_worker.sh` | Ray worker 命令预检                                | 打印 Ray worker 加入命令，不真实启动。                          |
| `RAY_DRY_RUN=1 ./ops/ray_stop.sh`   | Ray 停止命令预检                                   | 打印 `ray stop --force`，不真实执行。                           |

### 常用命令

```bash
bash /opt/qwen-web/ops/start.sh
bash /opt/qwen-web/ops/stop.sh
bash /opt/qwen-web/ops/restart.sh
bash /opt/qwen-web/ops/status.sh
```

### 单实例滚动发布（带回滚）

```bash
sudo bash /opt/qwen-web/ops/rollout.sh
```

`rollout.sh` 流程：

1. 预检上游就绪状态
2. 备份当前版本到 `/opt/qwen-web-backups/<timestamp>`
3. 同步新代码
4. 重启网关并探测 `/ready`
5. 失败自动回滚上一版本并重新拉起

---

## 7. API 契约与访问

统一入口（网关）：

- Web：`http://<host>:3000`
- API Base：`http://<host>:3000/v1`

首期开放接口：

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/agent/tasks`（P6 最小 Agent 事件流链路）

鉴权：

```http
Authorization: Bearer <TEAM_API_KEY>
```

接口访问边界：

- 静态页面与静态资源：匿名可访问
- `GET /health`：匿名可访问
- `GET /ready`：仅本机或合法 Bearer
- `GET /internal/metrics`：仅本机或合法 Bearer
- `GET /v1/models`、`POST /v1/chat/completions`：默认必须 Bearer；仅显式演示模式例外

网关标准错误：

| HTTP  | `error.type`                 | 触发条件                                         | 处理建议                                                           |
| ----- | ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `401` | `invalid_api_key`            | 缺少 Bearer、Key 错误，或 Web bypass 条件不完整  | 检查 `TEAM_API_KEY`、`TEAM_API_KEYS_EXTRA`、请求头与同源访问条件。 |
| `429` | `rate_limit_exceeded`        | 单客户端令牌桶耗尽                               | 降低请求速率或调整 `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST`。         |
| `429` | `concurrency_limit_exceeded` | 同一 client 并发超过 `MAX_CONCURRENT_PER_CLIENT` | 降低客户端并发或调高单客户端并发上限。                             |
| `429` | `server_busy`                | 全局 inflight 满、队列满或 `QUEUE_WAIT_MS` 超时  | 降低总并发、调大队列，或增加 replica upstream。                    |
| `502` | `upstream_unavailable`       | 所有候选 upstream 连接失败或不可达               | 检查 vLLM 进程、端口、防火墙和 `VLLM_BASE(S)`。                    |
| `504` | `upstream_timeout`           | upstream 请求超过 `UPSTREAM_TIMEOUT_MS`          | 检查模型负载、上下文长度、GPU 状态或调大超时。                     |

上游真实返回的 HTTP 响应会继续透传；只有网关鉴权/治理拒绝、连接失败或超时时，才由网关生成上述标准错误。

观测接口分工：

| Endpoint                | 访问边界          | 是否探测 upstream | 用途                                                                       |
| ----------------------- | ----------------- | ----------------- | -------------------------------------------------------------------------- |
| `GET /health`           | 匿名可访问        | 否                | 进程级健康检查，返回 `ok`、`status`、`uptimeMs`、`mode`、`upstreamCount`。 |
| `GET /ready`            | 本机或合法 Bearer | 是                | 服务级就绪检查，返回当前可用 upstream 与失败快照。                         |
| `GET /internal/metrics` | 本机或合法 Bearer | 否                | 内部排障指标，返回请求量、状态码、限流、队列、延迟与 per-upstream 状态。   |

`ops/status.sh` 会汇总运行模式、systemd 状态、raw health/ready/metrics，并优先解析 upstream 表格：`base`、`ready/circuit`、`attempts`、`success`、`failure`、`success rate`、`avg_ms`、`last error`。

支持双 Key 过渡（轮换窗口）：

- 主 Key：`TEAM_API_KEY`
- 过渡 Key 列表：`TEAM_API_KEYS_EXTRA`（逗号分隔）

---

## 8. 并发治理与安全基线

`gateway.env` 关键项（默认已适配 20-50 并发）：

- `RATE_LIMIT_RPS=5`
- `RATE_LIMIT_BURST=10`
- `MAX_CONCURRENT_PER_CLIENT=2`
- `MAX_GLOBAL_INFLIGHT=32`
- `MAX_QUEUE_SIZE=128`
- `QUEUE_WAIT_MS=20000`
- `UPSTREAM_TIMEOUT_MS=180000`

安全建议：

1. 仅对内开放 `3000`，限制普通用户直连 `8000`。
2. 生产禁用弱口令 Key（默认 `change-me-in-production` 会被拒绝启动）。
3. 如需本地调试弱口令，显式设置 `ALLOW_INSECURE_DEFAULT_KEY=true`。
4. 默认 `ENABLE_WEB_AUTH_BYPASS=false`；仅在受控内网演示场景下，才建议临时开启同源网页免填 Key。

---

## 9. 多模态 Web 体验

网关通过 `/frontend/config` 向前端暴露安全的多模态能力配置，前端按能力开关启用或禁用上传入口。上传文件先提交到 `POST /frontend/uploads` 做 MIME、大小和数量校验；网关不落盘、不持久化，只返回临时 data URL，最终仍由前端组装 OpenAI/Qwen-vLLM 兼容的 JSON 请求。

`gateway.env` 多模态配置：

| 配置项                       | 默认值  | 说明                                             |
| ---------------------------- | ------- | ------------------------------------------------ |
| `MULTIMODAL_IMAGE_ENABLED`   | `false` | 是否允许图片上传与 `image_url` content item。    |
| `MULTIMODAL_AUDIO_ENABLED`   | `false` | 是否允许音频上传与 `audio_url` content item。    |
| `MULTIMODAL_VIDEO_ENABLED`   | `false` | 是否允许视频上传与 `video_url` content item。    |
| `MULTIMODAL_FILE_ENABLED`    | `false` | 是否允许通用文件上传与 `file_url` content item。 |
| `MULTIMODAL_MAX_ATTACHMENTS` | `4`     | 单条消息最多附件数。                             |
| `MULTIMODAL_MAX_IMAGE_MB`    | `10`    | 单张图片大小限制。                               |
| `MULTIMODAL_MAX_AUDIO_MB`    | `25`    | 单个音频大小限制。                               |
| `MULTIMODAL_MAX_VIDEO_MB`    | `100`   | 单个视频大小限制。                               |
| `MULTIMODAL_MAX_FILE_MB`     | `25`    | 单个通用文件大小限制。                           |

发送格式示例：

```json
{
  "model": "qwen",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } },
        { "type": "text", "text": "请描述这张图" }
      ]
    }
  ],
  "stream": true
}
```

注意：文本模型或未启用能力时，上传入口会禁用；`/internal/metrics` 只记录上传数量、字节数和错误数，不记录 data URL、base64 内容或文件正文。

---

## 10. 部署模式闭环

本项目支持 `single`、`replica`、`ray` 三种运行模式。先用 `ops/status.sh` 判断当前模式，再用 `/health`、`/ready`、`/internal/metrics` 验收服务状态。

### 10.1 single：单机单 vLLM

适合一台机器和一个 vLLM 实例。

`gateway.env`：

```bash
VLLM_BASE=http://127.0.0.1:8000
VLLM_BASES=
```

启动与验收：

```bash
bash /opt/qwen-web/ops/start.sh
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/ready
curl -s http://127.0.0.1:3000/internal/metrics
bash /opt/qwen-web/ops/status.sh
```

验收通过标准：`/health` 返回 `ok=true`，`/ready` 返回 `ready=true`，`/internal/metrics` 有请求计数，`ops/status.sh` 显示 `mode: single`。

### 10.2 replica：双 upstream 吞吐与容灾

适合两台机器，模型单机能装下，用于提高吞吐和简单故障切换。两个 vLLM 实例必须使用相同 `--served-model-name`。

推荐拓扑：

```text
users -> b07b:qwen-gateway.service:3000
      -> b07b:vLLM:8000
      -> 7ace:vLLM:8000
```

`gateway.env`：

```bash
VLLM_BASES=http://node1:8000,http://node2:8000
```

验收步骤：

```bash
sudo systemctl restart qwen-gateway.service
bash /opt/qwen-web/ops/status.sh
curl -s http://127.0.0.1:3000/ready
curl -s http://127.0.0.1:3000/internal/metrics
```

`ops/status.sh` 的 upstream 表格应能看到两个 upstream 的 `ready/circuit`、`ok%`、`try`、`ok`、`fail`、`avg_ms`、`last_error`。停掉任意一个 upstream 后，另一个应继续服务；失败 upstream 会短暂进入 circuit。恢复 upstream 后，后续请求应让它重新参与服务并更新成功率。

### 10.3 ray：两机共同承载一个模型

适合模型单机装不下，需要两台机器共同承载一个 vLLM API server。Ray 模式下只暴露一个 vLLM OpenAI API，gateway 仍使用单 upstream。

`ray.env` 关键项：

```bash
RAY_HEAD_IP=192.168.100.1
RAY_WORKER_IP=192.168.100.2
RAY_PORT=6379
RAY_MIN_WORKER_PORT=10002
RAY_MAX_WORKER_PORT=10100
```

`vllm.env` 关键项：

```bash
EXTRA_VLLM_ARGS=--distributed-executor-backend ray --pipeline-parallel-size 2
```

`gateway.env` 保持单 upstream：

```bash
VLLM_BASE=http://127.0.0.1:8000
VLLM_BASES=
```

启动顺序：

```bash
# head node
bash /opt/qwen-web/ops/ray_head.sh

# worker node
bash /opt/qwen-web/ops/ray_worker.sh

# API entry node
sudo systemctl restart qwen-vllm.service
sudo systemctl restart qwen-gateway.service
bash /opt/qwen-web/ops/status.sh
```

#### Ray dry-run validation

真实启动前，先验证脚本、端口和命令展开：

```bash
bash -n ops/status.sh ops/ray_head.sh ops/ray_worker.sh ops/ray_stop.sh ops/install_systemd.sh
RAY_DRY_RUN=1 QWEN_WEB_ENV_DIR=deploy/env ./ops/ray_head.sh
RAY_DRY_RUN=1 QWEN_WEB_ENV_DIR=deploy/env ./ops/ray_worker.sh
RAY_DRY_RUN=1 ./ops/ray_stop.sh
```

#### Ray failure recovery

Ray 异常时不要先反复重启 gateway。按顺序恢复：

```bash
bash /opt/qwen-web/ops/ray_stop.sh
# head node: bash /opt/qwen-web/ops/ray_head.sh
# worker node: bash /opt/qwen-web/ops/ray_worker.sh
sudo systemctl restart qwen-vllm.service
sudo systemctl restart qwen-gateway.service
bash /opt/qwen-web/ops/status.sh
```

日志定位：

```bash
journalctl -u qwen-vllm.service -n 200 --no-pager
journalctl -u qwen-gateway.service -n 200 --no-pager
ray status
```

### 10.4 Recommendation

- 模型能放进单机时，优先 `single` 或 `replica`。
- 需要吞吐或简单容灾时，优先 `replica`。
- 只有模型单机放不下时，再使用 `ray`。

---

## 11. 测试与 CI

本地最小验证命令：

```powershell
npm.cmd test
node --check gateway.server.js
git diff --check
```

CI 使用 Windows runner，覆盖：

- `npm ci`：按 `package-lock.json` 安装依赖。
- `npm test`：运行 Vitest 覆盖网关安全、upstream、health、queue/rate-limit、frontend、multipart 多模态和 Agent 事件流。
- `node --check gateway.server.js`：检查网关语法。
- best-effort `bash -n ops/*.sh start_gateway.sh`：仅在 Bash 可用时检查 shell 脚本语法；Windows runner 上 Bash 不可用或 WSL stub 不可执行时自动跳过。

CI 不启动 vLLM、Ray、systemd、GPU 服务，也不验证真实双机网络；这些保留给部署窗口和 `ops/status.sh` / Ray dry-run runbook。

---

## 12. 运维与恢复手册

所有故障先执行：

```bash
bash /opt/qwen-web/ops/status.sh
journalctl -u qwen-gateway.service -n 200 --no-pager
journalctl -u qwen-vllm.service -n 200 --no-pager
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:3000/ready
curl -s http://127.0.0.1:3000/internal/metrics
```

### 12.1 gateway 起不来

- 现象：Web UI 无法访问，`/health` 失败，`qwen-gateway.service` inactive 或 failed。
- 检查命令：`systemctl status qwen-gateway.service --no-pager`；`journalctl -u qwen-gateway.service -n 200 --no-pager`；`ss -ltnp | grep ':3000'`；`node --check /opt/qwen-web/gateway.server.js`。
- 可能原因：`/etc/qwen-web/gateway.env` 配置错误；端口 3000 被占用；弱 `TEAM_API_KEY` 被拒绝；代码语法错误；Node 环境异常。
- 恢复命令：修正 `gateway.env` 后执行 `sudo systemctl restart qwen-gateway.service`，再执行 `bash /opt/qwen-web/ops/status.sh`。
- 回滚方式：恢复上一份 `gateway.env` 或运行 `sudo bash /opt/qwen-web/ops/rollout.sh` 回滚发布资产。

### 12.2 vLLM 起不来

- 现象：gateway 可启动但 `/ready` 失败，`qwen-vllm.service` inactive 或 failed。
- 检查命令：`systemctl status qwen-vllm.service --no-pager`；`journalctl -u qwen-vllm.service -n 200 --no-pager`；`cat /etc/qwen-web/vllm.env`；`nvidia-smi`。
- 可能原因：`MODEL_PATH` 不存在；Python/vLLM 环境错误；GPU 不可见；显存不足；`EXTRA_VLLM_ARGS` 参数错误。
- 恢复命令：修正 `vllm.env`、释放显存或降低模型参数后执行 `sudo systemctl restart qwen-vllm.service`。
- 回滚方式：恢复上一份 `vllm.env`，或切回 `single/replica` 已验证配置后重启 vLLM 与 gateway。

### 12.3 upstream 全部 unavailable

- 现象：`/health` 正常但 `/ready` 返回 503，metrics 中所有 upstream 失败或 circuit。
- 检查命令：`curl -s http://127.0.0.1:3000/ready`；`curl -s http://127.0.0.1:3000/internal/metrics`；检查 `VLLM_BASE`/`VLLM_BASES`；逐个 `curl http://upstream:8000/v1/models`。
- 可能原因：所有 vLLM 实例停止；upstream 地址配置错误；端口或防火墙不通；upstream 超时。
- 恢复命令：恢复至少一个 vLLM upstream，修正 `gateway.env`，执行 `sudo systemctl restart qwen-gateway.service`。
- 回滚方式：将 `VLLM_BASE(S)` 回滚到最近可用 upstream，或切回单机 `VLLM_BASE=http://127.0.0.1:8000`。

### 12.4 某个 upstream 进入 circuit

- 现象：服务仍可用，但 `ops/status.sh` upstream 表中某个节点显示 `circuit`、失败数增加或成功率下降。
- 检查命令：`bash /opt/qwen-web/ops/status.sh`；`curl -s http://127.0.0.1:3000/internal/metrics`；在对应节点检查 `qwen-vllm.service` 日志。
- 可能原因：该节点 vLLM 重启、超时、OOM、网络抖动或端口不可达。
- 恢复命令：修复该节点 vLLM 后发起新请求，观察 metrics 中 `ready/circuit` 与成功率恢复。
- 回滚方式：临时从 `VLLM_BASES` 移除该 upstream，重启 gateway，待节点稳定后再加入。

### 12.5 /health 正常但 /ready 失败

- 现象：gateway 进程健康，但服务不可对模型请求提供就绪状态。
- 检查命令：`curl -s /health`；`curl -s /ready`；`journalctl -u qwen-vllm.service -n 200 --no-pager`；`bash /opt/qwen-web/ops/status.sh`。
- 可能原因：gateway 正常、upstream 不可达；vLLM 未启动；Ray/vLLM 后端异常；upstream 全部 circuit。
- 恢复命令：按 upstream 或 vLLM runbook 恢复后执行 `sudo systemctl restart qwen-gateway.service`。
- 回滚方式：恢复最近可用 upstream 配置，或回退 `EXTRA_VLLM_ARGS` 后重启 vLLM/gateway。

### 12.6 Ray worker 掉线

- 现象：Ray 模式下 vLLM 日志报 worker lost，吞吐下降或 `/ready` 失败。
- 检查命令：head 节点执行 `ray status`；worker 节点执行 `ray status`；检查 `/etc/qwen-web/ray.env`；检查固定端口和网络连通性。
- 可能原因：worker 进程退出；worker IP 配错；Ray 端口被防火墙阻断；GPU/驱动异常。
- 恢复命令：worker 节点执行 `bash /opt/qwen-web/ops/ray_stop.sh` 后重新 `bash /opt/qwen-web/ops/ray_worker.sh`，入口节点重启 vLLM/gateway。
- 回滚方式：停止 Ray，恢复非 Ray `vllm.env`，切回单机或 replica 模式。

### 12.7 Ray head 异常

- 现象：worker 无法连接 head，Ray dashboard/status 不可用，vLLM Ray backend 启动失败。
- 检查命令：head 节点执行 `ray status`；检查 `RAY_HEAD_IP`/`RAY_PORT`；检查 `ops/ray_head.sh` dry-run 输出。
- 可能原因：head 进程退出；head IP 配错；端口冲突；Ray 临时目录损坏。
- 恢复命令：先所有节点执行 `ray_stop.sh`，再 head 执行 `ray_head.sh`，worker 执行 `ray_worker.sh`，最后重启 vLLM/gateway。
- 回滚方式：恢复上一份 `ray.env`/`vllm.env`，或切回 replica 模式。

### 12.8 模型 OOM

- 现象：vLLM 日志出现 OOM、CUDA allocation failed，服务重启或 `/ready` 间歇失败。
- 检查命令：`journalctl -u qwen-vllm.service -n 200 --no-pager`；`nvidia-smi`；检查 `MAX_MODEL_LEN`、`GPU_MEMORY_UTILIZATION`、队列和并发。
- 可能原因：上下文过长；并发过高；显存碎片；模型超出单机容量。
- 恢复命令：降低 `MAX_MODEL_LEN`、`MAX_NUM_BATCHED_TOKENS`、`GPU_MEMORY_UTILIZATION` 或网关并发，重启 vLLM。
- 回滚方式：恢复上一份 `vllm.env`，或切换到 Ray/replica 的已验证配置。

### 12.9 请求排队过多

- 现象：429 增多，`/internal/metrics` 中 queue 连续活跃、inflight 接近上限。
- 检查命令：`curl -s http://127.0.0.1:3000/internal/metrics`；查看 `totalRateLimited`、`queue.currentContinuousMs`、`currentInFlight`。
- 可能原因：请求突增；单客户端并发过高；upstream 慢；队列或全局 inflight 配置过低。
- 恢复命令：降低客户端并发，调大 `MAX_GLOBAL_INFLIGHT`/`MAX_QUEUE_SIZE` 或增加 replica upstream。
- 回滚方式：恢复上一份 `gateway.env`，或临时回退到更保守限流配置。

### 12.10 认证失败

- 现象：API 返回 401 `invalid_api_key`，Web bypass 场景也无法访问。
- 检查命令：检查请求 `Authorization: Bearer ...`；检查 `TEAM_API_KEY`/`TEAM_API_KEYS_EXTRA`；检查 `ENABLE_WEB_AUTH_BYPASS` 和同源请求头。
- 可能原因：Key 错误或轮换未同步；Bearer 缺失；默认弱 Key 被启动校验拒绝；Web bypass 条件不完整。
- 恢复命令：修正客户端 Key 或更新 `gateway.env` 后执行 `sudo systemctl restart qwen-gateway.service`。
- 回滚方式：在轮换窗口内恢复旧 Key 到 `TEAM_API_KEYS_EXTRA`，确认后再移除。

### 12.11 Web UI 打不开

- 现象：浏览器无法打开页面、静态资源 404、或 `/frontend/config` 失败。
- 检查命令：`curl -I http://127.0.0.1:3000/`；`curl -s http://127.0.0.1:3000/frontend/config`；检查 `WEB_ROOT`；检查 gateway 日志。
- 可能原因：gateway 未启动；端口未开放；`WEB_ROOT` 指向错误；静态文件未同步；浏览器访问了错误主机。
- 恢复命令：执行 `sudo bash /opt/qwen-web/ops/install_systemd.sh` 同步资产，然后 `sudo systemctl restart qwen-gateway.service`。
- 回滚方式：恢复上一版静态资产或执行 `sudo bash /opt/qwen-web/ops/rollout.sh`。
