export const createFrontendConfig = (reactive) =>
  reactive({
    apiBase: '/v1',
    model: 'qwen',
    maxModelLen: 65536,
    apiKey: '',
    requiresApiKey: true,
    webAuthBypassEnabled: false,
  });

export const applyFrontendConfigPayload = ({ config, maxModelLenSource, payload }) => {
  if (!payload || typeof payload !== 'object') return;

  config.apiBase = payload.apiBase || '/v1';
  config.model = payload.defaultModel || 'qwen';
  config.maxModelLen = Number(payload.maxModelLen) || 65536;
  config.requiresApiKey = payload.requiresApiKey !== false;
  config.webAuthBypassEnabled = payload.webAuthBypassEnabled === true;
  config.agentTasksEnabled = payload.agentTasksEnabled === true;
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
      const match = state.toolCalls.find((item) => item.tool_call_id === event.payload?.tool_call_id);
      if (match) {
        match.status = 'completed';
        match.output = event.payload?.output ?? null;
      }
      break;
    }
    case 'tool.call.failed': {
      const match = state.toolCalls.find((item) => item.tool_call_id === event.payload?.tool_call_id);
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
