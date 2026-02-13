// https://github.com/NaturalIntelligence/fast-xml-parser
const { XMLParser, XMLBuilder, XMLValidator } = require("fast-xml-parser");

// Outils autorisés (évite de produire des "actions" inconnues → action undefined)
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


// Gestion propre du CDATA
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
  // Plus d'exception ici : on log et on renvoie {} (ou une action evaluation failure)
  if (!content || typeof content !== "string" || !content.trim()) {
    console.warn("[utils/resolveXML] Empty or invalid XML content, returning empty object.");
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

    // Validation explicite: permet d’avoir une cause quand fast-xml-parser échoue silencieusement.
    const validation = XMLValidator.validate(sanitized);
    if (validation !== true) {
      console.error("[utils/resolveXML] XML validation failed:", validation && validation.err ? validation.err : validation);
      return buildEvaluationFailure(
        "Invalid XML/tool output: could not resolve action.",
        `XML validation failed.\n\nValidation:\n${previewText(JSON.stringify(validation))}\n\nOutput preview:\n${previewText(content)}`
      );
    }

    const result = parser.parse(sanitized) || {};

    // Nettoyage du CDATA dans write_code.content
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

    // Nettoyage du CDATA dans patch_code.diff
    if (result.patch_code && result.patch_code.diff) {
      result.patch_code.diff = processCDATA(result.patch_code.diff);
    }

    // Nettoyage + JSON.parse pour revise_plan.tasks
    if (result.revise_plan && result.revise_plan.tasks) {
      let tasks = processCDATA(result.revise_plan.tasks);

      if (typeof tasks === "string") {
        try {
          tasks = JSON.parse(tasks);
        } catch (error) {
          console.warn("[utils/resolveXML] JSON parse failed for revise_plan.tasks:", error.message);
          return buildEvaluationFailure(
            "Invalid XML/tool output: could not resolve action.",
            `JSON parse failed for revise_plan.tasks.\n\nError: ${error.message}\n\nTasks preview:\n${previewText(String(tasks))}\n\nOutput preview:\n${previewText(content)}`
          );
        }
      }

      result.revise_plan.tasks = tasks;
    }

    return result;
  } catch (error) {
    console.error("[utils/resolveXML] XML parse failed:", error.message);
    return buildEvaluationFailure(
      "Invalid XML/tool output: could not resolve action.",
      `XML parse failed.\n\nError: ${error.message}\n\nOutput preview:\n${previewText(content)}`
    );
  }
};

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

      // Ignore tout tag non-tool pour éviter action undefined
      if (!ALLOWED_ACTION_TYPES.has(key)) {
        console.warn("[utils/resolveActions] Ignoring unknown action type:", key);
        continue;
      }

      const action = {
        type: key,
        params: value,
      };
	  
      // patch_complete peut apparaître comme <patch_complete/> ou <patch_complete></patch_complete>
      // Selon le parseur, value peut être:
      // - undefined (self-closing)
      // - "" (tag vide)
      // - {} (tag vide)
      // On normalise à {} pour l’exécution locale orchestrateur.
      if (action.type === "patch_complete" && (action.params == null || action.params === "")) {
        action.params = {};
      }

      actions.push(action);
    }

    // Si rien n’a été résolu alors que le XML n’est pas vide, retourner une évaluation échec
    // plutôt que [] (sinon la chaîne amont finit par "action undefined" sans diagnostic).
    if (actions.length === 0 && typeof xml === "string" && xml.trim()) {
      return [
        {
          type: "evaluation",
          params: {
            status: "failure",
            comments:
              "Invalid XML/tool output: could not resolve action.\n\nNo supported tool tags were found after parsing.\n\nOutput preview:\n" +
              previewText(xml),
          },
        },
      ];
    }


    return actions;
  } catch (err) {
    console.error("[utils/resolveActions] Failed to resolve actions from XML:", err);
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

module.exports = {
  resolveXML,
  resolveActions,
};
