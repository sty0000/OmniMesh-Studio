import { describe, expect, it } from 'vitest';

const {
  AGENT_EVENT_TYPES,
  AGENT_TASK_STATUS,
  createAgentEvent,
  encodeSseData,
} = require('./agent.protocol.js');

describe('agent protocol helpers', () => {
  it('creates a normalized agent event envelope', () => {
    const event = createAgentEvent({
      type: AGENT_EVENT_TYPES.AGENT_STATE_CHANGED,
      eventId: 'evt_1',
      sequence: 1,
      timestamp: '2026-05-20T00:00:00Z',
      requestId: 'req_1',
      sessionId: 'sess_1',
      taskId: 'task_1',
      source: 'agent',
      status: AGENT_TASK_STATUS.PLANNING,
      payload: { ok: true },
    });

    expect(event.type).toBe('agent.state.changed');
    expect(event.status).toBe('planning');
    expect(event.payload.ok).toBe(true);
  });

  it('encodes SSE line correctly', () => {
    const encoded = encodeSseData({ type: 'task.done' });
    expect(encoded).toBe('data: {"type":"task.done"}\n\n');
  });
});
