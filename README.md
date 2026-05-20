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

## 3. 服务启停与发布

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

## 4. API 契约与访问

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

## 5. 并发治理与安全基线

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

## 6. 监控与告警

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

## 7. 日志与排障

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

## 8. Key 轮换标准流程

1. 新 Key 写入 `TEAM_API_KEYS_EXTRA`（保留旧主 Key）
2. 客户端逐步切新 Key
3. 切换 `TEAM_API_KEY` 为新值
4. 清空旧 Key（从 `TEAM_API_KEYS_EXTRA` 移除）
5. `sudo systemctl restart qwen-gateway.service`

---

## 9. 本地开发

```bash
npm install
npm run lint
npm run test
```
