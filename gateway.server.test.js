import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayConfig, createGatewayServer } from './gateway.server.js';

const FETCH_BLOCKED_TEST_PORTS = new Set([6000, 6665, 6666, 6667, 6668, 6669]);
const makeFetchResponse = (payload) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const startServer = async ({
  env = {},
  fetchImpl = vi.fn(async () =>
    makeFetchResponse({ data: [{ id: 'qwen-test', max_model_len: 4096 }] }),
  ),
  getSocketAddress,
} = {}) => {
  const config = createGatewayConfig({
    TEAM_API_KEY: 'team-secret',
    WEB_ROOT: process.cwd(),
    ...env,
  });
  let server;
  let address;
  do {
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    ({ server } = createGatewayServer({ config, fetchImpl, getSocketAddress }));
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    address = server.address();
  } while (FETCH_BLOCKED_TEST_PORTS.has(address.port));

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
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ data: [{ id: 'qwen-bypass', max_model_len: 2048 }] }),
    );
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
    const fetchImpl = vi.fn(async (url) =>
      makeFetchResponse({ data: [{ id: String(url), max_model_len: 2048 }] }),
    );
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
  it('returns standardized 502 when all upstreams are unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
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
    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.error?.type).toBe('upstream_unavailable');

    const metricsResponse = await fetch(`${baseUrl}/internal/metrics`);
    const metricsPayload = await metricsResponse.json();
    expect(metricsPayload.metrics.totalUpstreamUnavailable).toBe(1);
    expect(metricsPayload.metrics.upstreams).toHaveLength(2);
    expect(metricsPayload.metrics.upstreams.every((item) => item.circuitOpen)).toBe(true);
  });

  it('returns standardized 504 when upstream fetch times out', async () => {
    const timeoutError = new Error('timeout');
    timeoutError.name = 'TimeoutError';
    const fetchImpl = vi.fn(async () => {
      throw timeoutError;
    });
    const { server, baseUrl } = await startServer({ fetchImpl });
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    expect(response.status).toBe(504);
    const payload = await response.json();
    expect(payload.error?.type).toBe('upstream_timeout');

    const metricsResponse = await fetch(`${baseUrl}/internal/metrics`);
    const metricsPayload = await metricsResponse.json();
    expect(metricsPayload.metrics.totalUpstreamTimeout).toBe(1);
    expect(metricsPayload.metrics.upstreams[0]).toMatchObject({
      attempts: 1,
      failures: 1,
      timeouts: 1,
      circuitOpen: true,
    });
  });

  it('reports per-upstream success, failure, and circuit metrics', async () => {
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

    const proxyResponse = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    expect(proxyResponse.status).toBe(200);

    const metricsResponse = await fetch(`${baseUrl}/internal/metrics`);
    expect(metricsResponse.status).toBe(200);
    const payload = await metricsResponse.json();
    const upstreams = payload.metrics.upstreams;
    expect(upstreams).toHaveLength(2);
    expect(upstreams[0]).toMatchObject({
      base: 'http://node-a:8000',
      attempts: 1,
      successes: 0,
      failures: 1,
      circuitOpen: true,
      readyCandidate: false,
    });
    expect(upstreams[1]).toMatchObject({
      base: 'http://node-b:8000',
      attempts: 1,
      successes: 1,
      failures: 0,
      circuitOpen: false,
      readyCandidate: true,
      successRate: 1,
    });
  });
  it('skips a circuit-open upstream and reports consistent ready and metrics snapshots', async () => {
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

    const first = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    expect(second.status).toBe(200);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://node-a:8000/v1/models');
    expect(String(fetchImpl.mock.calls[1][0])).toBe('http://node-b:8000/v1/models');
    expect(String(fetchImpl.mock.calls[2][0])).toBe('http://node-b:8000/v1/models');

    const readyResponse = await fetch(`${baseUrl}/ready`);
    expect(readyResponse.status).toBe(200);
    const readyPayload = await readyResponse.json();
    expect(readyPayload.upstreams[0]).toMatchObject({
      base: 'http://node-a:8000',
      circuitOpen: true,
      readyCandidate: false,
    });

    const metricsResponse = await fetch(`${baseUrl}/internal/metrics`);
    expect(metricsResponse.status).toBe(200);
    const metricsPayload = await metricsResponse.json();
    expect(metricsPayload.metrics.upstreams[0]).toMatchObject({
      base: readyPayload.upstreams[0].base,
      circuitOpen: readyPayload.upstreams[0].circuitOpen,
      readyCandidate: readyPayload.upstreams[0].readyCandidate,
      attempts: 1,
      failures: 1,
    });
    expect(metricsPayload.metrics.upstreams[1].successes).toBeGreaterThanOrEqual(3);
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
    expect(payload).toMatchObject({
      apiBase: '/v1',
      defaultModel: 'qwen',
      maxModelLen: 65536,
      requiresApiKey: true,
      webAuthBypassEnabled: false,
      agentTasksEnabled: true,
    });
    expect(payload.multimodal).toMatchObject({
      maxAttachments: 4,
      kinds: {
        image: { enabled: false, maxBytes: 10 * 1024 * 1024 },
        audio: { enabled: false, maxBytes: 25 * 1024 * 1024 },
        video: { enabled: false, maxBytes: 100 * 1024 * 1024 },
        file: { enabled: false, maxBytes: 25 * 1024 * 1024 },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('TEAM_API_KEY');
    expect(JSON.stringify(payload)).not.toContain('VLLM_BASE');
    expect(JSON.stringify(payload)).not.toContain('metrics');
  });

  it('exposes enabled multimodal frontend config without secrets', async () => {
    const { server, baseUrl } = await startServer({
      env: {
        VLLM_BASE: 'http://private-upstream:8000',
        MULTIMODAL_IMAGE_ENABLED: 'true',
        MULTIMODAL_MAX_IMAGE_MB: '10',
        MULTIMODAL_MAX_ATTACHMENTS: '4',
      },
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/frontend/config`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.multimodal.maxAttachments).toBe(4);
    expect(payload.multimodal.kinds.image).toMatchObject({
      enabled: true,
      maxBytes: 10 * 1024 * 1024,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('team-secret');
    expect(serialized).not.toContain('private-upstream');
    expect(serialized).not.toContain('metrics');
  });

  it('validates frontend multipart uploads without persisting content in metrics', async () => {
    const { server, baseUrl } = await startServer({
      env: {
        MULTIMODAL_IMAGE_ENABLED: 'true',
        MULTIMODAL_FILE_ENABLED: 'true',
        MULTIMODAL_MAX_ATTACHMENTS: '1',
        MULTIMODAL_MAX_IMAGE_MB: '0.000001',
      },
    });
    servers.push(server);

    const unauthenticated = new FormData();
    unauthenticated.append('files', new Blob(['png'], { type: 'image/png' }), 'test.png');
    const unauthenticatedResponse = await fetch(`${baseUrl}/frontend/uploads`, {
      method: 'POST',
      body: unauthenticated,
    });
    expect(unauthenticatedResponse.status).toBe(401);
    expect((await unauthenticatedResponse.json()).error?.type).toBe('invalid_api_key');

    const headers = { Authorization: 'Bearer team-secret' };
    const invalidForm = new FormData();
    invalidForm.append('files', new Blob(['x'], { type: 'application/x-msdownload' }), 'bad.exe');
    const invalidResponse = await fetch(`${baseUrl}/frontend/uploads`, {
      method: 'POST',
      headers,
      body: invalidForm,
    });
    expect(invalidResponse.status).toBe(415);
    expect((await invalidResponse.json()).error?.type).toBe('invalid_upload_type');

    const tooLargeForm = new FormData();
    tooLargeForm.append('files', new Blob(['too-large'], { type: 'image/png' }), 'large.png');
    const tooLargeResponse = await fetch(`${baseUrl}/frontend/uploads`, {
      method: 'POST',
      headers,
      body: tooLargeForm,
    });
    expect(tooLargeResponse.status).toBe(413);
    expect((await tooLargeResponse.json()).error?.type).toBe('upload_too_large');

    const tooManyForm = new FormData();
    tooManyForm.append('files', new Blob(['a'], { type: 'text/plain' }), 'a.txt');
    tooManyForm.append('files', new Blob(['b'], { type: 'text/plain' }), 'b.txt');
    const tooManyResponse = await fetch(`${baseUrl}/frontend/uploads`, {
      method: 'POST',
      headers,
      body: tooManyForm,
    });
    expect(tooManyResponse.status).toBe(400);
    expect((await tooManyResponse.json()).error?.type).toBe('too_many_uploads');

    const okForm = new FormData();
    okForm.append('files', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const okResponse = await fetch(`${baseUrl}/frontend/uploads`, {
      method: 'POST',
      headers,
      body: okForm,
    });
    expect(okResponse.status).toBe(200);
    const okPayload = await okResponse.json();
    expect(okPayload.files[0]).toMatchObject({
      kind: 'file',
      name: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
    });
    expect(okPayload.files[0].dataUrl).toBe('data:text/plain;base64,aGVsbG8=');

    const metricsResponse = await fetch(`${baseUrl}/internal/metrics`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    const metricsText = await metricsResponse.text();
    expect(metricsText).not.toContain('aGVsbG8=');
    expect(metricsText).not.toContain('data:text/plain');
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

  it('returns anonymous process health schema without probing upstreams', async () => {
    const fetchImpl = vi.fn(async () => makeFetchResponse({ data: [] }));
    const { server, baseUrl } = await startServer({
      env: { VLLM_BASES: 'http://node-a:8000,http://node-b:8000' },
      fetchImpl,
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      ok: true,
      status: 'ok',
      mode: 'replica',
      upstreamCount: 2,
    });
    expect(Number.isFinite(payload.uptimeMs)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('returns internal metrics schema with queue, latency, and per-upstream state', async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ data: [{ id: 'qwen-observable', max_model_len: 2048 }] }),
    );
    const { server, baseUrl } = await startServer({
      env: { VLLM_BASES: 'http://node-a:8000,http://node-b:8000' },
      fetchImpl,
    });
    servers.push(server);

    const proxyResponse = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    expect(proxyResponse.status).toBe(200);

    const response = await fetch(`${baseUrl}/internal/metrics`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(Number.isFinite(payload.uptimeMs)).toBe(true);
    expect(payload.metrics).toMatchObject({
      totalApiRequests: 1,
      queueSize: 0,
      totalApiOutcomes: 1,
    });
    expect(payload.metrics.rates).toHaveProperty('api5xxRatio');
    expect(payload.metrics.rates).toHaveProperty('api429Ratio');
    expect(payload.metrics.latencyMs).toMatchObject({
      sampleSize: 1,
    });
    expect(Number.isFinite(payload.metrics.latencyMs.avg)).toBe(true);
    expect(Number.isFinite(payload.metrics.latencyMs.p95)).toBe(true);
    expect(payload.metrics.queue).toHaveProperty('activeMsTotal');
    expect(payload.metrics.queue).toHaveProperty('currentContinuousMs');
    expect(payload.metrics.queue).toHaveProperty('peakSinceBoot');
    expect(payload.metrics.upstreams).toHaveLength(2);
    expect(payload.metrics.upstreams[0]).toMatchObject({
      base: 'http://node-a:8000',
      readyCandidate: true,
      circuitOpen: false,
      attempts: 1,
      successes: 1,
      failures: 0,
      successRate: 1,
    });
    expect(payload.metrics.upstreams[0]).toHaveProperty('averageLatencyMs');
    expect(payload.metrics.upstreams[0]).toHaveProperty('lastError');
  });

  it('allows localhost access to /ready when upstream is reachable', async () => {
    const { server, baseUrl } = await startServer();
    servers.push(server);

    const response = await fetch(`${baseUrl}/ready`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ ok: true, ready: true });
    expect(payload.upstreams).toHaveLength(1);
    expect(payload.upstreams[0]).toMatchObject({
      base: 'http://127.0.0.1:8000',
      successes: 1,
      failures: 0,
      circuitOpen: false,
    });
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
    expect(payload.upstreams).toHaveLength(1);
    expect(payload.upstreams[0]).toMatchObject({
      base: 'http://127.0.0.1:8000',
      successes: 0,
      failures: 1,
      circuitOpen: true,
    });
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
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ data: [{ id: 'qwen-rate', max_model_len: 1024 }] }),
    );
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

  it('returns 429 when per-client concurrency limit is exceeded', async () => {
    let releaseUpstream;
    let markFirstRequestStarted;
    const firstRequestStarted = new Promise((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const holdFirstRequest = new Promise((resolve) => {
      releaseUpstream = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      markFirstRequestStarted();
      await holdFirstRequest;
      return makeFetchResponse({ data: [{ id: 'qwen-concurrency', max_model_len: 1024 }] });
    });
    const { server, baseUrl } = await startServer({
      env: { MAX_CONCURRENT_PER_CLIENT: '1' },
      fetchImpl,
    });
    servers.push(server);

    const first = fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    await firstRequestStarted;

    const second = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
    });
    expect(second.status).toBe(429);
    const secondPayload = await second.json();
    expect(secondPayload.error?.type).toBe('concurrency_limit_exceeded');

    releaseUpstream();
    expect((await first).status).toBe(200);
  });
  it('returns 429 when queue wait timeout is exceeded', async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ data: [{ id: 'qwen-queue', max_model_len: 1024 }] }),
    );
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
  it('returns 429 immediately when global queue is full', async () => {
    const fetchImpl = vi.fn(async () =>
      makeFetchResponse({ data: [{ id: 'qwen-queue-full', max_model_len: 1024 }] }),
    );
    const { server, baseUrl } = await startServer({
      env: {
        MAX_GLOBAL_INFLIGHT: '0',
        MAX_QUEUE_SIZE: '0',
        QUEUE_WAIT_MS: '20000',
      },
      fetchImpl,
    });
    servers.push(server);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer team-secret' },
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
