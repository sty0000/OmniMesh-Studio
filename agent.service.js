const {
  AGENT_EVENT_TYPES,
  AGENT_TASK_STATUS,
  createAgentEvent,
} = require('./agent.protocol.js');

const createIdFactory = () => {
  let counter = 0;
  return (prefix) => `${prefix}_${Date.now().toString(36)}_${(++counter).toString(36)}`;
};

const chunkText = (text, size = 24) => {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
};

const createAgentService = ({
  nowFn = () => new Date().toISOString(),
  idFactory = createIdFactory(),
} = {}) => {
  const toolDefinitions = [
    {
      name: 'summarize_input',
      description: 'Generate a lightweight summary of the user input for task planning.',
      timeout_ms: 3000,
    },
  ];

  const createTaskContext = ({ sessionId, requestId, userInput, traceId = null }) => ({
    taskId: idFactory('task'),
    sessionId: sessionId || idFactory('sess'),
    requestId: requestId || idFactory('req'),
    traceId,
    userInput: String(userInput || '').trim(),
  });

  const runTaskStream = async function* ({ sessionId, requestId, traceId = null, userInput }) {
    const ctx = createTaskContext({ sessionId, requestId, traceId, userInput });
    let sequence = 0;

    const nextEvent = ({ type, source, status, payload }) =>
      createAgentEvent({
        type,
        eventId: idFactory('evt'),
        sequence: ++sequence,
        timestamp: nowFn(),
        requestId: ctx.requestId,
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        source,
        status,
        traceId: ctx.traceId,
        payload,
      });

    try {
      yield nextEvent({
        type: AGENT_EVENT_TYPES.AGENT_STATE_CHANGED,
        source: 'agent',
        status: AGENT_TASK_STATUS.PLANNING,
        payload: {
          from: AGENT_TASK_STATUS.QUEUED,
          to: AGENT_TASK_STATUS.PLANNING,
          reason: 'task_started',
          label: '进入规划阶段',
        },
      });

      yield nextEvent({
        type: AGENT_EVENT_TYPES.THINKING_DELTA,
        source: 'model',
        status: AGENT_TASK_STATUS.PLANNING,
        payload: {
          delta: '正在分析任务输入并准备最小工具调用...',
          format: 'text',
        },
      });

      const toolCallId = idFactory('tool');
      yield nextEvent({
        type: AGENT_EVENT_TYPES.AGENT_STATE_CHANGED,
        source: 'agent',
        status: AGENT_TASK_STATUS.ACTING,
        payload: {
          from: AGENT_TASK_STATUS.PLANNING,
          to: AGENT_TASK_STATUS.ACTING,
          reason: 'tool_selected',
          label: '进入工具调用阶段',
        },
      });

      yield nextEvent({
        type: AGENT_EVENT_TYPES.TOOL_CALL_STARTED,
        source: 'tool',
        status: AGENT_TASK_STATUS.ACTING,
        payload: {
          tool_call_id: toolCallId,
          tool_name: toolDefinitions[0].name,
          display_name: '输入摘要',
          input: {
            text: ctx.userInput,
          },
        },
      });

      yield nextEvent({
        type: AGENT_EVENT_TYPES.AGENT_STATE_CHANGED,
        source: 'agent',
        status: AGENT_TASK_STATUS.WAITING_TOOL_RESULT,
        payload: {
          from: AGENT_TASK_STATUS.ACTING,
          to: AGENT_TASK_STATUS.WAITING_TOOL_RESULT,
          reason: 'tool_running',
          label: '等待工具结果',
        },
      });

      const summary =
        ctx.userInput.length > 80 ? `${ctx.userInput.slice(0, 80)}…` : ctx.userInput || '空输入';
      yield nextEvent({
        type: AGENT_EVENT_TYPES.TOOL_CALL_FINISHED,
        source: 'tool',
        status: AGENT_TASK_STATUS.WAITING_TOOL_RESULT,
        payload: {
          tool_call_id: toolCallId,
          tool_name: toolDefinitions[0].name,
          output: {
            summary,
            length: ctx.userInput.length,
          },
          duration_ms: 5,
        },
      });

      yield nextEvent({
        type: AGENT_EVENT_TYPES.AGENT_STATE_CHANGED,
        source: 'agent',
        status: AGENT_TASK_STATUS.SUMMARIZING,
        payload: {
          from: AGENT_TASK_STATUS.WAITING_TOOL_RESULT,
          to: AGENT_TASK_STATUS.SUMMARIZING,
          reason: 'tool_completed',
          label: '汇总工具结果',
        },
      });

      const finalMessage = `已进入最小 Agent 链路。\n\n任务摘要：${summary}\n\n当前已完成：规划、工具调用、状态流转与结构化事件输出。`;
      for (const delta of chunkText(finalMessage)) {
        yield nextEvent({
          type: AGENT_EVENT_TYPES.MESSAGE_DELTA,
          source: 'model',
          status: AGENT_TASK_STATUS.SUMMARIZING,
          payload: {
            role: 'assistant',
            delta,
          },
        });
      }

      yield nextEvent({
        type: AGENT_EVENT_TYPES.MESSAGE_DONE,
        source: 'model',
        status: AGENT_TASK_STATUS.SUMMARIZING,
        payload: {
          role: 'assistant',
          content: finalMessage,
          finish_reason: 'stop',
        },
      });

      yield nextEvent({
        type: AGENT_EVENT_TYPES.TASK_DONE,
        source: 'agent',
        status: AGENT_TASK_STATUS.COMPLETED,
        payload: {
          result: 'success',
          summary: '最小 Agent 任务执行完成',
        },
      });
    } catch (error) {
      yield nextEvent({
        type: AGENT_EVENT_TYPES.TASK_FAILED,
        source: 'agent',
        status: AGENT_TASK_STATUS.FAILED,
        payload: {
          result: 'failed',
          error_code: 'AGENT_EXECUTION_FAILED',
          message: error && error.message ? error.message : 'Unknown agent execution failure',
          retryable: true,
        },
      });
    }
  };

  return {
    toolDefinitions,
    createTaskContext,
    runTaskStream,
  };
};

module.exports = {
  createAgentService,
};
