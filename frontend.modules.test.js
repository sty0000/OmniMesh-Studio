import { describe, expect, it, vi } from 'vitest';

import {
  createFrontendConfig,
  applyFrontendConfigPayload,
  createAgentTaskState,
  applyAgentEventToState,
  createMultimodalContent,
} from './frontend/state.js';
import { createApiModule } from './frontend/api.js';
import { createMarkdownHelpers } from './frontend/rendering.js';

describe('frontend config state helpers', () => {
  it('applies frontend config payload to reactive-like object', () => {
    const config = createFrontendConfig((input) => input);
    const maxModelLenSource = { value: 'default' };

    applyFrontendConfigPayload({
      config,
      maxModelLenSource,
      payload: {
        apiBase: '/v1',
        defaultModel: 'qwen3',
        maxModelLen: 131072,
        requiresApiKey: false,
        webAuthBypassEnabled: true,
        multimodal: {
          maxAttachments: 4,
          kinds: {
            image: { enabled: true, maxBytes: 10485760, acceptedMimeTypes: ['image/png'] },
          },
        },
      },
    });

    expect(config.apiBase).toBe('/v1');
    expect(config.model).toBe('qwen3');
    expect(config.maxModelLen).toBe(131072);
    expect(config.requiresApiKey).toBe(false);
    expect(config.webAuthBypassEnabled).toBe(true);
    expect(config.agentTasksEnabled).toBe(false);
    expect(config.multimodal.kinds.image.enabled).toBe(true);
    expect(config.multimodal.kinds.image.acceptedMimeTypes).toEqual(['image/png']);
    expect(maxModelLenSource.value).toBe('config');
  });
});

it('builds OpenAI-compatible multimodal content items', () => {
  const content = createMultimodalContent({
    prompt: 'describe this',
    mediaItems: [
      { type: 'image', url: 'data:image/png;base64,abc' },
      { type: 'audio', url: 'data:audio/webm;base64,abc' },
      { type: 'video', url: 'data:video/mp4;base64,abc' },
      {
        type: 'file',
        url: 'data:text/plain;base64,abc',
        name: 'note.txt',
        mimeType: 'text/plain',
      },
    ],
  });

  expect(content).toEqual([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
    { type: 'audio_url', audio_url: { url: 'data:audio/webm;base64,abc' } },
    { type: 'video_url', video_url: { url: 'data:video/mp4;base64,abc' } },
    {
      type: 'file_url',
      file_url: {
        url: 'data:text/plain;base64,abc',
        filename: 'note.txt',
        mime_type: 'text/plain',
      },
    },
    { type: 'text', text: 'describe this' },
  ]);
});

describe('frontend api module', () => {
  it('loads anonymous frontend config from backend endpoint', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        apiBase: '/v1',
        defaultModel: 'qwen',
        maxModelLen: 65536,
        requiresApiKey: true,
        webAuthBypassEnabled: false,
        agentTasksEnabled: true,
      }),
    }));
    const api = createApiModule({
      fetchImpl,
      AbortSignalImpl: AbortSignal,
      console,
    });

    const payload = await api.loadFrontendConfig();
    expect(payload.apiBase).toBe('/v1');
    expect(fetchImpl).toHaveBeenCalledWith('/frontend/config', {
      headers: { Accept: 'application/json' },
    });
  });

  it('uploads frontend files through multipart endpoint', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      expect(url).toBe('/frontend/uploads');
      expect(options.method).toBe('POST');
      expect(options.headers.Authorization).toBe('Bearer secret');
      expect(options.headers['X-Client-Source']).toBe('web');
      expect(options.body).toBeInstanceOf(FormData);
      return {
        ok: true,
        json: async () => ({
          files: [
            {
              id: 'upload_1',
              kind: 'image',
              name: 'a.png',
              mimeType: 'image/png',
              sizeBytes: 3,
              dataUrl: 'data:image/png;base64,abc',
            },
          ],
        }),
      };
    });
    const api = createApiModule({
      fetchImpl,
      AbortSignalImpl: AbortSignal,
      console,
    });

    const files = await api.uploadFrontendFiles({
      apiKey: 'secret',
      files: [new File(['abc'], 'a.png', { type: 'image/png' })],
    });

    expect(files[0].dataUrl).toBe('data:image/png;base64,abc');
  });

  it('does not probe protected model endpoint without explicit api key', async () => {
    const fetchImpl = vi.fn();
    const api = createApiModule({
      fetchImpl,
      AbortSignalImpl: AbortSignal,
      console,
    });

    const result = await api.loadModelInfoFromApi({ apiBase: '/v1', apiKey: '' });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('loads model info only when explicit api key is provided', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: 'qwen-live', max_model_len: 32768 }],
      }),
    }));
    const api = createApiModule({
      fetchImpl,
      AbortSignalImpl: AbortSignal,
      console,
    });

    const result = await api.loadModelInfoFromApi({ apiBase: '/v1', apiKey: 'secret' });
    expect(result).toEqual({ id: 'qwen-live', max_model_len: 32768 });
    expect(fetchImpl).toHaveBeenCalledWith('/v1/models', {
      headers: {
        Authorization: 'Bearer secret',
        'X-Client-Source': 'web',
      },
    });
  });

  it('runs minimal agent task stream and emits parsed events', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"agent.state.changed","status":"planning","payload":{"label":"进入规划阶段"}}\n\n',
          ),
        );
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"task.done","status":"completed","payload":{"result":"success"}}\n\n',
          ),
        );
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    const fetchImpl = vi.fn(async () => ({
      ok: true,
      body,
    }));

    const api = createApiModule({
      fetchImpl,
      AbortSignalImpl: AbortSignal,
      console,
    });

    const events = [];
    await api.runAgentTask({
      apiBase: '/v1',
      apiKey: 'secret',
      input: 'task',
      sessionId: 'sess_1',
      onEvent: (event) => events.push(event),
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent.state.changed');
    expect(events[1].type).toBe('task.done');
  });
});

describe('frontend agent state helpers', () => {
  it('applies minimal agent events into local state', () => {
    const state = createAgentTaskState((input) => input);
    applyAgentEventToState({
      state,
      event: {
        type: 'thinking.delta',
        task_id: 'task_1',
        request_id: 'req_1',
        session_id: 'sess_1',
        status: 'planning',
        payload: {
          delta: '思考中',
        },
      },
    });
    applyAgentEventToState({
      state,
      event: {
        type: 'tool.call.started',
        status: 'acting',
        payload: {
          tool_call_id: 'tool_1',
          tool_name: 'summarize_input',
          input: { text: 'hi' },
        },
      },
    });
    applyAgentEventToState({
      state,
      event: {
        type: 'message.done',
        status: 'completed',
        payload: {
          content: '最终结果',
        },
      },
    });

    expect(state.taskId).toBe('task_1');
    expect(state.thinking).toBe('思考中');
    expect(state.toolCalls).toHaveLength(1);
    expect(state.finalMessage).toBe('最终结果');
  });
});

describe('frontend rendering helpers', () => {
  it('keeps markdown preprocessing and rendering cache inputs stable', () => {
    global.document = {
      createElement: () => ({ innerHTML: '' }),
    };

    const marked = {
      parse: (text) => `<p>${text}</p>`,
    };
    const DOMPurify = {
      sanitize: (html) => html,
    };
    const renderMathInElement = vi.fn();

    const helpers = createMarkdownHelpers({
      marked,
      renderMathInElement,
      DOMPurify,
    });

    const html = helpers.renderMarkdownSegment('这是一个 ^{210}\\text{Pb} 测试');
    expect(html).toContain('$^{210}\\text{Pb}$');
    expect(renderMathInElement).toHaveBeenCalledTimes(1);

    const segments = helpers.splitMarkdownSegments('a\n```js\nb\n```\nc');
    expect(segments).toEqual(['a\n', '```js\nb\n```', '\nc']);
  });
});
