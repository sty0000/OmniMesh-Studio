const AGENT_EVENT_TYPES = {
  AGENT_STATE_CHANGED: 'agent.state.changed',
  THINKING_DELTA: 'thinking.delta',
  THINKING_DONE: 'thinking.done',
  MESSAGE_DELTA: 'message.delta',
  MESSAGE_DONE: 'message.done',
  TOOL_CALL_STARTED: 'tool.call.started',
  TOOL_CALL_PROGRESS: 'tool.call.progress',
  TOOL_CALL_FINISHED: 'tool.call.finished',
  TOOL_CALL_FAILED: 'tool.call.failed',
  TASK_DONE: 'task.done',
  TASK_FAILED: 'task.failed',
  TASK_CANCELLED: 'task.cancelled',
};

const AGENT_TASK_STATUS = {
  QUEUED: 'queued',
  PLANNING: 'planning',
  ACTING: 'acting',
  WAITING_TOOL_RESULT: 'waiting_tool_result',
  SUMMARIZING: 'summarizing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const createAgentEvent = ({
  type,
  eventId,
  sequence,
  timestamp,
  requestId,
  sessionId,
  taskId,
  parentTaskId = null,
  source,
  status,
  traceId = null,
  payload = {},
}) => ({
  type,
  event_id: eventId,
  sequence,
  timestamp,
  request_id: requestId,
  session_id: sessionId,
  task_id: taskId,
  parent_task_id: parentTaskId,
  source,
  status,
  trace_id: traceId,
  payload,
});

const encodeSseData = (data) => `data: ${JSON.stringify(data)}\n\n`;

module.exports = {
  AGENT_EVENT_TYPES,
  AGENT_TASK_STATUS,
  createAgentEvent,
  encodeSseData,
};
