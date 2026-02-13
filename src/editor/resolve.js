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
  if (!content || typeof content !== "string" || !content.trim()) {
    console.warn("[editor/resolveXML] Empty or invalid XML content, returning empty object.");
    return {};
  }

  try {

    // Pre-sanitize tool payloads that frequently contain raw code.
    // This must happen BEFORE XMLValidator.validate(...) to avoid false failures.
    let sanitized = content;
    sanitized = wrapTagBodyInCDATAIfMissing(sanitized, "code_block"); // replace_code_block
    // Keep existing tools tolerant too (some models output raw code without CDATA)
    sanitized = wrapTagBodyInCDATAIfMissing(sanitized, "content");    // write_code
    sanitized = wrapTagBodyInCDATAIfMissing(sanitized, "diff");       // patch_code

    // Validation explicite pour diagnostics (évite un échec silencieux → action undefined ailleurs)
    const validation = XMLValidator.validate(sanitized);
    if (validation !== true) {
      console.error("[editor/resolveXML] XML validation failed:", validation && validation.err ? validation.err : validation);
      return buildEvaluationFailure(
        "Invalid XML/tool output: could not resolve action.",
        `XML validation failed.\n\nValidation:\n${previewText(JSON.stringify(validation))}\n\nOutput preview:\n${previewText(content)}`
      );
    }

    const result = parser.parse(sanitized) || {};

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
