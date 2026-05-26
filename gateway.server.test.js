import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayConfig, createGatewayServer } from './gateway.server.js';

const makeFetchResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const startServer = async ({
  env = {},
  fetchImpl = vi.fn(async () => makeFetchResponse({ data: [{ id: 'qwen-test', max_model_len: 4096 }] })),
  getSocketAddress,
} = {}) => {
  const config = createGatewayConfig({
    TEAM_API_KEY: 'team-secret',
    WEB_ROOT: process.cwd(),
    ...env,
  });
  const { server } = createGatewayServer({ config, fetchImpl, getSocketAddress });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl, fetchImpl };
};

describe('gateway.server P0 security hardening', () => {
  const servers = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  it('rejects unauthenticated /v1/models when web bypass is disabled by default', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`);
    expect(response.status).toBe(401);
  });

  it('allows same-origin web bypass only when explicitly enabled and headers are complete', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ data: [{ id: 'qwen-bypass', max_model_len: 2048 }] }));
    const { server, baseUrl } = await startServer({
      env: { ENABLE_WEB_AUTH_BYPASS: 'true' },
      fetchImpl,
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        Host: new URL(baseUrl).host,
        Origin: baseUrl,
        Referer: `${baseUrl}/`,
        'Sec-Fetch-Site': 'same-origin',
        'X-Client-Source': 'web',
      },
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer team-secret');
  });


  it('round-robins across multiple vLLM upstreams', async () => {
    const fetchImpl = vi.fn(async (url) => makeFetchResponse({ data: [{ id: String(url), max_model_len: 2048 }] }));
    const { server, baseUrl } = await startServer({
      env: {
        VLLM_BASES: 'http://node-a:8000,http://node-b:8000',
      },
      fetchImpl,
    });
    servers.push(server);

    await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: 'Bearer team-secret' } });
    await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: 'Bearer team-secret' } });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://node-a:8000/v1/models');
    expect(String(fetchImpl.mock.calls[1][0])).toBe('http://node-b:8000/v1/models');
  });

  it('fails over to the next vLLM upstream when one is unreachable', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).startsWith('http://node-a:8000/')) {
        throw new Error('connect ECONNREFUSED');
      }
      return makeFetchResponse({ data: [{ id: 'qwen-node-b', max_model_len: 2048 }] });
    });
    const { server, baseUrl } = await startServer({
      env: {
        VLLM_BASES: 'http://node-a:8000,http://node-b:8000',
      },
      fetchImpl,
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });

    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://node-a:8000/v1/models');
    expect(String(fetchImpl.mock.calls[1][0])).toBe('http://node-b:8000/v1/models');
  });

  it('rejects bypass when required same-origin headers are incomplete', async () => {
    const { server, baseUrl } = await startServer({
      env: { ENABLE_WEB_AUTH_BYPASS: 'true' },
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        Host: new URL(baseUrl).host,
        Origin: baseUrl,
        Referer: `${baseUrl}/`,
        'X-Client-Source': 'web',
      },
    });

    expect(response.status).toBe(401);
  });

  it('allows localhost access to /internal/metrics without bearer', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/internal/metrics`);
    expect(response.status).toBe(200);
  });

  it('rejects non-local metrics access without bearer', async () => {
    const { server, baseUrl } = await startServer({
      getSocketAddress: () => '192.168.1.20',
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/internal/metrics`);
    expect(response.status).toBe(401);
  });

  it('allows non-local metrics access with valid bearer and returns redacted payload', async () => {
    const { server, baseUrl } = await startServer({
      getSocketAddress: () => '192.168.1.20',
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/internal/metrics`, {
      headers: {
        Authorization: 'Bearer team-secret',
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).not.toHaveProperty('config');
    expect(payload).toHaveProperty('metrics.rates');
    expect(JSON.stringify(payload)).not.toContain('vllmBase');
    expect(JSON.stringify(payload)).not.toContain('teamApiKeyConfigured');
  });

  it('serves anonymous frontend config with only minimal fields', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/frontend/config`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toEqual({
      apiBase: '/v1',
      defaultModel: 'qwen',
      maxModelLen: 65536,
      requiresApiKey: true,
      webAuthBypassEnabled: false,
      agentTasksEnabled: true,
    });
    expect(JSON.stringify(payload)).not.toContain('TEAM_API_KEY');
    expect(JSON.stringify(payload)).not.toContain('VLLM_BASE');
    expect(JSON.stringify(payload)).not.toContain('metrics');
  });

  it('streams minimal agent task events with valid bearer', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/agent/tasks`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer team-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: '请帮我进入最小 agent 链路',
        session_id: 'sess_test',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('"type":"agent.state.changed"');
    expect(text).toContain('"type":"tool.call.started"');
    expect(text).toContain('"type":"task.done"');
    expect(text).toContain('data: [DONE]');
  });

  it('rejects unauthenticated agent task requests', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/agent/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: 'hello',
      }),
    });

    expect(response.status).toBe(401);
  });

  it('returns anonymous health check without auth', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('allows localhost access to /ready when upstream is reachable', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, ready: true });
  });

  it('returns 503 for /ready when upstream is unavailable', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).endsWith('/v1/models')) {
        throw new Error('connect ECONNREFUSED');
      }
      return makeFetchResponse({ data: [] });
    });

    const { server, baseUrl } = await startServer({ fetchImpl });
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload.ok).toBe(false);
    expect(payload.ready).toBe(false);
  });

  it('rejects non-local /ready access without bearer', async () => {
    const { server, baseUrl } = await startServer({
      getSocketAddress: () => '192.168.1.20',
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(401);
  });

  it('allows non-local /ready access with valid bearer', async () => {
    const { server, baseUrl } = await startServer({
      getSocketAddress: () => '192.168.1.20',
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`, {
      headers: {
        Authorization: 'Bearer team-secret',
      },
    });
    expect(response.status).toBe(200);
  });

  it('separates anonymous client buckets by IP for rate limiting', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ data: [{ id: 'qwen-rate', max_model_len: 1024 }] }));
    const { server, baseUrl } = await startServer({
      env: {
        ENABLE_WEB_AUTH_BYPASS: 'true',
        RATE_LIMIT_RPS: '0',
        RATE_LIMIT_BURST: '1',
      },
      fetchImpl,
    });
    servers.push(server);

    const bypassHeaders = (ip) => ({
      Host: new URL(baseUrl).host,
      Origin: baseUrl,
      Referer: `${baseUrl}/`,
      'Sec-Fetch-Site': 'same-origin',
      'X-Client-Source': 'web',
      'X-Forwarded-For': ip,
    });

    const firstIpOk = await fetch(`${baseUrl}/v1/models`, {
      headers: bypassHeaders('10.0.0.1'),
    });
    expect(firstIpOk.status).toBe(200);

    const firstIpLimited = await fetch(`${baseUrl}/v1/models`, {
      headers: bypassHeaders('10.0.0.1'),
    });
    expect(firstIpLimited.status).toBe(429);

    const secondIpOk = await fetch(`${baseUrl}/v1/models`, {
      headers: bypassHeaders('10.0.0.2'),
    });
    expect(secondIpOk.status).toBe(200);
  });

  it('returns 429 when queue wait timeout is exceeded', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ data: [{ id: 'qwen-queue', max_model_len: 1024 }] }));
    const { server, baseUrl } = await startServer({
      env: {
        MAX_GLOBAL_INFLIGHT: '0',
        MAX_QUEUE_SIZE: '4',
        QUEUE_WAIT_MS: '20',
      },
      fetchImpl,
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        Authorization: 'Bearer team-secret',
      },
    });

    expect(response.status).toBe(429);
    const payload = await response.json();
    expect(payload.error?.type).toBe('server_busy');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves static index for root path', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('returns 404 for missing static files', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/missing-file-does-not-exist.txt`);
    expect(response.status).toBe(404);
  });

  it('returns 403 for path traversal attempts', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/..%2FREADME.md`);
    expect(response.status).toBe(403);
  });
});
