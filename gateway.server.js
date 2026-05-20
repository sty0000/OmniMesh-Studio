const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline, Readable } = require('node:stream');
const { URL } = require('node:url');
const { createAgentService } = require('./agent.service.js');
const { encodeSseData } = require('./agent.protocol.js');

const INSECURE_KEY_VALUES = new Set(['', 'change-me-in-production', 'changeme', 'default']);
const WEB_BYPASS_PATHS = new Set(['GET:/v1/models', 'POST:/v1/chat/completions']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const now = () => Date.now();

const createGatewayConfig = (env = process.env) => ({
  host: env.GATEWAY_HOST || '0.0.0.0',
  port: Number(env.GATEWAY_PORT || 3000),
  webRoot: path.resolve(env.WEB_ROOT || __dirname),
  vllmBase: env.VLLM_BASE || 'http://127.0.0.1:8000',
  teamApiKey: env.TEAM_API_KEY || '',
  teamApiKeysExtra: String(env.TEAM_API_KEYS_EXTRA || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
  rateLimitRps: Number(env.RATE_LIMIT_RPS || 5),
  rateLimitBurst: Number(env.RATE_LIMIT_BURST || 10),
  maxConcurrentPerClient: Number(env.MAX_CONCURRENT_PER_CLIENT || 2),
  maxGlobalInflight: Number(env.MAX_GLOBAL_INFLIGHT || 32),
  maxQueueSize: Number(env.MAX_QUEUE_SIZE || 128),
  queueWaitMs: Number(env.QUEUE_WAIT_MS || 20000),
  upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS || 180000),
  metricWindowSize: Number(env.METRIC_WINDOW_SIZE || 400),
  staticCacheSeconds: Number(env.STATIC_CACHE_SECONDS || 300),
  enableWebAuthBypass: String(env.ENABLE_WEB_AUTH_BYPASS || 'false') === 'true',
  allowInsecureDefaultKey: String(env.ALLOW_INSECURE_DEFAULT_KEY || 'false') === 'true',
  enableAgentTasks: String(env.ENABLE_AGENT_TASKS || 'true') === 'true',
});

const createInitialMetrics = () => ({
  startedAt: Date.now(),
  totalRequests: 0,
  totalApiRequests: 0,
  totalRateLimited: 0,
  totalRejectedAuth: 0,
  totalQueueTimeout: 0,
  currentInFlight: 0,
  peakInFlight: 0,
  peakQueueSize: 0,
  totalApiSuccess2xx: 0,
  totalApi4xx: 0,
  totalApi5xx: 0,
  totalUpstreamTimeout: 0,
  totalUpstreamUnavailable: 0,
  queueActiveMsTotal: 0,
  queueLastBecameNonZeroAt: null,
  queuePeakSinceBoot: 0,
});

const hasSecureTeamKey = (config) => {
  if (config.allowInsecureDefaultKey) return true;
  if (!config.teamApiKey) return true;
  return !INSECURE_KEY_VALUES.has(config.teamApiKey.trim().toLowerCase());
};

const validateStartupSecurity = (config) => {
  if (!hasSecureTeamKey(config)) {
    throw new Error(
      '[Gateway] Refusing to start with weak TEAM_API_KEY. Set a strong key or set ALLOW_INSECURE_DEFAULT_KEY=true for dev only.',
    );
  }
};

const isLoopbackAddress = (address) => LOOPBACK_ADDRESSES.has(String(address || '').trim());

const getClientIp = (req) => {
  const xfwd = req.headers['x-forwarded-for'];
  if (xfwd && typeof xfwd === 'string') {
    const first = xfwd.split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || 'unknown';
};

const getClientKey = (req) => {
  const auth = req.headers.authorization || '';
  const normalized = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return normalized || 'anonymous';
};

const createGatewayServer = ({
  config = createGatewayConfig(),
  fetchImpl = global.fetch,
  getSocketAddress = (req) => req.socket.remoteAddress || 'unknown',
} = {}) => {
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required to create the gateway server.');
  }

  const metrics = createInitialMetrics();
  const agentService = createAgentService();
  const rateBuckets = new Map();
  const clientInflight = new Map();
  const waitQueue = [];
  const requestLatencyRing = [];

  const recordApiOutcome = (statusCode) => {
    if (statusCode >= 200 && statusCode < 300) {
      metrics.totalApiSuccess2xx += 1;
    } else if (statusCode >= 400 && statusCode < 500) {
      metrics.totalApi4xx += 1;
    } else if (statusCode >= 500) {
      metrics.totalApi5xx += 1;
    }
  };

  const addRequestLatency = (valueMs) => {
    if (!Number.isFinite(valueMs) || valueMs < 0) return;
    requestLatencyRing.push(Math.round(valueMs));
    if (requestLatencyRing.length > config.metricWindowSize) {
      requestLatencyRing.shift();
    }
  };

  const percentileFromRing = (source, p) => {
    if (!source.length) return 0;
    const sorted = [...source].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
  };

  const writeJson = (res, statusCode, payload, extraHeaders = {}) => {
    const body = JSON.stringify(payload);
    recordApiOutcome(statusCode);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders,
    });
    res.end(body);
  };

  const openAiError = (res, statusCode, type, message, extra = {}) => {
    writeJson(
      res,
      statusCode,
      {
        error: {
          type,
          message,
          ...extra,
        },
      },
      statusCode === 429 ? { 'Retry-After': '3' } : {},
    );
  };

  const isValidTeamBearer = (authHeader, { allowWhenUnconfigured = true } = {}) => {
    if (!config.teamApiKey) return allowWhenUnconfigured;
    if (!authHeader) return false;
    const prefix = 'Bearer ';
    if (!authHeader.startsWith(prefix)) return false;
    const token = authHeader.slice(prefix.length).trim();
    if (token.length === 0) return false;
    return token === config.teamApiKey || config.teamApiKeysExtra.includes(token);
  };

  const canBypassWithWebContext = (req, pathname) => {
    if (!config.enableWebAuthBypass || !config.teamApiKey) return false;
    if (req.headers.authorization) return false;

    const routeKey = `${req.method}:${pathname}`;
    if (!WEB_BYPASS_PATHS.has(routeKey)) return false;

    const source = String(req.headers['x-client-source'] || '').toLowerCase();
    if (source !== 'web') return false;

    const origin = String(req.headers.origin || '');
    const referer = String(req.headers.referer || '');
    const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    const host = req.headers.host || '';
    const expectedOrigin = host ? `http://${host}` : '';

    if (!expectedOrigin) return false;
    if (origin !== expectedOrigin) return false;
    if (!referer.startsWith(expectedOrigin)) return false;
    if (secFetchSite !== 'same-origin') return false;

    return true;
  };

  const isMetricsAuthorized = (req) => {
    if (isLoopbackAddress(getSocketAddress(req))) {
      return true;
    }
    return isValidTeamBearer(req.headers.authorization || '', { allowWhenUnconfigured: false });
  };

  const isReadyAuthorized = (req) => {
    if (isLoopbackAddress(getSocketAddress(req))) {
      return true;
    }
    return isValidTeamBearer(req.headers.authorization || '', { allowWhenUnconfigured: false });
  };

  const takeRateToken = (id) => {
    const current = now();
    const existing = rateBuckets.get(id) || {
      tokens: config.rateLimitBurst,
      lastRefillMs: current,
    };

    const elapsedSec = Math.max(0, (current - existing.lastRefillMs) / 1000);
    const refill = elapsedSec * config.rateLimitRps;
    existing.tokens = Math.min(config.rateLimitBurst, existing.tokens + refill);
    existing.lastRefillMs = current;

    if (existing.tokens < 1) {
      rateBuckets.set(id, existing);
      return false;
    }

    existing.tokens -= 1;
    rateBuckets.set(id, existing);
    return true;
  };

  const getClientInflight = (id) => clientInflight.get(id) || 0;

  const incClientInflight = (id) => {
    const next = getClientInflight(id) + 1;
    clientInflight.set(id, next);
    return next;
  };

  const decClientInflight = (id) => {
    const next = Math.max(0, getClientInflight(id) - 1);
    if (next === 0) {
      clientInflight.delete(id);
    } else {
      clientInflight.set(id, next);
    }
  };

  const trackQueueDepth = () => {
    metrics.queuePeakSinceBoot = Math.max(metrics.queuePeakSinceBoot, waitQueue.length);
    if (waitQueue.length > 0 && metrics.queueLastBecameNonZeroAt === null) {
      metrics.queueLastBecameNonZeroAt = now();
    }
    if (waitQueue.length === 0 && metrics.queueLastBecameNonZeroAt !== null) {
      metrics.queueActiveMsTotal += now() - metrics.queueLastBecameNonZeroAt;
      metrics.queueLastBecameNonZeroAt = null;
    }
  };

  const tryAcquireGlobalSlot = () => {
    if (metrics.currentInFlight >= config.maxGlobalInflight) return false;
    metrics.currentInFlight += 1;
    metrics.peakInFlight = Math.max(metrics.peakInFlight, metrics.currentInFlight);
    return true;
  };

  const releaseGlobalSlot = () => {
    metrics.currentInFlight = Math.max(0, metrics.currentInFlight - 1);
    while (waitQueue.length > 0 && metrics.currentInFlight < config.maxGlobalInflight) {
      const waiter = waitQueue.shift();
      trackQueueDepth();
      if (!waiter || waiter.resolved) continue;
      waiter.resolved = true;
      clearTimeout(waiter.timeoutId);
      metrics.currentInFlight += 1;
      metrics.peakInFlight = Math.max(metrics.peakInFlight, metrics.currentInFlight);
      waiter.resolve(true);
    }
  };

  const acquireGlobalSlotWithQueue = () => {
    if (tryAcquireGlobalSlot()) {
      return Promise.resolve(true);
    }

    if (waitQueue.length >= config.maxQueueSize) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const waiter = {
        resolve,
        resolved: false,
        timeoutId: null,
      };

      waiter.timeoutId = setTimeout(() => {
        if (waiter.resolved) return;
        waiter.resolved = true;
        metrics.totalQueueTimeout += 1;
        resolve(false);
      }, config.queueWaitMs);

      waitQueue.push(waiter);
      metrics.peakQueueSize = Math.max(metrics.peakQueueSize, waitQueue.length);
      trackQueueDepth();
    });
  };

  const readRequestBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };

  const buildForwardHeaders = (req, authHeaderToUse, hasBody) => {
    const headers = {
      Accept: req.headers.accept || '*/*',
      'User-Agent': req.headers['user-agent'] || 'qwen-web-gateway/1.0',
      'X-Forwarded-For': getClientIp(req),
      'X-Forwarded-Proto': 'http',
      'X-Client-Source': req.headers['x-client-source'] || 'api',
    };

    if (authHeaderToUse) {
      headers.Authorization = authHeaderToUse;
    }

    if (hasBody) {
      headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    }

    return headers;
  };

  const pipeFetchResponse = (upstream, res) => {
    const headers = {};
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding') {
        return;
      }
      headers[key] = value;
    });

    recordApiOutcome(upstream.status);
    res.writeHead(upstream.status, headers);
    if (!upstream.body) {
      res.end();
      return;
    }

    pipeline(Readable.fromWeb(upstream.body), res, (err) => {
      if (err && !res.headersSent) {
        openAiError(res, 502, 'gateway_proxy_error', 'Upstream stream failed.');
      }
    });
  };

  const handleProxyApi = async (req, res, pathname) => {
    metrics.totalApiRequests += 1;
    const requestStartMs = now();
    const ip = getClientIp(req);
    const keyId = getClientKey(req);
    const clientId = `${ip}:${keyId}`;

    const incomingAuth = req.headers.authorization || '';
    let authToUse = incomingAuth;
    const authValid = isValidTeamBearer(incomingAuth);
    const bypassAllowed = !authValid && canBypassWithWebContext(req, pathname);

    if (!authValid && !bypassAllowed) {
      metrics.totalRejectedAuth += 1;
      openAiError(
        res,
        401,
        'invalid_api_key',
        'Missing or invalid API key. Use Authorization: Bearer <TEAM_KEY>.',
      );
      addRequestLatency(now() - requestStartMs);
      return;
    }

    if (!authValid && bypassAllowed) {
      authToUse = `Bearer ${config.teamApiKey}`;
    }

    if (!takeRateToken(clientId)) {
      metrics.totalRateLimited += 1;
      openAiError(res, 429, 'rate_limit_exceeded', 'Too many requests. Please retry shortly.');
      addRequestLatency(now() - requestStartMs);
      return;
    }

    if (getClientInflight(clientId) >= config.maxConcurrentPerClient) {
      openAiError(
        res,
        429,
        'concurrency_limit_exceeded',
        `Too many concurrent requests for this client. Limit=${config.maxConcurrentPerClient}.`,
      );
      addRequestLatency(now() - requestStartMs);
      return;
    }

    const gotGlobalSlot = await acquireGlobalSlotWithQueue();
    if (!gotGlobalSlot) {
      openAiError(
        res,
        429,
        'server_busy',
        'Server is busy. Queue timeout exceeded, please retry.',
      );
      addRequestLatency(now() - requestStartMs);
      return;
    }

    incClientInflight(clientId);

    try {
      const query = req.url.includes('?') ? `?${req.url.split('?')[1]}` : '';
      const upstreamUrl = new URL(pathname + query, config.vllmBase);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const headers = buildForwardHeaders(req, authToUse, hasBody);

      let body;
      if (hasBody) {
        body = await readRequestBody(req);
      }

      const upstream = await fetchImpl(upstreamUrl, {
        method: req.method,
        headers,
        body,
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
        duplex: hasBody ? 'half' : undefined,
      });

      pipeFetchResponse(upstream, res);
    } catch (err) {
      if (err && err.name === 'TimeoutError') {
        metrics.totalUpstreamTimeout += 1;
        openAiError(
          res,
          504,
          'upstream_timeout',
          `Upstream timeout after ${config.upstreamTimeoutMs} ms.`,
        );
      } else {
        metrics.totalUpstreamUnavailable += 1;
        openAiError(
          res,
          502,
          'upstream_unavailable',
          (err && err.message) || 'Failed to reach vLLM upstream.',
        );
      }
    } finally {
      decClientInflight(clientId);
      releaseGlobalSlot();
      addRequestLatency(now() - requestStartMs);
    }
  };

  const getSafeStaticPath = (urlPath) => {
    const cleanPath = decodeURIComponent(urlPath.split('?')[0]);
    const requested = cleanPath === '/' ? '/index.html' : cleanPath;
    const resolved = path.resolve(config.webRoot, `.${requested}`);
    if (!resolved.startsWith(config.webRoot)) {
      return null;
    }
    return resolved;
  };

  const serveStatic = async (req, res, pathname) => {
    const filePath = getSafeStaticPath(pathname);
    if (!filePath) {
      writeJson(res, 403, { error: 'Forbidden path.' });
      return;
    }

    try {
      const stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        writeJson(res, 404, { error: 'Not found.' });
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const etag = `W/"${stat.size}-${stat.mtimeMs}"`;

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': `public, max-age=${config.staticCacheSeconds}`,
        ETag: etag,
        'Content-Length': stat.size,
      });

      fs.createReadStream(filePath).pipe(res);
    } catch {
      writeJson(res, 404, { error: 'Not found.' });
    }
  };

  const buildMetricsPayload = () => {
    const totalApiOutcomes =
      metrics.totalApiSuccess2xx + metrics.totalApi4xx + metrics.totalApi5xx;
    const queueActiveMsCurrent =
      metrics.queueLastBecameNonZeroAt === null
        ? metrics.queueActiveMsTotal
        : metrics.queueActiveMsTotal + (now() - metrics.queueLastBecameNonZeroAt);

    const p95LatencyMs = percentileFromRing(requestLatencyRing, 95);
    const avgLatencyMs =
      requestLatencyRing.length > 0
        ? Math.round(requestLatencyRing.reduce((sum, item) => sum + item, 0) / requestLatencyRing.length)
        : 0;

    return {
      uptimeMs: Date.now() - metrics.startedAt,
      metrics: {
        ...metrics,
        queueSize: waitQueue.length,
        clientInflightSize: clientInflight.size,
        rateBucketSize: rateBuckets.size,
        totalApiOutcomes,
        rates: {
          api5xxRatio: totalApiOutcomes > 0 ? Number((metrics.totalApi5xx / totalApiOutcomes).toFixed(4)) : 0,
          api429Ratio:
            metrics.totalApiRequests > 0
              ? Number((metrics.totalRateLimited / metrics.totalApiRequests).toFixed(4))
              : 0,
        },
        latencyMs: {
          avg: avgLatencyMs,
          p95: p95LatencyMs,
          sampleSize: requestLatencyRing.length,
        },
        queue: {
          activeMsTotal: queueActiveMsCurrent,
          currentContinuousMs:
            metrics.queueLastBecameNonZeroAt === null ? 0 : now() - metrics.queueLastBecameNonZeroAt,
          peakSinceBoot: metrics.queuePeakSinceBoot,
        },
      },
    };
  };

  const serveMetrics = (req, res) => {
    if (!isMetricsAuthorized(req)) {
      metrics.totalRejectedAuth += 1;
      openAiError(
        res,
        401,
        'invalid_api_key',
        'Missing or invalid API key. /internal/metrics requires localhost access or Authorization: Bearer <TEAM_KEY>.',
      );
      return;
    }

    writeJson(res, 200, buildMetricsPayload());
  };

  const serveReady = async (req, res) => {
    if (!isReadyAuthorized(req)) {
      metrics.totalRejectedAuth += 1;
      openAiError(
        res,
        401,
        'invalid_api_key',
        'Missing or invalid API key. /ready requires localhost access or Authorization: Bearer <TEAM_KEY>.',
      );
      return;
    }

    try {
      const upstreamUrl = new URL('/v1/models', config.vllmBase);
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'qwen-web-gateway/1.0',
        },
        signal: AbortSignal.timeout(config.upstreamTimeoutMs),
      });

      if (!upstream.ok) {
        writeJson(res, 503, { ok: false, ready: false, error: 'upstream_not_ready' });
        return;
      }

      writeJson(res, 200, { ok: true, ready: true });
    } catch {
      writeJson(res, 503, { ok: false, ready: false, error: 'upstream_unreachable' });
    }
  };

  const serveFrontendConfig = (res) => {
    writeJson(res, 200, {
      apiBase: '/v1',
      defaultModel: 'qwen',
      maxModelLen: 65536,
      requiresApiKey: !config.enableWebAuthBypass,
      webAuthBypassEnabled: config.enableWebAuthBypass,
      agentTasksEnabled: config.enableAgentTasks,
    });
  };

  const serveAgentTaskStream = async (req, res) => {
    metrics.totalApiRequests += 1;
    const requestStartMs = now();

    const incomingAuth = req.headers.authorization || '';
    const authValid = isValidTeamBearer(incomingAuth);
    if (!authValid) {
      metrics.totalRejectedAuth += 1;
      openAiError(
        res,
        401,
        'invalid_api_key',
        'Missing or invalid API key. Use Authorization: Bearer <TEAM_KEY>.',
      );
      addRequestLatency(now() - requestStartMs);
      return;
    }

    if (!config.enableAgentTasks) {
      openAiError(res, 404, 'unsupported_endpoint', 'Agent task endpoint is disabled.');
      addRequestLatency(now() - requestStartMs);
      return;
    }

    let body;
    try {
      body = JSON.parse(String(await readRequestBody(req) || '{}'));
    } catch {
      openAiError(res, 400, 'invalid_request_error', 'Invalid JSON body.');
      addRequestLatency(now() - requestStartMs);
      return;
    }

    const userInput = String(body?.input || body?.prompt || '').trim();
    if (!userInput) {
      openAiError(res, 400, 'invalid_request_error', 'Missing required field: input.');
      addRequestLatency(now() - requestStartMs);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    try {
      for await (const event of agentService.runTaskStream({
        sessionId: body?.session_id || null,
        requestId: body?.request_id || null,
        traceId: body?.trace_id || null,
        userInput,
      })) {
        res.write(encodeSseData(event));
      }
      res.write('data: [DONE]\n\n');
      res.end();
      metrics.totalApiSuccess2xx += 1;
    } catch (error) {
      metrics.totalApi5xx += 1;
      if (!res.headersSent) {
        openAiError(
          res,
          500,
          'agent_stream_error',
          error && error.message ? error.message : 'Agent stream failed.',
        );
      } else {
        res.write(
          encodeSseData({
            type: 'task.failed',
            payload: {
              result: 'failed',
              error_code: 'AGENT_STREAM_ERROR',
              message: error && error.message ? error.message : 'Agent stream failed.',
              retryable: true,
            },
          }),
        );
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } finally {
      addRequestLatency(now() - requestStartMs);
    }
  };

  const server = http.createServer(async (req, res) => {
    metrics.totalRequests += 1;

    if (!req.url || !req.method) {
      writeJson(res, 400, { error: 'Bad request.' });
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health') {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (pathname === '/ready') {
      await serveReady(req, res);
      return;
    }

    if (pathname === '/internal/metrics') {
      serveMetrics(req, res);
      return;
    }

    if (pathname === '/frontend/config') {
      serveFrontendConfig(res);
      return;
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      await handleProxyApi(req, res, pathname);
      return;
    }

    if (pathname === '/v1/chat/completions' && req.method === 'POST') {
      await handleProxyApi(req, res, pathname);
      return;
    }

    if (pathname === '/v1/agent/tasks' && req.method === 'POST') {
      await serveAgentTaskStream(req, res);
      return;
    }

    if (pathname.startsWith('/v1/')) {
      openAiError(res, 404, 'unsupported_endpoint', 'Endpoint not enabled in phase-2 gateway.');
      return;
    }

    await serveStatic(req, res, pathname);
  });

  return { server, config };
};

const startGatewayServer = ({ env = process.env } = {}) => {
  const config = createGatewayConfig(env);
  validateStartupSecurity(config);
  const { server } = createGatewayServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`[Gateway] Listening on http://${config.host}:${config.port}`);
    console.log(`[Gateway] Web root: ${config.webRoot}`);
    console.log(`[Gateway] vLLM upstream: ${config.vllmBase}`);
    console.log(`[Gateway] TEAM_API_KEY configured: ${Boolean(config.teamApiKey)}`);
    console.log(`[Gateway] TEAM_API_KEYS_EXTRA count: ${config.teamApiKeysExtra.length}`);
    console.log(`[Gateway] ENABLE_WEB_AUTH_BYPASS: ${config.enableWebAuthBypass}`);
  });
  return server;
};

if (require.main === module) {
  try {
    startGatewayServer();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  createGatewayConfig,
  createGatewayServer,
  startGatewayServer,
  validateStartupSecurity,
};
