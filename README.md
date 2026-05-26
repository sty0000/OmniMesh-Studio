# Qwen vLLM Web Client（运维增强版）

> 当前唯一推荐的长期运行方式：用 `systemd` 持久化托管，并通过 `sudo bash ops/restart_persistent.sh` 完成“停止旧进程 → 同步服务资产 → 从头重启”。不要继续使用 `node gateway.server.js` 或 `nohup ...` 作为长期运行方案。

本仓库现在提供一套可长期维护的内网部署方案：

- `qwen-vllm.service`：模型推理服务（vLLM）
- `qwen-gateway.service`：统一接入层（Web 静态托管 + OpenAI 兼容 API）
- `qwen-alert.timer`：每分钟采集指标并按阈值告警

> 目标：单机单实例（20-50 并发）稳定运行，具备自愈、可观测、可回滚能力。

---

## 1. 目录与约定

推荐线上目录：

- 代码：`/opt/qwen-web`
- 配置：`/etc/qwen-web/*.env`
- 日志：`/var/log/qwen-web/*.log`

仓库内对应资产：

- systemd 模板：`deploy/systemd/`
- 环境变量模板：`deploy/env/`
- 日志轮转模板：`deploy/logrotate/qwen-web`
- 运维脚本：`ops/`

---

## 2. 首次安装（systemd）

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

## 3. 推荐重启方式：停止旧服务后，用 `systemd` 从头启动

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

## 4. 从手工启动切换到持久化启动

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

## 5. 服务启停与发布

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

## 6. API 契约与访问

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

支持双 Key 过渡（轮换窗口）：

- 主 Key：`TEAM_API_KEY`
- 过渡 Key 列表：`TEAM_API_KEYS_EXTRA`（逗号分隔）

---

## 7. 并发治理与安全基线

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

## 8. Dual-Node Deployment Modes

This project supports two dual-node patterns. Choose the one that matches the model size and service goal.

### 8.1 More throughput: replica mode with gateway round-robin

Use this when the current model fits on one machine and you want higher throughput or simple failover.

Recommended topology:

```text
users -> b07b:qwen-gateway.service:3000
      -> b07b:vLLM:8000
      -> 7ace:vLLM:8000
```

Steps:

1. Run the same vLLM model service on both `b07b` and `7ace`.
2. Set multiple upstreams in `/etc/qwen-web/gateway.env` on `b07b`:

```bash
VLLM_BASES=http://127.0.0.1:8000,http://192.168.100.2:8000
```

When `VLLM_BASES` is set, it overrides the single-upstream `VLLM_BASE`. The gateway round-robins requests across upstreams and temporarily skips an upstream when connection attempts fail or time out.

3. Restart the gateway:

```bash
sudo systemctl restart qwen-gateway.service
curl -s http://127.0.0.1:3000/ready
```

Keep the same `--served-model-name` on both replicas so the frontend and API clients see a consistent model name.

### 8.2 Larger-than-one-node model: vLLM + Ray model parallelism

Use this when one machine cannot hold the model and both machines must serve one vLLM instance together.

Recommended topology:

```text
users -> b07b:qwen-gateway.service:3000
      -> b07b:vLLM:8000
      -> Ray cluster: b07b + 7ace
```

Steps:

1. Keep the dual-node data network fixed, for example:
   - `b07b enp1s0f0np0 = 192.168.100.1/24`
   - `7ace enp1s0f0np0 = 192.168.100.2/24`
2. Start a Ray head on `b07b` and a Ray worker on `7ace`.
3. Run only one API server on `b07b` via `qwen-vllm.service`.
4. Add distributed vLLM arguments in `/etc/qwen-web/vllm.env`. Prefer pipeline parallelism first on two 1-GPU nodes:

```bash
EXTRA_VLLM_ARGS=--distributed-executor-backend ray --pipeline-parallel-size 2
```

Or use tensor parallelism when the model and network path benefit from it:

```bash
EXTRA_VLLM_ARGS=--distributed-executor-backend ray --tensor-parallel-size 2
```

5. Keep the gateway on one upstream:

```bash
VLLM_BASE=http://127.0.0.1:8000
VLLM_BASES=
```

6. Restart services:

```bash
sudo systemctl restart qwen-vllm.service qwen-gateway.service
```

### 8.3 Recommendation

- If the model already fits on one Spark, use `VLLM_BASES` replica mode first.
- If the model does not fit on one Spark, use Ray + vLLM model parallelism.
- Before performance tuning, verify the data path with `OpenMPI + nccl-tests` and bind communication to `enp1s0f0np0`.
