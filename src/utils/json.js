const resolveThinking = require('@src/utils/thinking.js')

// Extract the first JSON object/array found in a mixed LLM output.
// Tolerant to leading/trailing text and ignores braces inside strings.
const extractFirstJsonBlock = (text) => {
  const len = text.length;
  let start = -1;
  let open = null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < len; i++) {
    const ch = text[i];

    if (start === -1) {
      if (ch === '{' || ch === '[') {
        start = i;
        open = ch;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (open === '{') {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    } else {
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
    }

    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }

  return null;
}

// Fix common "Bad control character" JSON issues from LLMs where raw newlines/tabs
// leak into string literals. Only sanitizes characters while *inside* JSON strings.
const sanitizeControlCharsInJsonStrings = (text) => {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = ch.charCodeAt(0);

    if (!inString) {
      out += ch;
      if (ch === '"') {
        inString = true;
        escaped = false;
      }
      continue;
    }

    // inside string
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      continue;
    }

    // Control chars must be escaped in JSON strings.
    if (code <= 0x1f) {
      if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }

    out += ch;
  }

  return out;
}



const parseJSON = (content) => {
  content = content.trim();
  if (content.startsWith('<think>')) {
    const { thinking: _, content: output } = resolveThinking(content);
    content = output;
  }

  // If the LLM wrapped its output in markdown fences, unwrap them.
  // Supports both ```json and plain ```.
  {
    const startIndex = content.indexOf('```json');
    const fenceStart = startIndex !== -1 ? startIndex : content.indexOf('```');
    const endIndex = content.lastIndexOf('```');
    if (fenceStart !== -1 && endIndex > fenceStart) {
      // Skip the opening fence line (```json or ```).
      const afterFence = content.indexOf('\n', fenceStart);
      if (afterFence !== -1 && afterFence < endIndex) {
        content = content.substring(afterFence + 1, endIndex).trim();
      }
    }
  }

  const tryParse = (text) => {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, err: e };
    }
  }

  if (content === 'ERR_BAD_REQUEST') {
    throw new Error(`Large model call failed`);
  }

  // 1) direct parse
  let res = tryParse(content);
  if (res.ok) return res.value;

  // 2) extract first JSON object/array if content has surrounding text
  const extracted = extractFirstJsonBlock(content);
  if (extracted && extracted !== content) {
    res = tryParse(extracted);
    if (res.ok) return res.value;
  }

  // 3) sanitize control characters within JSON strings (raw newlines/tabs)
  const sanitized = sanitizeControlCharsInJsonStrings(extracted || content);
  if (sanitized !== (extracted || content)) {
    res = tryParse(sanitized);
    if (res.ok) return res.value;
  }

  console.log('JSON parse failed for content:', content);
  throw new Error(`parseJSON failed: ${res.err.message}`);
}

module.exports = exports = parseJSON;