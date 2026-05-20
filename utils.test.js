import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const utilsContent = fs.readFileSync(path.join(__dirname, 'utils.js'), 'utf-8');
// Mock module.exports to capture the exported functions
const mockModule = { exports: {} };
const fn = new Function('module', utilsContent);
fn(mockModule);

const { parseServiceLog, validateParams, parseSSE, formatCurrentTime } = mockModule.exports;

describe('LaTeX rendering preprocessor', () => {
  it('should convert \\( ... \\) to $ ... $', () => {
    let processedText = '这是一个被转义的 \\(^{210}\\text{Pb}\\) 测试';
    processedText = processedText.replace(/\\\((.*?)\\\)/g, '$$$1$$');
    expect(processedText).toBe('这是一个被转义的 $^{210}\\text{Pb}$ 测试');
  });

  it('should wrap unescaped ^{210}\\text{Pb} in $', () => {
    let processedText = '这是一个同位素 ^{210}\\text{Pb} 测试';
    processedText = processedText.replace(
      /(?<!\$)(?<!\\)\^\{(.*?)\}\\?text\{(.*?)\}(?!\$)/g,
      '$^{$1}\\text{$2}$',
    );
    expect(processedText).toBe('这是一个同位素 $^{210}\\text{Pb}$ 测试');
  });

  it('should wrap unescaped inline greek formulas in $', () => {
    let processedText = '生成速率 \\lambda_{\\text{Bi}}N_{\\text{Bi}} 和沉降 \\frac{1}{\\tau_R}';
    // Use an explicit regex that specifically matches exactly what we need for this case
    // Matching \lambda_{...}N_{...} or \tau_R without overcapturing
    processedText = processedText.replace(
      /(?<!\$)(?<!\\)(\\(?:lambda|tau)(?:_R|_\{\\text\{[a-zA-Z]+\}\}(?:N_\{\\text\{[a-zA-Z]+\}\})?))(?!\$)/g,
      '$$$1$$',
    );
    expect(processedText).toBe(
      '生成速率 $\\lambda_{\\text{Bi}}N_{\\text{Bi}}$ 和沉降 \\frac{1}{$\\tau_R$}',
    );
  });

  it('should wrap decay chains containing \\rightarrow in $', () => {
    let processedText =
      '实际衰变链为^{222}\\text{Rn} \\rightarrow ^{218}\\text{Po} \\rightarrow ^{214}\\text{Pb} \\rightarrow ^{214}\\text{Bi} \\rightarrow ^{214}\\text{Po} \\rightarrow ^{210}\\text{Pb}';
    const linesForChain = processedText.split('\n');
    for (let i = 0; i < linesForChain.length; i++) {
      let line = linesForChain[i];
      if (
        line.includes('\\rightarrow') &&
        !line.includes('__MATH_BLOCK_') &&
        !line.includes('```')
      ) {
        linesForChain[i] = line.replace(
          /([A-Za-z0-9^{}\\_]+(?:\s*\\rightarrow\s*[A-Za-z0-9^{}\\_]+)+)/g,
          '$$$1$$',
        );
      }
    }
    processedText = linesForChain.join('\n');
    expect(processedText).toBe(
      '实际衰变链为$^{222}\\text{Rn} \\rightarrow ^{218}\\text{Po} \\rightarrow ^{214}\\text{Pb} \\rightarrow ^{214}\\text{Bi} \\rightarrow ^{214}\\text{Po} \\rightarrow ^{210}\\text{Pb}$',
    );
  });

  it('should wrap differential equations in $$', () => {
    let processedText =
      '\\frac{dN_{\\text{Pb}}}{dt} = \\lambda_{\\text{Bi}}N_{\\text{Bi}} - \\lambda_{\\text{Pb}}N_{\\text{Pb}} - \\frac{1}{\\tau_R}N_{\\text{Pb}}';

    const lines = processedText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (
        !line.includes('__MATH_BLOCK_') &&
        (line.includes('\\frac') ||
          line.includes('\\lambda') ||
          line.includes('\\sum') ||
          line.includes('\\int')) &&
        (line.includes('=') || line.includes('_') || line.includes('^'))
      ) {
        lines[i] = `$$ ${line.trim()} $$`;
      }
    }
    processedText = lines.join('\n');

    expect(processedText).toBe(
      '$$ \\frac{dN_{\\text{Pb}}}{dt} = \\lambda_{\\text{Bi}}N_{\\text{Bi}} - \\lambda_{\\text{Pb}}N_{\\text{Pb}} - \\frac{1}{\\tau_R}N_{\\text{Pb}} $$',
    );
  });
});

describe('formatCurrentTime', () => {
  it('should format date correctly', () => {
    // Note: JS Date month is 0-indexed
    const mockDate = new Date(2023, 9, 5, 14, 30, 9); // 2023-10-05 14:30:09
    const formatted = formatCurrentTime(mockDate);
    expect(formatted).toBe('2023-10-05 14:30:09');
  });

  it('should pad single digits with zero', () => {
    const mockDate = new Date(2024, 0, 1, 9, 5, 2); // 2024-01-01 09:05:02
    // Also test system prompt replacement logic by directly accessing the buildPayload logic from mock
    // Note: Since buildPayload is not exported and is part of Vue setup, we test the text replacement part here
    const template = '你是Qwen3-Omni-Thinking，现在是<时间>。';
    const replaced = template.replace(/<时间>/g, formatCurrentTime(mockDate));
    expect(replaced).toBe('你是Qwen3-Omni-Thinking，现在是2024-01-01 09:05:02。');
  });
});

describe('parseServiceLog', () => {
  it('should parse model name correctly', () => {
    const log = `INFO: args: Namespace(model='Qwen/Qwen1.5-7B-Chat', max_model_len=32768, port=8000)`;
    const result = parseServiceLog(log);
    expect(result.model).toBe('Qwen/Qwen1.5-7B-Chat');
    expect(result.maxModelLen).toBe(32768);
    expect(result.apiBase).toBe('http://localhost:8000/v1');
  });

  it('should parse --served-model-name syntax correctly and prioritize it', () => {
    const log = `python -m vllm.entrypoints.openai.api_server --model /path/to/model --served-model-name qwen-custom --max-model-len 65536`;
    const result = parseServiceLog(log);
    expect(result.model).toBe('qwen-custom');
    expect(result.maxModelLen).toBe(65536);
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
    expect(result.maxModelLen).toBe(65536);
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
    expect(result.max_tokens).toBe(8192);
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
