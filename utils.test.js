import { describe, it, expect } from 'vitest';
const { parseServiceLog, validateParams, parseSSE } = require('./utils.js');

describe('parseServiceLog', () => {
  it('should parse model name correctly', () => {
    const log = `INFO: args: Namespace(model='Qwen/Qwen1.5-7B-Chat', max_model_len=32768, port=8000)`;
    const result = parseServiceLog(log);
    expect(result.model).toBe('Qwen/Qwen1.5-7B-Chat');
    expect(result.maxModelLen).toBe(32768);
    expect(result.apiBase).toBe('http://localhost:8000/v1');
  });

  it('should parse --model syntax correctly', () => {
    const log = `python -m vllm.entrypoints.openai.api_server --model Qwen1.5-14B-Chat --max-model-len 8192 --api-key sk-12345`;
    const result = parseServiceLog(log);
    expect(result.model).toBe('Qwen1.5-14B-Chat');
    expect(result.maxModelLen).toBe(8192);
    expect(result.apiKey).toBe('sk-12345');
  });

  it('should use default values if not found', () => {
    const result = parseServiceLog('some random log');
    expect(result.model).toBe('qwen');
    expect(result.maxModelLen).toBe(8192);
    expect(result.apiBase).toBe('http://localhost:8000/v1');
    expect(result.apiKey).toBe('');
  });
});

describe('validateParams', () => {
  it('should clamp values correctly', () => {
    const params = { temperature: 3, top_p: -1, max_tokens: 100000, max_model_len: 32768 };
    const result = validateParams(params);
    expect(result.temperature).toBe(2);
    expect(result.top_p).toBe(0);
    expect(result.max_tokens).toBe(32768);
  });

  it('should apply defaults', () => {
    const result = validateParams({});
    expect(result.temperature).toBe(0.7);
    expect(result.top_p).toBe(0.9);
    expect(result.max_tokens).toBe(1024);
  });
});

describe('parseSSE', () => {
  it('should parse stream data correctly', async () => {
    const encoder = new TextEncoder();
    let streamReadIndex = 0;
    const streamData = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"1","choices":[{"delta":{"content":" World"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const mockReader = {
      read: async () => {
        if (streamReadIndex < streamData.length) {
          return { value: encoder.encode(streamData[streamReadIndex++]), done: false };
        }
        return { done: true };
      },
    };

    const mockBody = {
      getReader: () => mockReader,
    };

    const results = [];
    for await (const chunk of parseSSE(mockBody)) {
      results.push(chunk);
    }

    expect(results.length).toBe(2);
    expect(results[0].choices[0].delta.content).toBe('Hello');
    expect(results[1].choices[0].delta.content).toBe(' World');
  });

  it('should handle partial chunks', async () => {
    const encoder = new TextEncoder();
    let streamReadIndex = 0;
    const streamData = [
      'data: {"id":"1","c',
      'hoices":[{"delta":{"content":"H"}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    const mockReader = {
      read: async () => {
        if (streamReadIndex < streamData.length) {
          return { value: encoder.encode(streamData[streamReadIndex++]), done: false };
        }
        return { done: true };
      },
    };

    const mockBody = {
      getReader: () => mockReader,
    };

    const results = [];
    for await (const chunk of parseSSE(mockBody)) {
      results.push(chunk);
    }

    expect(results.length).toBe(1);
    expect(results[0].choices[0].delta.content).toBe('H');
  });
});
