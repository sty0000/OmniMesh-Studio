export const createApiModule = ({ fetchImpl, AbortSignalImpl, console }) => {
  const parseSse = async ({ response, onEvent }) => {
    const reader = response.body?.getReader?.();
    if (!reader) {
      throw new Error('SSE response body is not readable');
    }

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() || '';

      for (const chunk of chunks) {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            return;
          }
          onEvent(JSON.parse(payload));
        }
      }
    }
  };

  const loadFrontendConfig = async () => {
    const response = await fetchImpl('/frontend/config', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`Failed to load frontend config: HTTP ${response.status}`);
    }
    return await response.json();
  };

  const loadModelInfoFromApi = async ({ apiBase, apiKey }) => {
    if (!apiKey) return null;
    const response = await fetchImpl(`${apiBase}/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Client-Source': 'web',
      },
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json();
    return data?.data?.[0] || null;
  };

  const reconnectProbe = async ({ apiBase, apiKey }) => {
    if (!apiKey) return false;
    try {
      const response = await fetchImpl(`${apiBase}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-Client-Source': 'web',
        },
        signal: AbortSignalImpl.timeout(3000),
      });
      return response.ok;
    } catch (err) {
      console.debug?.('Reconnect probe failed', err);
      return false;
    }
  };

  const uploadFrontendFiles = async ({ files, apiKey }) => {
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));

    const headers = { 'X-Client-Source': 'web' };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetchImpl('/frontend/uploads', {
      method: 'POST',
      headers,
      body: formData,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || `Upload failed: HTTP ${response.status}`;
      const error = new Error(message);
      error.type = payload?.error?.type || 'upload_failed';
      error.status = response.status;
      throw error;
    }

    return payload.files || [];
  };

  const runAgentTask = async ({
    apiBase,
    apiKey,
    input,
    sessionId,
    requestId,
    traceId,
    onEvent,
  }) => {
    if (!apiKey) {
      throw new Error('API key is required for agent tasks');
    }

    const response = await fetchImpl(`${apiBase}/agent/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'X-Client-Source': 'web',
      },
      body: JSON.stringify({
        input,
        session_id: sessionId,
        request_id: requestId,
        trace_id: traceId,
      }),
    });

    if (!response.ok) {
      throw new Error(`Agent task failed to start: HTTP ${response.status}`);
    }

    await parseSse({ response, onEvent });
  };

  return {
    loadFrontendConfig,
    loadModelInfoFromApi,
    reconnectProbe,
    uploadFrontendFiles,
    runAgentTask,
  };
};
