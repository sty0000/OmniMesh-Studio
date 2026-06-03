export const createFrontendConfig = (reactive) =>
  reactive({
    apiBase: '/v1',
    model: 'qwen',
    maxModelLen: 65536,
    apiKey: '',
    requiresApiKey: true,
    webAuthBypassEnabled: false,
    agentTasksEnabled: false,
    multimodal: {
      maxAttachments: 4,
      kinds: {
        image: { enabled: false, maxBytes: 10 * 1024 * 1024, acceptedMimeTypes: [] },
        audio: { enabled: false, maxBytes: 25 * 1024 * 1024, acceptedMimeTypes: [] },
        video: { enabled: false, maxBytes: 100 * 1024 * 1024, acceptedMimeTypes: [] },
        file: { enabled: false, maxBytes: 25 * 1024 * 1024, acceptedMimeTypes: [] },
      },
    },
  });

export const applyFrontendConfigPayload = ({ config, maxModelLenSource, payload }) => {
  if (!payload || typeof payload !== 'object') return;

  config.apiBase = payload.apiBase || '/v1';
  config.model = payload.defaultModel || 'qwen';
  config.maxModelLen = Number(payload.maxModelLen) || 65536;
  config.requiresApiKey = payload.requiresApiKey !== false;
  config.webAuthBypassEnabled = payload.webAuthBypassEnabled === true;
  config.agentTasksEnabled = payload.agentTasksEnabled === true;
  if (payload.multimodal && typeof payload.multimodal === 'object') {
    config.multimodal = payload.multimodal;
  }
  maxModelLenSource.value = 'config';
};

export const createAgentTaskState = (reactive) =>
  reactive({
    taskId: '',
    requestId: '',
    sessionId: '',
    traceId: '',
    status: 'idle',
    thinking: '',
    finalMessage: '',
    toolCalls: [],
    events: [],
    lastError: '',
  });

export const applyAgentEventToState = ({ state, event }) => {
  if (!state || !event || typeof event !== 'object') return;

  state.events.push(event);
  if (event.task_id) state.taskId = event.task_id;
  if (event.request_id) state.requestId = event.request_id;
  if (event.session_id) state.sessionId = event.session_id;
  if (event.trace_id) state.traceId = event.trace_id;
  if (event.status) state.status = event.status;

  switch (event.type) {
    case 'thinking.delta':
      state.thinking += event.payload?.delta || '';
      break;
    case 'message.delta':
      state.finalMessage += event.payload?.delta || '';
      break;
    case 'message.done':
      state.finalMessage = event.payload?.content || state.finalMessage;
      break;
    case 'tool.call.started':
      state.toolCalls.push({
        tool_call_id: event.payload?.tool_call_id || '',
        tool_name: event.payload?.tool_name || '',
        status: 'running',
        input: event.payload?.input ?? null,
        output: null,
        error: null,
      });
      break;
    case 'tool.call.finished': {
      const match = state.toolCalls.find(
        (item) => item.tool_call_id === event.payload?.tool_call_id,
      );
      if (match) {
        match.status = 'completed';
        match.output = event.payload?.output ?? null;
      }
      break;
    }
    case 'tool.call.failed': {
      const match = state.toolCalls.find(
        (item) => item.tool_call_id === event.payload?.tool_call_id,
      );
      if (match) {
        match.status = 'failed';
        match.error = event.payload?.message || 'Tool call failed';
      }
      state.lastError = event.payload?.message || 'Tool call failed';
      break;
    }
    case 'task.failed':
      state.lastError = event.payload?.message || 'Task failed';
      break;
    case 'task.cancelled':
      state.lastError = 'Task cancelled';
      break;
    default:
      break;
  }
};

export const createMultimodalContent = ({ prompt, mediaItems = [] }) => {
  const content = [];
  mediaItems.forEach((media) => {
    if (media.type === 'image') {
      content.push({ type: 'image_url', image_url: { url: media.url } });
    } else if (media.type === 'video') {
      content.push({ type: 'video_url', video_url: { url: media.url } });
    } else if (media.type === 'audio') {
      content.push({ type: 'audio_url', audio_url: { url: media.url } });
    } else if (media.type === 'file') {
      content.push({
        type: 'file_url',
        file_url: {
          url: media.url,
          filename: media.name,
          mime_type: media.mimeType,
        },
      });
    }
  });

  const text = String(prompt || '').trim();
  if (text) {
    content.push({ type: 'text', text });
  }

  return content;
};
