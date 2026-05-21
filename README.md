# Qwen vLLM Web Client（运维增强版）

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

---

## 3. 从手工启动切换到持久化启动

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

## 4. 服务启停与发布

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

## 5. API 契约与访问

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

## 6. 并发治理与安全基线

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

## 7. 监控与告警

### 运行时接口

- 健康：`GET /health`（网关存活，匿名）
- 就绪：`GET /ready`（上游可用，仅本机或合法 Bearer）
- 指标：`GET /internal/metrics`（仅本机或合法 Bearer）
- 前端配置：`GET /frontend/config`（匿名最小只读配置）

指标包含：

- `totalApi5xx` / `totalUpstreamTimeout`
- `rates.api5xxRatio` / `rates.api429Ratio`
- `latencyMs.avg` / `latencyMs.p95`
- `queue.currentContinuousMs` / `queue.peakSinceBoot`

Web 默认访问策略：

- 前端默认需要显式填写 `API Key`
- 仅当服务端显式开启 `ENABLE_WEB_AUTH_BYPASS=true` 时，同源网页才允许免填 Key 访问已开放接口
- 前端首屏先读取 `/frontend/config`，仅拿最小展示配置；只有显式填写 `API Key` 后，才会请求 `/v1/models` 拉取实时模型信息
- `POST /v1/agent/tasks` 当前仅支持显式 Bearer，返回 SSE 事件流，用于最小单 Agent 任务链路验证

前端当前采用：

- 静态 HTML 入口：`index.html`
- 原生 ES Modules：`frontend/app.js`
- 职责拆分模块：`frontend/state.js`、`frontend/api.js`、`frontend/rendering.js`、`frontend/storage.js`
- 无构建工具，继续由网关直接托管静态文件

### 告警定时器

启用后每分钟执行一次 `ops/alert_check.sh`：

```bash
sudo systemctl enable --now qwen-alert.timer
```

`alert.env` 默认阈值：

- `THRESHOLD_API_429_RATIO=0.05`
- `THRESHOLD_API_5XX_RATIO=0.01`
- `THRESHOLD_QUEUE_CONTINUOUS_MS=300000`
- `HEALTH_FAIL_THRESHOLD=3`

---

## 8. 日志与排障

### journald

```bash
sudo journalctl -u qwen-vllm.service -f
sudo journalctl -u qwen-gateway.service -f
```

### logrotate

将模板安装到系统：

```bash
sudo cp /opt/qwen-web/deploy/logrotate/qwen-web /etc/logrotate.d/qwen-web
```

---

## 9. Key 轮换标准流程

1. 新 Key 写入 `TEAM_API_KEYS_EXTRA`（保留旧主 Key）
2. 客户端逐步切新 Key
3. 切换 `TEAM_API_KEY` 为新值
4. 清空旧 Key（从 `TEAM_API_KEYS_EXTRA` 移除）
5. `sudo systemctl restart qwen-gateway.service`

---

## 10. 本地开发

### 本地临时启动（仅开发调试）

如果你只是本机临时调试，可继续使用 shell 环境变量方式：

```bash
export TEAM_API_KEY='<your-team-key>'
export GATEWAY_HOST=0.0.0.0
export GATEWAY_PORT=3000
export WEB_ROOT="$(pwd)"
export VLLM_BASE='http://127.0.0.1:8000'
node gateway.server.js
```

但这种方式不适合长期运行，也不会在机器重启后自动恢复。线上环境请优先使用上面的 `systemd` 持久化启动方式。

```bash
npm install
npm run lint
npm run test
```
