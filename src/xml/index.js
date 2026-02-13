const { parseXML } = require('./resolve.xml.optimize.js');

// Debug flag (enabled by default)
const DEBUG_LLM_XML_NORMALIZE = true;
const DEBUG_LLM_XML_NORMALIZE_PREFIX = '[xml/normalizeOpenAI]';

const truncateForLog = (s, max = 240) => {
  try {
    const str = String(s ?? '');
    if (str.length <= max) return str;
    return str.slice(0, max) + `… (truncated, len=${str.length})`;
  } catch (_) {
    return '[unprintable]';
  }
};

// Decode XML attribute-escaped text (best effort).
// Note: XML attributes may contain entities like &quot; &amp; &lt; etc.
const unescapeXmlAttr = (s) =>
  String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/**
 * Normalize non-XML / OpenAI-style tool call outputs into LemonAI XML.
 *
 * Supported families:
 * 1) "<|channel|>tool<|message|><tool>...</tool>"  -> strip prefix, keep XML
 * 2) "<tool_name<|message|>{ ...json... }"         -> convert JSON to <tool_name>...</tool_name>
 * 3) JSON objects containing tool calls:
 *    - {"type":"tool_call","name":"read_file","arguments":"{...}"}
 *    - {"name":"read_file","arguments":{...}}
 *    - {"tool_calls":[{"function":{"name":"read_file","arguments":"{...}"}}]}
 *    - {"choices":[{"message":{"tool_calls":[{"function":{...}}]}}]} (some gateways)
 *
 * The goal is to be permissive, but safe:
 * - If we can't confidently infer a tool name + arguments, we return the original content.
 * - If we produce XML, parseXML() remains the source of truth.
 */
const TOOL_TYPES = new Set([
  'finish',
  'patch_code',
  'write_code',
  'replace_code_block',
  'write_file',
  'read_file',
  'revise_plan',
  'terminal_run',
  'web_search',
  'read_url',
  'browser',
  'mcp_tool',
  'evaluation',
  'document_query',
  'document_upload',
  'patch_complete', // local orchestrator action (appears in XML sometimes)
  'information', // local orchestrator action (log-only, no runtime/sandbox)
]);

const escapeXmlText = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const toCData = (s) => `<![CDATA[${String(s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;

// Best-effort CDATA unwrap:
// - handles standard: <![CDATA[...]]>
// - handles split CDATA produced by toCData(): ...]]]]><![CDATA[>...
// - tolerates truncated log-like form: [CDATA[...]] (missing "<!")
const unwrapCDataBestEffort = (input) => {
  if (input === undefined || input === null) return '';
  const s = String(input);

  // Standard / repeated CDATA blocks
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m;
  let acc = '';
  while ((m = re.exec(s)) !== null) acc += m[1];
  if (acc) return acc;

  // Truncated CDATA form sometimes seen in logs: [CDATA[...]]
  const t = s.trim();
  if (t.startsWith('[CDATA[') && (t.endsWith(']]') || t.endsWith(']]>'))) {
    return t
      .replace(/^\[CDATA\[/, '')
      .replace(/\]\]>?$/, '')
      .replace(/\]\]$/, '');
  }

  // Not CDATA
  return s;
};


const isPlainObject2 = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const extractBalancedJsonObject = (text) => {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return null;
};

const safeJsonParse = (s) => {
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
};

const inferToolCallFromOpenAIJson = (obj) => {
  if (!obj) return null;

  // A) Simple shapes: {type,name,arguments} or {name,arguments}
  // Also accept: {name, params} (some gateways / models emit "params" instead of "arguments")
  if (typeof obj.name === 'string' && obj.params !== undefined && obj.arguments === undefined) {
    return { name: obj.name, arguments: obj.params };
  }

  if (typeof obj.name === 'string' && (obj.arguments !== undefined)) {
    return { name: obj.name, arguments: obj.arguments };
  }
  if (typeof obj.type === 'string' && obj.type === 'tool_call' && typeof obj.name === 'string') {
    return { name: obj.name, arguments: obj.arguments };
  }
  
  // A2) LM Studio / OpenAI-like variant: {name, params}
  // Example: {"name":"read_file","params":{"path":"test_ttt.py"}}
  if (typeof obj.name === 'string' && (obj.params !== undefined)) {
    return { name: obj.name, arguments: obj.params };
  }

  // B) OpenAI ChatCompletions-like: {tool_calls:[{function:{name,arguments}}]}
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
    const tc = obj.tool_calls[0];
    const fn = tc && tc.function;
    if (fn && typeof fn.name === 'string') return { name: fn.name, arguments: fn.arguments };
  }

  // C) Nested gateway: {choices:[{message:{tool_calls:[...]}}]}
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const msg = obj.choices[0] && obj.choices[0].message;
    if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const fn = msg.tool_calls[0] && msg.tool_calls[0].function;
      if (fn && typeof fn.name === 'string') return { name: fn.name, arguments: fn.arguments };
    }
  }

  // D) Responses-like: {output:[{type:"tool_call",name,arguments}]}
  if (Array.isArray(obj.output) && obj.output.length > 0) {
    const first = obj.output.find((x) => x && x.type === 'tool_call' && typeof x.name === 'string');
    if (first) return { name: first.name, arguments: first.arguments };
  }

  return null;
};

const normalizeArgumentsObject = (args) => {
  // arguments can be:
  // - object
  // - JSON string representing an object
  // - already malformed (we keep as-is)
  if (args === undefined || args === null) return {};
  if (typeof args === 'string') {
    const trimmed = args.trim();
    const parsed = safeJsonParse(trimmed);
    if (parsed && isPlainObject2(parsed)) return parsed;
    // If it's a string but not JSON, keep it as a single field "value"
    // (better than losing it; parseXML will likely reject unknown schema anyway)
    return { value: trimmed };
  }
  if (isPlainObject2(args)) return args;
  return { value: args };
};

const jsonArgsToXmlInner = (toolName, argsObj) => {
  const parts = [];
  for (const [k, v] of Object.entries(argsObj || {})) {
    // For known multi-line payload fields, always CDATA
    const isPayload =
      (toolName === 'write_code' || toolName === 'write_file') && k === 'content' ||
      toolName === 'replace_code_block' && k === 'code_block' ||
      toolName === 'patch_code' && k === 'diff' ||
      toolName === 'information' && k === 'message' ||
      toolName === 'patch_complete' && k === 'message';

    if (v === undefined || v === null) {
      parts.push(`<${k}></${k}>`);
      continue;
    }

    if (typeof v === 'string') {
      parts.push(
        isPayload
          ? `<${k}>${toCData(v)}</${k}>`
          : `<${k}>${escapeXmlText(v)}</${k}>`
      );
      continue;
    }

    if (typeof v === 'number' || typeof v === 'boolean') {
      parts.push(`<${k}>${escapeXmlText(String(v))}</${k}>`);
      continue;
    }

    // objects/arrays -> preserve as JSON inside CDATA to avoid XML ambiguity
    try {
      parts.push(`<${k}>${toCData(JSON.stringify(v))}</${k}>`);
    } catch (_) {
      parts.push(`<${k}>${toCData(String(v))}</${k}>`);
    }
  }
  return parts.join('');
};

const convertToolCallToXml = (toolName, rawArgs) => {
  const name = String(toolName || '').trim();
  if (!name) return null;
  if (!TOOL_TYPES.has(name)) return null;

  const argsObj = normalizeArgumentsObject(rawArgs);

  // Heuristic: some models put the full command line into terminal_run.command
  // Example: { "command": "python3 test_ttt.py", "cwd": "" }
  // Convert to: { command: "python3", args: "test_ttt.py" } if args is missing.
  if (name === 'terminal_run' && argsObj && typeof argsObj.command === 'string') {
    const cmd = argsObj.command.trim();
    const hasArgs = Object.prototype.hasOwnProperty.call(argsObj, 'args') && argsObj.args !== undefined;
    if (!hasArgs && /\s/.test(cmd)) {
      const firstSpace = cmd.search(/\s/);
      const c = cmd.slice(0, firstSpace).trim();
      const a = cmd.slice(firstSpace).trim();
      if (c) argsObj.command = c;
      if (a) argsObj.args = a;
    }
  }

  const inner = jsonArgsToXmlInner(name, argsObj);
  return `<${name}>${inner}</${name}>`;
};

const normalizeLLMToolOutputToXML = (raw) => {
  if (!raw || typeof raw !== 'string') return raw;
  const content = raw.trim();
  if (!content) return raw;
  
  // 0) Accept attribute-style <finish .../> (self-closing) and convert to canonical LemonAI XML.
  // Example:
  //   <finish status="SUCCESS" message="..."/>
  // -> <finish><status>SUCCESS</status><message><![CDATA[...]]></message></finish>
  //
  // Also supports: <finish status="SUCCESS" message="..."></finish>
  // This must happen early so downstream parseXML() sees the expected child tags.
  const finishAttrSelfClosing = content.match(/^<\s*finish\b([\s\S]*?)\/\s*>\s*$/i);
  const finishAttrPaired = content.match(/^<\s*finish\b([\s\S]*?)>\s*<\/\s*finish\s*>\s*$/i);
  const finishAttrMatch = finishAttrSelfClosing || finishAttrPaired;
  if (finishAttrMatch) {
    const attrsRaw = finishAttrMatch[1] ?? '';
    const attrs = {};
    // Parse attributes: key="value" OR key='value'
    const attrRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = attrRe.exec(attrsRaw)) !== null) {
      const k = m[1];
      const v = m[2] !== undefined ? m[2] : (m[3] ?? '');
      attrs[k] = unescapeXmlAttr(v);
    }
    // Only convert if we actually have at least one meaningful attr (status/message),
    // otherwise keep the original to avoid damaging non-standard uses.
    const status = (attrs.status ?? '').trim();
    const message = (attrs.message ?? '').toString();
    if (status || message) {
      const st = status || 'SUCCESS';
      const msg = message ?? '';
      return `<finish><status>${escapeXmlText(st)}</status><message>${toCData(msg)}</message></finish>`;
    }
  }
  
  // 0) Pattern: "<|channel|>tool_call{...}" (no <|message|>, "params" instead of "arguments")
  // Example:
  //   <|channel|>tool_call{
  //     "name":"read_file",
  //     "params":{"path":"test_ttt.py"}
  //   }
  //
  // We extract the JSON and map params -> arguments.
  if (content.startsWith('<|channel|>tool_call')) {
    const jsonStr = extractBalancedJsonObject(content);
    if (jsonStr) {
      const parsed = safeJsonParse(jsonStr);
      if (parsed) {
        const tc = inferToolCallFromOpenAIJson(parsed);
        if (tc) {
          const xml = convertToolCallToXml(tc.name, tc.arguments);
          if (xml) return xml;
        }
      }
    }
  }
  
  // 0b) Pattern: "<|channel|>TOOL{...}" where TOOL is the tool name and JSON is params.
  // Example:
  //   We need read file.<|channel|>read_file{
  //     "path": "ttt.py"
  //   }
  //
  // Here the JSON does NOT contain {name,arguments}; the tool name is in the wrapper.
  const channelToolJsonMatch = content.match(/<\|channel\|>\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/);
  if (channelToolJsonMatch && channelToolJsonMatch[1] && TOOL_TYPES.has(channelToolJsonMatch[1])) {
    const toolName = channelToolJsonMatch[1];
    const jsonStr = extractBalancedJsonObject(content);
    if (jsonStr) {
      const parsed = safeJsonParse(jsonStr);
      if (parsed) {
        const xml = convertToolCallToXml(toolName, parsed);
        if (xml) return xml;
      }
    }
  }

  // 1) "<|channel|>...<|message|>...." wrappers
  // Keep what comes after <|message|>
  const msgIdx = content.indexOf('<|message|>');
  if (msgIdx >= 0) {
	const before = content.slice(0, msgIdx);
    const after = content.slice(msgIdx + '<|message|>'.length).trim();

    // If the wrapper tells us the tool name, but the "after" XML is missing the root tool tag
    // (e.g. "<path>...</path><content>...</content></write_code>"), wrap it.
    const toMatch = before.match(/\bto\s*=\s*([a-zA-Z_][a-zA-Z0-9_]*)\b/);
    const channelToolMatch = before.match(/<\|channel\|>\s*([a-zA-Z_][a-zA-Z0-9_]*)\b/);
    const hintedTool =
      (toMatch && toMatch[1]) ? toMatch[1] :
      (channelToolMatch && channelToolMatch[1]) ? channelToolMatch[1] :
      null;

    if (after.startsWith('<') && hintedTool && TOOL_TYPES.has(hintedTool)) {
      const toolName = hintedTool;
      const openTagRe = new RegExp(`^<\\s*${toolName}\\b`, 'i');
      if (!openTagRe.test(after)) {
        // Avoid double-closing if the model already included </toolName>
        const closeTagRe = new RegExp(`</\\s*${toolName}\\s*>\\s*$`, 'i');
        const inner = closeTagRe.test(after) ? after.replace(closeTagRe, '').trim() : after;
        return `<${toolName}>${inner}</${toolName}>`;
      }
      return after;
    }

    if (after.startsWith('<')) return after;

    // could still be JSON after <|message|>
    const j = extractBalancedJsonObject(after);
    if (j) {
      const parsed = safeJsonParse(j);

      // IMPORTANT: many models emit tool name only in the wrapper: "to=write_code"
      // and the JSON after <|message|> contains ONLY the params:
      //   <|channel|>commentary to=write_code code<|message|>{"path":"ttt.py","content":"..."}
      // In this case we must use the hinted tool name from the prefix.
      if (hintedTool && TOOL_TYPES.has(hintedTool) && parsed) {
        const xml = convertToolCallToXml(hintedTool, parsed);
        if (xml) return xml;
      }

      // Otherwise try to infer OpenAI-like JSON tool_call shapes (name/arguments, tool_calls, etc.)
      const tc = inferToolCallFromOpenAIJson(parsed);
      if (tc) {
        const xml = convertToolCallToXml(tc.name, tc.arguments);
        if (xml) return xml;
      }
    }
  }

  // 2) Pattern: "<toolName<|message|>{...}"
  // Example: "<terminal_run<|message|>{ ... }"
  const m = content.match(/^<\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*<\|message\|>\s*/);
  if (m && m[1]) {
    const toolName = m[1];
    const jsonStr = extractBalancedJsonObject(content);
    if (jsonStr) {
      const parsed = safeJsonParse(jsonStr);
      if (parsed) {
        const xml = convertToolCallToXml(toolName, parsed);
        if (xml) return xml;
      }
    }
  }  
  
  // 2c) Pattern: "<toolName> { ...json... } </toolName>" (JSON in XML body)
  // Example:
  //   <terminal_run>
  //   {
  //     "command": "python3",
  //     "args": "...",
  //     "cwd": ""
  //   }
  //   </terminal_run>
  //
  // The XML is well-formed but does not contain <command>/<args> child tags, so downstream validation fails.
  // We extract the JSON from the body and convert it into canonical XML.
  const mBody = content.match(/^<\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*>\s*([\s\S]*?)\s*<\/\s*\1\s*>\s*$/);
  if (mBody && mBody[1] && TOOL_TYPES.has(mBody[1])) {
    const toolName = mBody[1];
    const body = (mBody[2] ?? '').trim();

    // Only attempt if the body looks like JSON (avoid touching normal XML with nested tags)
    // (The JSON may be preceded by whitespace/newlines in the raw logs.)
    if (body.startsWith('{')) {
      const jsonStr = extractBalancedJsonObject(body);
      if (jsonStr) {
        const parsed = safeJsonParse(jsonStr);
        if (parsed) {
          const xml = convertToolCallToXml(toolName, parsed);
          if (xml) return xml;
        }
      }
    }
  }

  // 2b) Pattern: "<toolName>\n{...json...}\n" with missing closing tag
  // Example:
  //   <terminal_run>
  //   { "command": "python3 test_ttt.py", "cwd": "" }
  //
  // We convert JSON to canonical <terminal_run>...</terminal_run>.
  const m2 = content.match(/^<\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*>\s*/);
  if (m2 && m2[1] && TOOL_TYPES.has(m2[1])) {
    const toolName = m2[1];
    // Only attempt this repair if the close tag is absent (unterminated) AND we can find a JSON object.
    const closeTag = `</${toolName}>`;
    if (!content.includes(closeTag)) {
      const jsonStr = extractBalancedJsonObject(content);
      if (jsonStr) {
        const parsed = safeJsonParse(jsonStr);
        if (parsed) {
          const xml = convertToolCallToXml(toolName, parsed);
          if (xml) return xml;
        }
      }
    }
  }

  // 3) Pure (or mixed) JSON that contains a tool call
  const jsonCandidate = extractBalancedJsonObject(content);
  if (jsonCandidate) {
    const parsed = safeJsonParse(jsonCandidate);
    if (parsed) {
      const tc = inferToolCallFromOpenAIJson(parsed);
      if (tc) {
        const xml = convertToolCallToXml(tc.name, tc.arguments);
        if (xml) return xml;
      }
    }
  }

  // 4) Already XML (best effort): keep as-is
  return raw;
};

/**
 * Extract multiple XML tool-call blocks from a raw LLM output string.
 *
 * Requirements:
 * - tolerate arbitrary text before/between/after tool XML blocks
 * - tolerate concatenated tool blocks: </toolA><toolB>...
 * - best-effort handling of CDATA so we don't accidentally match a closing tag inside payloads
 *
 * This function does NOT validate the XML; it only slices likely tool blocks.
 */
const stripOpenAIMessageWrapper = (raw) => {
  if (typeof raw !== 'string') return raw;
  const idx = raw.indexOf('<|message|>');
  if (idx < 0) return raw;
  return raw.slice(idx + '<|message|>'.length);
};

const readTagNameAt = (s, ltIndex) => {
  // Expects s[ltIndex] === '<'
  // Returns { name, isClosing, isSelfClosing, tagEnd } or null
  const n = s.length;
  let i = ltIndex + 1;
  if (i >= n) return null;

  // Skip whitespace
  while (i < n && /\s/.test(s[i])) i++;
  if (i >= n) return null;

  // Comments / declarations / CDATA
  if (s.startsWith('<!--', ltIndex) || s.startsWith('<?', ltIndex) || s.startsWith('<!', ltIndex)) {
    return null;
  }

  let isClosing = false;
  if (s[i] === '/') {
    isClosing = true;
    i++;
    while (i < n && /\s/.test(s[i])) i++;
  }

  // Read name
  const start = i;
  if (i >= n || !/[a-zA-Z_]/.test(s[i])) return null;
  i++;
  while (i < n && /[a-zA-Z0-9_]/.test(s[i])) i++;
  const name = s.slice(start, i);
  if (!name) return null;

  // Find end of tag '>'
  let tagEnd = s.indexOf('>', i);
  if (tagEnd < 0) return null;

  // Determine self-closing ( ... /> )
  let j = tagEnd - 1;
  while (j > ltIndex && /\s/.test(s[j])) j--;
  const isSelfClosing = !isClosing && s[j] === '/';

  return { name, isClosing, isSelfClosing, tagEnd };
};

const findClosingTagOutsideCData = (s, fromIndex, toolName) => {
  // Returns index of the first char of the closing tag "</toolName>"
  const close = `</${toolName}>`;
  let i = fromIndex;
  let inCData = false;
  while (i < s.length) {
    if (!inCData) {
      const cdataStart = s.indexOf('<![CDATA[', i);
      const closeIdx = s.indexOf(close, i);
      if (closeIdx < 0) return -1;
      if (cdataStart >= 0 && cdataStart < closeIdx) {
        inCData = true;
        i = cdataStart + '<![CDATA['.length;
        continue;
      }
      return closeIdx;
    } else {
      const cdataEnd = s.indexOf(']]>', i);
      if (cdataEnd < 0) return -1;
      inCData = false;
      i = cdataEnd + ']]>'.length;
    }
  }
  return -1;
};

const extractToolXmlBlocks = (raw) => {
  if (typeof raw !== 'string') return [];

  // Keep behavior that already works: allow text around XML.
  // Also allow OpenAI wrapper, but DO NOT trim because we need indices to cut blocks.
  const s = stripOpenAIMessageWrapper(raw);
  const blocks = [];

  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;

    const tag = readTagNameAt(s, lt);
    if (!tag) {
      i = lt + 1;
      continue;
    }

    // We only start blocks on known tool tags that are opening (not closing)
    if (tag.isClosing || !TOOL_TYPES.has(tag.name)) {
      i = tag.tagEnd + 1;
      continue;
    }

    const toolName = tag.name;

    // Self-closing tool tag: <patch_complete/>
    if (tag.isSelfClosing) {
      const start = lt;
      const end = tag.tagEnd + 1;
      blocks.push({
        toolName,
        xml: s.slice(start, end),
        start,
        end,
      });
      i = end;
      continue;
    }

    // Normal tool tag: find matching closing tag (best-effort, skipping CDATA)
    const closeIdx = findClosingTagOutsideCData(s, tag.tagEnd + 1, toolName);
    if (closeIdx < 0) {
      // Unterminated: create an "invalid" pseudo-block covering until end.
      // Important: we MUST NOT stop at the next '<' because inner tags (e.g. <path>, <content>)
      // would truncate the snippet and produce misleading diagnostics.
      const end = s.length;
      blocks.push({
        toolName,
        xml: s.slice(lt, end),
        start: lt,
        end,
        error: `Unterminated <${toolName}> (missing </${toolName}>)`,
      });
      i = end;
      continue;
    }

    const closeEnd = s.indexOf('>', closeIdx);
    if (closeEnd < 0) {
      const end = s.length;
      blocks.push({
        toolName,
        xml: s.slice(lt, end),
        start: lt,
        end,
        error: `Invalid closing tag for </${toolName}> (missing '>')`,
      });
      i = end;
      continue;
    }

    const start = lt;
    const end = closeEnd + 1;
    blocks.push({
      toolName,
      xml: s.slice(start, end),
      start,
      end,
    });
    i = end;
  }

  return blocks;
};

/**
 * Resolve <information> blocks without relying on parseXML().
 *
 * Rationale:
 * - "information" is a LOCAL log-only tool.
 * - We want <information> to NEVER become an "Invalid tool call" even if XML parsing fails
 *   (or if the XML resolver expects a different schema like <content>).
 */
const resolveInformationActionBestEffort = (xml) => {
  try {
    const s = String(xml ?? '');

    // Self-closing: <information/>
    if (/^<\s*information\b[^>]*\/\s*>\s*$/i.test(s.trim())) {
      return { type: 'information', params: {} };
    }

    // Extract <message>...</message> (may contain CDATA)
    const m = s.match(/<\s*message\b[^>]*>([\s\S]*?)<\s*\/\s*message\s*>/i);
    if (!m) return { type: 'information', params: {} };

    const rawInner = m[1] ?? '';
    const msg = unwrapCDataBestEffort(rawInner);
    return { type: 'information', params: { message: msg } };
  } catch (_) {
    return { type: 'information', params: {} };
  }
};

const buildInvalidToolCallAction = (reason, rawSnippet) => {
  // Use a supported tool type so it can be safely injected/executed.
  // code-act will decide how to render/inject it in history.
  return {
    type: 'evaluation',
    params: {
      status: 'failure',
      comments:
        `Invalid tool call: ${String(reason || 'unknown error')}\n` +
        `raw:\n${String(rawSnippet || '').slice(0, 5000)}`,
    },
  };
};

/**
 * New entry-point for code-act: accept raw LLM output (may contain multiple tool calls),
 * return an ordered list of actions. Invalid blocks become "evaluation failure" actions.
 */
const resolveActionsFromLLMOutput = (raw) => {
  if (!raw || typeof raw !== 'string') return [];

  // First: normalize OpenAI/JSON shapes if it looks like a single tool call.
  // If it yields a single XML root, the extractor will still return one block.
  const normalized = normalizeLLMToolOutputToXML(raw);

  const blocks = extractToolXmlBlocks(typeof normalized === 'string' ? normalized : raw);
  if (!blocks.length) {
    // Fallback: try legacy single-XML path (keeps existing behavior)
    const legacy = resolveActions(typeof normalized === 'string' ? normalized : raw);
    return Array.isArray(legacy) ? legacy : [];
  }

  const out = [];
  for (const b of blocks) {
    if (b && b.error) {
      out.push(buildInvalidToolCallAction(b.error, b.xml));
      continue;
    }
	
    // information is log-only; resolve it without parseXML() to avoid fragile schema issues.
    if (b && b.toolName === 'information') {
      out.push(resolveInformationActionBestEffort(b.xml));
      continue;
    }

    const one = resolveActions(b.xml);
    if (!one || !Array.isArray(one) || one.length !== 1) {
      out.push(
        buildInvalidToolCallAction(
          `Could not resolve a single action from <${b.toolName}> block`,
          b.xml
        )
      );
      continue;
    }

    out.push(one[0]);
  }

  return out;
};



/**
 * terminal_run.args coercion:
 * - accepts:
 *   - string: "+x run_tests.sh"
 *   - JSON array string: '["-l","run_tests.sh"]'
 *   - array: ["-l", "run_tests.sh"]
 * - always outputs a single string for the orchestrator
 */
const coerceTerminalArgsToString = (args) => {
  if (args === undefined || args === null) return '';

  // If already an array, join with spaces
  if (Array.isArray(args)) {
    return args
      .map((v) => (v === null || v === undefined ? '' : String(v)))
      .join(' ')
      .trim();
  }

  // If string contains CDATA (common when args was an array/object upstream), unwrap first
  if (typeof args === 'string') {
    const trimmed = args.trim();
    const unwrapped = unwrapCDataBestEffort(trimmed).trim();

    // If unwrapped string looks like a JSON array, try to parse and join
    if (unwrapped.startsWith('[') && unwrapped.endsWith(']')) {
      try {
        const parsed = JSON.parse(unwrapped);
        if (Array.isArray(parsed)) {
          return parsed
            .map((v) => (v === null || v === undefined ? '' : String(v)))
            .join(' ')
            .trim();
        }
      } catch (_) {
        // fall through: treat as plain string
      }
    }

    // If it wasn't valid JSON array, still prefer the unwrapped value (removes CDATA noise)
    return unwrapped;
  }

  return String(args).trim();
};



/**
 * Trim récursif de toutes les strings dans les params d'un tool.
 * Objectif : éviter les chemins / arguments contenant des \n / espaces introduits par le LLM
 * (ex: "\ntictactoe.py\n" => "tictactoe.py") sur TOUS les tools.
 *
 * IMPORTANT:
 * - On NE DOIT PAS trim certains champs "payload" multi-lignes, sinon on casse potentiellement du code
 *   (indentation, newline final, etc.). Ex : write_code.content / write_file.content.
 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const deepTrimStrings = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(deepTrimStrings);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepTrimStrings(v);
    return out;
  }
  return value;
};

const sanitizeToolParams = (toolType, params) => {
  if (!params || typeof params !== 'object') return params;

  // 1) Trim récursif par défaut
  const trimmed = deepTrimStrings(params);

  // 2) Exceptions "payload" : on restaure la valeur originale pour éviter de casser le contenu
  //    (on ne touche pas à l'indentation / leading/trailing newlines du code).
  const restoreField = (fieldName) => {
    if (
      params &&
      Object.prototype.hasOwnProperty.call(params, fieldName) &&
      typeof params[fieldName] === 'string'
    ) {
      trimmed[fieldName] = params[fieldName];
    }
  };

  // Tools d'écriture de contenu (code / fichiers). Ajustez ici si vous avez d'autres tools similaires.
  if (toolType === 'write_code' || toolType === 'write_file') {
    restoreField('content');
  }

  // replace_code_block: preserve multi-line payload (code) exactly
  if (toolType === 'replace_code_block') {
    restoreField('code_block');
  }

  // terminal_run: always coerce args to STRING for the orchestrator
  if (toolType === 'terminal_run') {
    // Some models put everything in "command" (ex: "python3 test_ttt.py").
    // Make it compatible with LemonAI's expected shape:
    // - command = "python3"
    // - args    = "test_ttt.py"
    if (typeof trimmed.command === 'string') {
      const cmd = trimmed.command.trim();
      if (cmd) {
        const parts = cmd.split(/\s+/).filter(Boolean);
        if (parts.length > 1) {
          trimmed.command = parts[0];
          const existingArgs = Object.prototype.hasOwnProperty.call(trimmed, 'args')
            ? String(trimmed.args ?? '').trim()
            : '';
          if (!existingArgs) {
            trimmed.args = parts.slice(1).join(' ');
          }
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(trimmed, 'args')) {
      trimmed.args = coerceTerminalArgsToString(trimmed.args);
    }
  }

  // Note terminal_run:
  // - Trim "command"/"args" n'est généralement pas problématique.
  // - On ne met pas d'exception ici (la sanitation est safe pour terminal_run),
  //   mais si vous voulez l'exclure totalement, vous pouvez ajouter:
  //   if (toolType === 'terminal_run') return params;

  return trimmed;
};



const resolveXML = (content) => {
  // On ne jette plus d'exception si la réponse du modèle est vide ou invalide
  if (!content || typeof content !== 'string' || !content.trim()) {
    console.warn('[xml/resolveXML] Empty or invalid XML content, returning empty object.');
    return {};
  }

  try {
    // Normalize OpenAI-style tool call outputs to LemonAI XML BEFORE parsing
    const normalized = normalizeLLMToolOutputToXML(content);
    if (DEBUG_LLM_XML_NORMALIZE && typeof normalized === 'string' && normalized !== content) {
      // Best-effort tool name extraction for visibility
      const toolMatch = normalized.trim().match(/^<\s*([a-zA-Z_][a-zA-Z0-9_]*)\b/);
      const toolName = toolMatch ? toolMatch[1] : 'unknown';
      console.info(
        `${DEBUG_LLM_XML_NORMALIZE_PREFIX} Normalized LLM output into XML (tool=${toolName}).\n` +
          `  before: ${truncateForLog(content)}\n` +
          `  after : ${truncateForLog(normalized)}`
      );
    }

    const result = parseXML(normalized, undefined, {}) || {};
    return result;
  } catch (error) {
    console.error('[xml/resolveXML] XML parse failed:', error.message);
    // On ne fait plus planter l’agent, on renvoie un objet vide
    return {};
  }
};

/**
 * Detect structurally invalid tool calls early.
 * Goal: prevent tool confusion (e.g. terminal_run containing write_code fields).
 * This does NOT try to be smart or permissive: it only rejects clear schema violations.
 */
const isStructurallyInvalidAction = (action) => {
  if (!action || typeof action !== 'object') return true;

  const { type, params } = action;
  if (!type || typeof params !== 'object') return false;

  // patch_complete: action locale orchestrateur
  // - pas de params requis
  // - ne doit jamais être rejetée ici
  if (type === 'patch_complete') {
    return false;
  }
  // information: action locale orchestrateur (log-only)
  // - ne doit jamais être rejetée ici
  if (type === 'information') {
    return false;
  }

  switch (type) {
    case 'terminal_run':
      // terminal_run MUST NOT contain write-like fields
      if (
        Object.prototype.hasOwnProperty.call(params, 'path') ||
        Object.prototype.hasOwnProperty.call(params, 'content')
      ) {
        console.warn(
          '[xml/resolveActions] Invalid terminal_run: contains path/content (write_code payload)'
        );
        return true;
      }
      return false;

    case 'write_code':
    case 'write_file':
      // write_* MUST have content, but MUST NOT have command
      if (
        Object.prototype.hasOwnProperty.call(params, 'command')
      ) {
        console.warn(
          `[xml/resolveActions] Invalid ${type}: contains terminal_run field "command"`
        );
        return true;
      }
      return false;

    default:
      return false;
  }
};


const resolveActions = (xml) => {
  try {
    const resolved = resolveXML(xml);

    if (!resolved || typeof resolved !== 'object') {
      return [];
    }

    const actions = [];

    for (let key in resolved) {
      if (!Object.prototype.hasOwnProperty.call(resolved, key)) continue;
      const value = resolved[key];

      const action = {
        type: key,
        params: value,
      };
	  
      // patch_complete peut apparaître comme <patch_complete/>
      // => params = undefined ou null selon le parseur
      if (action.type === 'patch_complete' && !action.params) {
        action.params = {};
      }
      // information peut apparaître comme <information/> (ou partiellement formée)
      // => params = undefined ou null selon le parseur
      if (action.type === 'information' && !action.params) {
        action.params = {};
      }

      action.params = sanitizeToolParams(action.type, action.params);

      // Early structural validation: reject malformed tool calls
      if (isStructurallyInvalidAction(action)) {
        // Returning empty action list forces retry logic upstream
        return [];
      }

      actions.push(action);
    }

    return actions;
  } catch (err) {
    console.error('[xml/resolveActions] Failed to resolve actions from XML:', err);
    return [];
  }
};

module.exports = {
  resolveXML,
  resolveActions,
  resolveActionsFromLLMOutput,
  normalizeLLMToolOutputToXML,
};
