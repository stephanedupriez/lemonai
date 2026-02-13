// https://github.com/NaturalIntelligence/fast-xml-parser
const { XMLParser, XMLBuilder, XMLValidator } = require("fast-xml-parser");


// Outils autorisés (évite d’extraire des tags inconnus → actions incohérentes / action undefined)
const ALLOWED_ACTION_TYPES = new Set([
  "finish",
  "replace_code_block",
  "write_code",
  "write_file",
  "read_file",
  "patch_code",
  "revise_plan",
  "terminal_run",
  "web_search",
  "read_url",
  "browser",
  "mcp_tool",
  "evaluation",
  "document_query",
  "document_upload",
  "patch_complete",
]);


const parser = new XMLParser({
  stopNodes: ["write_code.content", "replace_code_block.code_block", "patch_code.diff", "revise_plan.tasks"],
  ignoreAttributes: false,
});

const previewText = (text, head = 220, tail = 220) => {
  if (typeof text !== "string") return "";
  const s = text;
  if (s.length <= head + tail + 20) return s;
  return `${s.slice(0, head)}\n...\n${s.slice(-tail)}`;
};

// Debug probes
// Set to true to always enable probes without relying on env vars.
const RESOLVE_DEBUG = true;

const dbg = (...args) => {
  if (!RESOLVE_DEBUG) return;
  console.log("[editor/resolve][dbg]", ...args);
};

const dbgPreview = (label, text) => {
  if (!RESOLVE_DEBUG) return;
  const s = typeof text === "string" ? text : String(text ?? "");
  console.log("[editor/resolve][dbg]", label, `(len=${s.length})\n${previewText(s, 260, 260)}`);
};

const buildEvaluationFailure = (title, details) => {
  const lines = [];
  lines.push(title);
  if (details) lines.push(details);
  return {
    evaluation: {
      status: "failure",
      comments: lines.filter(Boolean).join("\n\n"),
    },
  };
};

// -----------------------------
// OpenAI/LM Studio JSON tool-call normalizer → LemonAI XML
// -----------------------------
const extractToolNameFromOpenAIPrefix = (text) => {
  if (typeof text !== "string") return null;
  const s = text;
  const msgIdx = s.indexOf("<|message|>");
  const head = msgIdx === -1 ? s : s.slice(0, msgIdx);

  // Common LM Studio / OpenAI-ish pattern:
  // <|channel|>commentary to=read_file code<|message|>{...}
  // Also accept: ... to=terminal_run ...
  const m = head.match(/\bto=([A-Za-z_][A-Za-z0-9_.-]*)\b/);
  if (!m) return null;
  const tool = m[1];
  if (!ALLOWED_ACTION_TYPES.has(tool)) return null;
  return tool;
};

const stripOpenAITokenPrefix = (text) => {
  if (typeof text !== "string") return text;
  const s = text;
  const idx = s.indexOf("<|message|>");
  if (idx === -1) return s;
  // Keep only the actual message payload after <|message|>
  return s.slice(idx + "<|message|>".length).trim();
};

// Extract a balanced {...} JSON object from a string (best-effort).
const extractBalancedJSONObject = (text) => {
  if (typeof text !== "string") return null;
  const s = text;
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
};

const safeJSONParse = (jsonText) => {
  if (typeof jsonText !== "string") return null;
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
};

const xmlEscapeText = (value) => {
  // Only used for short, safe text nodes; code-heavy payloads should go in CDATA.
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

const toXMLValueNode = (tag, value) => {
  if (value == null) return `<${tag}></${tag}>`;

  // For objects/arrays, serialize as JSON (wrapped in CDATA to preserve characters safely)
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return `<${tag}><![CDATA[${json}]]></${tag}>`;
  }

  const s = String(value);
  // If value may break XML, wrap in CDATA.
  if (s.includes("<") || s.includes("&") || s.includes("]]>")) {
    // If "]]>" appears, fall back to escaping instead of CDATA to avoid breaking CDATA.
    if (s.includes("]]>")) {
      return `<${tag}>${xmlEscapeText(s)}</${tag}>`;
    }
    return `<${tag}><![CDATA[${s}]]></${tag}>`;
  }

  return `<${tag}>${xmlEscapeText(s)}</${tag}>`;
};

const buildToolXMLFromArgs = (toolName, argsObj) => {
  if (!toolName || typeof toolName !== "string") return null;
  const name = toolName.trim();
  if (!ALLOWED_ACTION_TYPES.has(name)) return null;

  const args = (argsObj && typeof argsObj === "object") ? argsObj : {};
  let inner = "";
  for (const [k, v] of Object.entries(args)) {
    // Skip dangerous/unexpected keys that aren't valid XML tag names.
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k)) continue;
    inner += toXMLValueNode(k, v);
  }
  return `<${name}>${inner}</${name}>`;
};

// Attempt to convert various OpenAI-style JSON tool-call outputs into LemonAI XML.
const normalizePossibleToolCallToXML = (raw) => {
  if (typeof raw !== "string") return raw;
  const original = raw;
  let s = raw.trim();
  if (!s) return raw;
  
  dbg("normalize: start", { len: original.length, hasMessage: original.includes("<|message|>"), hasChannel: original.includes("<|channel|>") });
  dbgPreview("normalize: original preview", original);

  // Capture tool name if present in OpenAI/LM Studio prefix (e.g. "to=read_file")
  const prefixToolName = extractToolNameFromOpenAIPrefix(s);
  if (prefixToolName) dbg("normalize: prefix tool detected:", prefixToolName);

  // 1) If the model outputs <|channel|>...<|message|><tool>...</tool>, keep only message payload.
  s = stripOpenAITokenPrefix(s);

  // If payload already looks like XML tool tag, keep as-is.
  if (s.startsWith("<") && /<\/[A-Za-z_][A-Za-z0-9_.-]*>\s*$/.test(s)) {
    dbg("normalize: payload is already XML-ish");
    dbgPreview("normalize: xml payload preview", s);
    return s;
  }
  
  // 1bis) If we have a prefix tool name and the payload is a plain JSON object (no embedded tool name),
  // convert it to LemonAI XML using the tool name from the prefix.
  if (prefixToolName && typeof s === "string" && s.trim().startsWith("{")) {
    const jsonText = extractBalancedJSONObject(s) || s.trim();
    const obj = safeJSONParse(jsonText);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const xml = buildToolXMLFromArgs(prefixToolName, obj);
      if (xml) {
        dbg("normalize: built XML from prefix tool + JSON object", { tool: prefixToolName, keys: Object.keys(obj || {}) });
        dbgPreview("normalize: built xml preview", xml);
        return xml;
      }
    }
  }

  // 2) Pattern: <tool_name<|message|>{...json...}
  // Also tolerate missing initial "<" before tool name.
  const m = s.match(/^<?([A-Za-z_][A-Za-z0-9_.-]*)<\|message\|>([\s\S]*)$/);
  if (m) {
    const toolName = m[1];
    const jsonText = extractBalancedJSONObject(m[2]) || m[2].trim();
    const obj = safeJSONParse(jsonText);
    if (obj && typeof obj === "object") {
      const xml = buildToolXMLFromArgs(toolName, obj);
      if (xml) {
        dbg("normalize: built XML from '<tool<|message|>{...}' pattern", { tool: toolName, keys: Object.keys(obj || {}) });
        dbgPreview("normalize: built xml preview", xml);
        return xml;
      }
    }
  }

  // 3) Pure JSON (or JSON-containing) responses: try to detect OpenAI tool call shapes.
  // Extract first balanced JSON object if present; otherwise if it's a clean JSON array/object, parse directly.
  const jsonCandidate =
    s.startsWith("{") || s.startsWith("[") ? s : (extractBalancedJSONObject(s) || "");

  const parsed = safeJSONParse(jsonCandidate);
  if (parsed && typeof parsed === "object") {
    // 3a) { type:"tool_call", name:"read_file", arguments:"{...}" } or variants
    if (parsed.type === "tool_call" && typeof parsed.name === "string") {
      const args =
        typeof parsed.arguments === "string"
          ? safeJSONParse(parsed.arguments) || { arguments: parsed.arguments }
          : parsed.arguments;
      const xml = buildToolXMLFromArgs(parsed.name, args);
      if (xml) {
        dbg("normalize: built XML from type=tool_call", { tool: parsed.name });
        dbgPreview("normalize: built xml preview", xml);
        return xml;
      }
    }

    // 3b) { tool_calls:[ { function:{ name, arguments } } ] } (ChatCompletions-like)
    if (Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      const tc = parsed.tool_calls[0];
      const fn = tc && tc.function ? tc.function : tc;
      const name = fn && typeof fn.name === "string" ? fn.name : null;
      if (name) {
        const args =
          typeof fn.arguments === "string"
            ? safeJSONParse(fn.arguments) || { arguments: fn.arguments }
            : fn.arguments;
        const xml = buildToolXMLFromArgs(name, args);
        if (xml) {
          dbg("normalize: built XML from tool_calls[0].function", { tool: name });
          dbgPreview("normalize: built xml preview", xml);
          return xml;
        }
      }
    }

    // 3c) { name:"read_file", arguments:{...} } or { tool:"read_file", params:{...} }
    if (typeof parsed.name === "string") {
      const args = parsed.arguments && typeof parsed.arguments === "object" ? parsed.arguments : parsed.arguments;
      const xml = buildToolXMLFromArgs(parsed.name, args);
      if (xml) {
        dbg("normalize: built XML from {name, arguments}", { tool: parsed.name });
        dbgPreview("normalize: built xml preview", xml);
        return xml;
      }
    }
    if (typeof parsed.tool === "string") {
      const args = parsed.params && typeof parsed.params === "object" ? parsed.params : parsed.params;
      const xml = buildToolXMLFromArgs(parsed.tool, args);
      if (xml) {
        dbg("normalize: built XML from {tool, params}", { tool: parsed.tool });
        dbgPreview("normalize: built xml preview", xml);
        return xml;
      }
    }
  }

  dbg("normalize: no conversion applied");
  dbgPreview("normalize: final (unconverted) preview", s);
  return s;
};


// Some tools contain raw code that may include '<' (e.g. "0 <= i < N"),
// which is invalid in XML unless escaped or wrapped in CDATA.
// To make the parser tolerant, we wrap certain tag bodies in CDATA when missing.
const wrapTagBodyInCDATAIfMissing = (xml, tagName) => {
  if (typeof xml !== "string" || !xml) return xml;
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
  return xml.replace(re, (full, inner) => {
    const innerStr = inner == null ? "" : String(inner);
    const trimmed = innerStr.trim();
    // Already CDATA-wrapped
    if (trimmed.startsWith("<![CDATA[") && trimmed.endsWith("]]>")) return full;
    // If the body contains characters that commonly break XML, wrap it.
    // ('<' is the primary culprit for code; '&' also breaks XML.)
    if (innerStr.includes("<") || innerStr.includes("&")) {
      return `<${tagName}><![CDATA[${innerStr}]]></${tagName}>`;
    }
    return full;
  });
};


const processCDATA = (text) => {
  if (!text || typeof text !== "string") return text;

  const trimmed = text.trim();
  const cdataStart = "<![CDATA[";
  const cdataEnd = "]]>";

  if (trimmed.startsWith(cdataStart) && trimmed.endsWith(cdataEnd)) {
    return trimmed.slice(cdataStart.length, -cdataEnd.length);
  }

  return text;
};

const resolveXML = (content) => {
	
	console.log(`HELLO WORLD1`);
  if (!content || typeof content !== "string" || !content.trim()) {
    console.warn("[editor/resolveXML] Empty or invalid XML content, returning empty object.");
    return {};
  }

  try {
    dbg("resolveXML: enter", { len: content.length, hasMessage: content.includes("<|message|>"), hasChannel: content.includes("<|channel|>") });
    dbgPreview("resolveXML: input preview", content);

    // Normalize common non-XML tool-call formats (OpenAI/LM Studio JSON variants) into LemonAI XML.
    // This must happen BEFORE CDATA wrapping and XML validation.
    const normalized = normalizePossibleToolCallToXML(content);
    dbg("resolveXML: normalizedChanged", normalized !== content);
    if (normalized !== content) dbgPreview("resolveXML: normalized preview", normalized);

    // Pre-sanitize tool payloads that frequently contain raw code.
    // This must happen BEFORE XMLValidator.validate(...) to avoid false failures.
    let sanitized = normalized;
    sanitized = wrapTagBodyInCDATAIfMissing(sanitized, "code_block"); // replace_code_block
    // Keep existing tools tolerant too (some models output raw code without CDATA)
    sanitized = wrapTagBodyInCDATAIfMissing(sanitized, "content");    // write_code
    sanitized = wrapTagBodyInCDATAIfMissing(sanitized, "diff");       // patch_code
    if (sanitized !== normalized) {
      dbg("resolveXML: CDATA wrapping applied");
      dbgPreview("resolveXML: sanitized preview", sanitized);
    }

    // Validation explicite pour diagnostics (évite un échec silencieux → action undefined ailleurs)
    const validation = XMLValidator.validate(sanitized);
    if (validation !== true) {
	  dbg("resolveXML: XML validation FAILED");
      console.error("[editor/resolveXML] XML validation failed:", validation && validation.err ? validation.err : validation);
      return buildEvaluationFailure(
        "Invalid XML/tool output: could not resolve action.",
        `XML validation failed.\n\nValidation:\n${previewText(JSON.stringify(validation))}\n\nOutput preview:\n${previewText(content)}\n\nNormalized preview:\n${previewText(String(normalized || ""))}`
      );
    }
	dbg("resolveXML: XML validation OK");

    const result = parser.parse(sanitized) || {};
	dbg("resolveXML: parsed root keys", result && typeof result === "object" ? Object.keys(result) : []);

    if (result.write_code && result.write_code.content) {
      result.write_code.content = processCDATA(result.write_code.content);
    }

    // Nettoyage du CDATA dans replace_code_block.code_block
    if (result.replace_code_block && result.replace_code_block.code_block) {
      result.replace_code_block.code_block = processCDATA(result.replace_code_block.code_block);
    }
    // Compat: if model outputs <content> instead of <code_block> for replace_code_block
    if (result.replace_code_block && !result.replace_code_block.code_block && result.replace_code_block.content) {
      result.replace_code_block.code_block = processCDATA(result.replace_code_block.content);
      delete result.replace_code_block.content;
    }

    if (result.patch_code && result.patch_code.diff) {
      result.patch_code.diff = processCDATA(result.patch_code.diff);
    }

    return result;
  } catch (error) {
    console.error("[editor/resolveXML] XML parse failed:", error.message);
    return buildEvaluationFailure(
      "Invalid XML/tool output: could not resolve action.",
      `XML parse failed.\n\nError: ${error.message}\n\nOutput preview:\n${previewText(content)}`
    );
  }
};

/**
 * Extract description from content (text before XML content)
 * Handles both cases: with ```xml wrapper and without
 */
const extractDescription = (content) => {
  try {
    if (!content || typeof content !== "string") {
      return "";
    }

    const lines = content.split("\n");
    let xmlStartIndex = -1;

    // Cherche la première ligne qui ressemble à du XML
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("```xml") || line.startsWith("<")) {
        xmlStartIndex = i;
        break;
      }
    }

    if (xmlStartIndex > 0) {
      return lines
        .slice(0, xmlStartIndex)
        .filter((line) => line.trim())
        .join(" ")
        .trim();
    }

    return "";
  } catch (err) {
    console.error("[extractDescription] Failed to extract description:", err);
    return "";
  }
};

/**
 * Parse XML to extract actions (single or multiple)
 */
const resolveActions = (xml) => {
  try {
	  console.log(`HELLO WORLD1-1`);
    const resolved = resolveXML(xml);

    if (!resolved || typeof resolved !== "object") {
      return [];
    }

    const actions = [];

    for (let key in resolved) {
      if (!Object.prototype.hasOwnProperty.call(resolved, key)) continue;

      const value = resolved[key];

      // Ignore les tags non-tool (ou inconnus) pour éviter de fabriquer des actions invalides
      if (!ALLOWED_ACTION_TYPES.has(key)) {
        console.warn("[editor/resolveActions] Ignoring unknown action type:", key);
        continue;
      }

      // Tableau d’ops du même type
      if (Array.isArray(value)) {
        value.forEach((params) => {
          // patch_complete peut être auto-fermante (<patch_complete/>) ou vide
          // => params peut être undefined / "" / null selon la forme XML et le parseur
          if (key === "patch_complete" && (params == null || params === "")) {
            params = {};
          }
          actions.push({ type: key, params });
        });
      } else {
        // patch_complete peut être auto-fermante (<patch_complete/>) ou vide
        // => value peut être undefined / "" / null selon la forme XML et le parseur
        const normalized = (key === "patch_complete" && (value == null || value === "")) ? {} : value;
        actions.push({ type: key, params: normalized });
      }
    }

    // Si rien n’a été résolu alors que la sortie semblait contenir du XML,
    // retourner une évaluation échec plutôt que [] (sinon upstream finit en "action undefined").
    if (actions.length === 0 && typeof xml === "string" && xml.trim()) {
      actions.push({
        type: "evaluation",
        params: {
          status: "failure",
          comments:
            "Invalid XML/tool output: could not resolve action.\n\nNo supported tool tags were found after parsing.\n\nOutput preview:\n" +
            previewText(xml),
        },
      });
    }


    return actions;
  } catch (err) {
    console.error("[editor/resolveActions] Failed to parse XML:", err);
    return [
      {
        type: "evaluation",
        params: {
          status: "failure",
          comments:
            "Invalid XML/tool output: could not resolve action.\n\nresolveActions threw an exception.\n\nError: " +
            (err && err.message ? err.message : String(err)) +
            "\n\nOutput preview:\n" +
            previewText(String(xml || "")),
        },
      },
    ];
  }
};

// Backward compatibility
const resolveAction = (xml) => {
  const actions = resolveActions(xml);
  return actions[0] || null;
};

module.exports = {
  resolveXML,
  resolveActions,
  resolveAction, // Keep for backward compatibility
  extractDescription,
};
