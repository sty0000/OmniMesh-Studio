import { describe, expect, it } from 'vitest';

const { createAgentService } = require('./agent.service.js');

describe('agent service minimal task stream', () => {
  it('emits a minimal successful event sequence', async () => {
    const service = createAgentService({
      nowFn: () => '2026-05-20T12:00:00Z',
      idFactory: (() => {
        let i = 0;
        return (prefix) => `${prefix}_${++i}`;
      })(),
    });

    const events = [];
    for await (const event of service.runTaskStream({
      sessionId: 'sess_1',
      requestId: 'req_1',
      traceId: 'trace_1',
      userInput: '请总结这个任务',
    })) {
      events.push(event);
    }

    expect(events[0].type).toBe('agent.state.changed');
    expect(events.some((item) => item.type === 'tool.call.started')).toBe(true);
    expect(events.some((item) => item.type === 'tool.call.finished')).toBe(true);
    expect(events.at(-1).type).toBe('task.done');
  });
});
