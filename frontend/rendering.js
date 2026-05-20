export const setupMarkedRenderer = ({ marked, windowObj }) => {
  const renderer = new marked.Renderer();
  const originalCodeRenderer = renderer.code.bind(renderer);

  renderer.code = function (code, language, isEscaped) {
    const rawHtml = originalCodeRenderer(code, language, isEscaped);
    const langLabel = language ? language : 'code';
    const headerHtml = `
            <div class="code-header">
                <span>${langLabel}</span>
                <button class="code-copy-btn" onclick="copyCodeBlock(this)">
                    <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path></svg>
                    <span>复制</span>
                </button>
            </div>
        `;

    return rawHtml.replace(/^<pre>/i, `<pre>${headerHtml}`);
  };

  marked.use({ renderer });

  windowObj.copyCodeBlock = function (btn) {
    const pre = btn.closest('pre');
    if (!pre) return;
    const codeEl = pre.querySelector('code');
    if (!codeEl) return;

    navigator.clipboard
      .writeText(codeEl.innerText)
      .then(() => {
        const span = btn.querySelector('span');
        const originalText = span.innerText;
        span.innerText = '已复制!';
        btn.style.color = '#10b981';
        setTimeout(() => {
          span.innerText = originalText;
          btn.style.color = '';
        }, 2000);
      })
      .catch((err) => {
        console.error('Copy failed:', err);
      });
  };
};

export const createMarkdownHelpers = ({ marked, renderMathInElement, DOMPurify }) => {
  const preprocessMarkdownText = (text) => {
    let processedText = text;
    const mathBlocks = [];
    let placeholderIndex = 0;
    const mathPlaceholderPrefix = '@@MATH_BLOCK_';

    const normalizeFeynmanSlash = (inputText, inMath = false) => {
      if (!inputText) return inputText;
      let normalized = inputText;

      normalized = normalized.replace(/\\slashed\s*\{\s*([A-Za-z])\s*\}/g, '\\slashed{$1}');
      normalized = normalized.replace(
        /(^|[^A-Za-z\\])([A-Za-z])\s*(?:(?:\\!\s*){1,}|!{2,})\/+?/g,
        (match, prefix, symbol) => `${prefix}\\slashed{${symbol}}`,
      );
      if (inMath) {
        normalized = normalized.replace(/\/\s+/g, '/');
      }
      return normalized;
    };

    processedText = processedText.replace(
      /(\$\$[\s\S]*?\$\$|\$[^\n$]+\$|\\\[[\s\S]*?\\\])/g,
      (match) => {
        mathBlocks.push(normalizeFeynmanSlash(match, true));
        return `${mathPlaceholderPrefix}${placeholderIndex++}@@`;
      },
    );

    const isFenceOpen = (lineText) => {
      const matches = lineText.match(/```/g);
      return matches ? matches.length % 2 === 1 : false;
    };

    const wrapSlashMathOutsideMathBlocks = (lineText) => {
      let line = normalizeFeynmanSlash(lineText);

      line = line.replace(
        /(^|[^$\\])(\\slashed\{[A-Za-z]\})(?!\$)/g,
        (match, prefix, slashExpr) => `${prefix}$${slashExpr}$`,
      );

      line = line.replace(
        /(^|[^$\\])([A-Za-z]\s*(?:(?:\\!\s*){1,}|!{2,})\/+?)(?!\$)/g,
        (match, prefix, rawExpr) => {
          const normalizedExpr = normalizeFeynmanSlash(rawExpr).replace(/\$/g, '').trim();
          const symbolMatch = normalizedExpr.match(/\\slashed\{([A-Za-z])\}/);
          if (!symbolMatch) return match;
          return `${prefix}$\\slashed{${symbolMatch[1]}}$`;
        },
      );

      return line;
    };

    const plainLines = processedText.split('\n');
    let inPlainCodeFence = false;
    for (let i = 0; i < plainLines.length; i++) {
      const line = plainLines[i];
      const lineFenceOpen = isFenceOpen(line);

      if (!inPlainCodeFence && !line.includes('@@MATH_BLOCK_')) {
        plainLines[i] = wrapSlashMathOutsideMathBlocks(line);
      }

      if (lineFenceOpen) {
        inPlainCodeFence = !inPlainCodeFence;
      }
    }
    processedText = plainLines.join('\n');

    processedText = processedText.replace(
      /(?<!\$)(?<!\\)\^\{(.*?)\}\\?text\{(.*?)\}(?!\$)/g,
      '$^{$1}\\text{$2}$',
    );

    processedText = processedText.replace(
      /(?<!\$)(?<!\\)(\\(?:lambda|tau)(?:_R|_\{\\text\{[a-zA-Z]+\}\}(?:N_\{\\text\{[a-zA-Z]+\}\})?))(?!\$)/g,
      '$$$1$$',
    );

    const lines = processedText.split('\n');
    let inCodeFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineFenceOpen = isFenceOpen(line);

      if (!inCodeFence) {
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

      if (lineFenceOpen) {
        inCodeFence = !inCodeFence;
      }
    }
    processedText = lines.join('\n');

    const linesForChain = processedText.split('\n');
    let inChainCodeFence = false;
    for (let i = 0; i < linesForChain.length; i++) {
      const line = linesForChain[i];
      const lineFenceOpen = isFenceOpen(line);
      if (
        !inChainCodeFence &&
        line.includes('\\rightarrow') &&
        !line.includes('__MATH_BLOCK_') &&
        !line.includes('```')
      ) {
        linesForChain[i] = line.replace(
          /([A-Za-z0-9^{}\\_]+(?:\s*\\rightarrow\s*[A-Za-z0-9^{}\\_]+)+)/g,
          '$$$1$$',
        );
      }
      if (lineFenceOpen) {
        inChainCodeFence = !inChainCodeFence;
      }
    }
    processedText = linesForChain.join('\n');

    return { processedText, mathBlocks };
  };

  const katexOptions = {
    throwOnError: false,
    displayMode: false,
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
    ],
  };

  const renderMarkdownSegment = (text) => {
    const { processedText, mathBlocks } = preprocessMarkdownText(text);
    let html = marked.parse(processedText);

    for (let i = 0; i < mathBlocks.length; i++) {
      const token = `@@MATH_BLOCK_${i}@@`;
      html = html.split(token).join(mathBlocks[i]);
    }

    html = DOMPurify.sanitize(html);

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    if (renderMathInElement) {
      renderMathInElement(tempDiv, katexOptions);
    }
    return tempDiv.innerHTML;
  };

  const splitMarkdownSegments = (text) => {
    return text.split(/(```[\s\S]*?```)/g);
  };

  return {
    preprocessMarkdownText,
    renderMarkdownSegment,
    splitMarkdownSegments,
    katexOptions,
  };
};
