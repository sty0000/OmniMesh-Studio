/**
 * Parses the vLLM service_start_log.txt to extract configuration parameters.
 * @param {string} logText - The content of the log file.
 * @returns {Object} Extracted configuration.
 */
function parseServiceLog(logText) {
  const config = {
    apiBase: 'http://localhost:8000/v1', // default via SSH port forwarding
    model: 'qwen', // default
    maxModelLen: 8192,
    apiKey: '',
  };

  // Extract model name
  // Prefer --served-model-name if it exists, otherwise fallback to --model
  const servedModelMatch = logText.match(/(?:--served-model-name\s+|'served_model_name':\s*\[')([\w./-]+)/i);
  if (servedModelMatch && servedModelMatch[1]) {
    config.model = servedModelMatch[1].replace(/['"]/g, '');
  } else {
    const modelMatch = logText.match(/(?:--model\s+|model=|model\s*[:=]\s*['"]?)([\w./-]+)/i);
    if (modelMatch && modelMatch[1]) {
      config.model = modelMatch[1].replace(/['"]/g, '');
    }
  }

  // Extract max model length
  const maxLenMatch = logText.match(/(?:--max-model-len\s+|max_model_len\s*[=:]?\s*)(\d+)/i);
  if (maxLenMatch && maxLenMatch[1]) {
    config.maxModelLen = parseInt(maxLenMatch[1], 10);
  }

  // Extract API key
  const apiKeyMatch = logText.match(
    /(?:--api-key\s+|api_key\s*[=:]?\s*['"]?)([a-zA-Z0-9-]+)['"]?/i,
  );
  if (apiKeyMatch && apiKeyMatch[1]) {
    config.apiKey = apiKeyMatch[1];
  }

  // Extract Port if available to update apiBase (though localhost:8000 is default)
  const portMatch = logText.match(/(?:--port\s+|port\s*[=:]?\s*)(\d+)/i);
  if (portMatch && portMatch[1]) {
    config.apiBase = `http://localhost:${portMatch[1]}/v1`;
  }

  return config;
}

/**
 * Validates generation parameters.
 * @param {Object} params - The parameters to validate.
 * @returns {Object} Validated and clamped parameters.
 */
function validateParams(params) {
  const { temperature = 0.7, top_p = 0.9, max_tokens = 8192, max_model_len = 65536 } = params;

  return {
    temperature: Math.max(0, Math.min(2, Number(temperature) || 0.7)),
    top_p: Math.max(0, Math.min(1, Number(top_p) || 0.9)),
    max_tokens: Math.max(1, Math.min(max_model_len, Number(max_tokens) || 8192)),
  };
}

/**
 * Parses Server-Sent Events (SSE) from the fetch response body.
 * @param {ReadableStream} body - The response body stream.
 * @returns {AsyncGenerator<Object>} Yields parsed JSON objects.
 */
async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');

    buffer = lines.pop() || ''; // Keep the last incomplete line in the buffer

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') {
          return;
        }
        try {
          const data = JSON.parse(dataStr);
          yield data;
        } catch (e) {
          console.warn('Failed to parse SSE line:', line);
        }
      }
    }
  }

  // Process remaining buffer
  if (buffer.startsWith('data: ')) {
    const dataStr = buffer.slice(6).trim();
    if (dataStr !== '[DONE]') {
      try {
        const data = JSON.parse(dataStr);
        yield data;
      } catch (e) {
        console.warn('Failed to parse SSE buffer:', buffer);
      }
    }
  }
}

/**
 * Formats a Date object to YYYY-MM-DD HH:mm:ss
 * @param {Date} date - The date to format
 * @returns {string} Formatted date string
 */
function formatCurrentTime(date = new Date()) {
  const pad = (n) => n.toString().padStart(2, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${YYYY}-${MM}-${DD} ${HH}:${mm}:${ss}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseServiceLog, validateParams, parseSSE, formatCurrentTime };
}
