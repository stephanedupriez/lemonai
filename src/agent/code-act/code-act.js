const thinking = require("./thinking");

const LocalMemory = require("@src/agent/memory/LocalMemory");
const { isPauseRequiredError } = require("@src/utils/errors");

// Reflection module
const reflection = require("@src/agent/reflection/index");
const MAX_RETRY_TIMES = 10;
// Global total-retry cutoff is intentionally disabled.
// We still keep a cumulative counter (totalRetryAttempts) for logging/debugging,
// but we do NOT stop the run based on it.
const MAX_TOTAL_RETRIES = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { resolveActions, resolveActionsFromLLMOutput } = require("@src/xml/index");

const { finish_action, retryHandle } = require("./code-act.common");

const { checkActionToBeContinue, completeMessagesContent } = require("./message");
const urlRegex = /^https?:\/\/\S+/i;

// const MAX_CONTENT_LENGTH = 1e5;
const MAX_CONTENT_LENGTH = 5 * 1e4;
const REPLACE_CODE_BLOCK_TOOL = "replace_code_block";

// Detect "logical failures" even when exitCode is 0, by scanning stdout/stderr for common error signatures.
// NOTE: We do NOT treat "stderr non-empty" as failure by itself (per your requirement).
const ERROR_SIGNATURE_RE = new RegExp(
  [
    // Python
    "Traceback\\s*\\(",
    "\\bAssertionError\\b",
    "\\bSyntaxError\\b",
    "\\bIndentationError\\b",
    "\\bImportError\\b",
    "\\bModuleNotFoundError\\b",
    "\\bNameError\\b",
    "\\bTypeError\\b",
    "\\bValueError\\b",
    "\\bKeyError\\b",
    // Pytest / unittest
    "^FAILED\\b",
    "\\bFAILURES\\b",
    "\\bFAILED\\s*\\(",
    "\\bE\\s+AssertionError\\b",
    "\\bE\\s+TypeError\\b",
    "\\bE\\s+ValueError\\b",
    // Node / JS
    "\\bError:\\b",
    "\\bReferenceError\\b",
    "\\bUnhandledPromiseRejection\\b",
    // Generic
    "\\bSegmentation fault\\b",
    "\\bcore dumped\\b",
  ].join("|"),
  "im"
);

const TERMINAL_RUN_ID_MARKER_PREFIX = "[terminal_run_id:";

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function buildInvalidOutputPreview(text, maxChars = 8000) {
  const s = asTrimmedString(text);
  if (!s) return "(empty output)";
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}\n\n...[truncated ${s.length - maxChars} chars]`;
}

// Detect unsupported non-XML tool call formats (often emitted by some models)
// so we can give a targeted correction message instead of a generic "could not resolve action".
const LEMON_XML_TOOL_TYPES = new Set([
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
  'patch_complete',
  'information',
]);

function extractNonXmlToolName(invalidText) {
  const s = asTrimmedString(invalidText);
  if (!s) return null;

  // Pattern: <|channel|>analysis to=container.exec code<|message|>{...}
  const mTo = s.match(/<\|channel\|>[\s\S]{0,160}?\bto\s*=\s*([A-Za-z0-9_.-]+)/);
  if (mTo && mTo[1]) return mTo[1];

  // Pattern: ...<|channel|>read_file{...}
  const mChannelTool = s.match(/<\|channel\|>\s*([A-Za-z_][A-Za-z0-9_]*)\s*\{/);
  if (mChannelTool && mChannelTool[1]) return mChannelTool[1];

  return null;
}

function isUnsupportedNonXmlToolCall(invalidText) {
  const toolName = extractNonXmlToolName(invalidText);
  if (!toolName) return false;
  // If the tool name is not a Lemon AI XML tool, treat it as unsupported.
  return !LEMON_XML_TOOL_TYPES.has(toolName);
}

function buildUnsupportedToolCorrectionMessage(toolName) {
  const t = toolName ? String(toolName) : 'this tool';
  return (
    `Invalid tool call (unsupported tool): \"${t}\" is not compatible with this runtime.\n` +
    `Please use ONLY structured Lemon AI XML tool calls.\n\n` +
    `Examples of valid tool usage:\n\n` +
    `To read a file:\n` +
    `<read_file><path>file.txt</path></read_file>\n\n` +
    `To run a command:\n` +
    `<terminal_run><command>bash</command><args>-lc \"sed -n '1,200p' file.txt\"</args><cwd></cwd></terminal_run>\n\n` +
    `Output one or more valid XML tool calls now, and nothing else.`
  );
}


function sanitizeToolReturnForLLM(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  // Remove absolute conversation workspace paths injected by the runtime, e.g.:
  // /workspace/user_1/Conversation_75c470/...
  // Keep this sanitization ONLY at message-injection time (LLM-visible).
  return text.replace(/\/workspace\/user_\d+\/Conversation_[^\/\s'"]+\/?/g, "");
}

function asTrimmedString(v) {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  try {
    return String(v);
  } catch (_) {
    return "";
  }
}

// Best-effort CDATA unwrap:
// - handles standard: <![CDATA[...]]>
// - handles split CDATA produced by wrapCData(): ...]]]]><![CDATA[>...
// - tolerates truncated log-like form: [CDATA[...]] (missing "<!")
function unwrapCDataBestEffort(input) {
  if (input === undefined || input === null) return "";
  const s = String(input);

  // Standard / repeated CDATA blocks
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m;
  let acc = "";
  while ((m = re.exec(s)) !== null) acc += m[1];
  if (acc) return acc;

  // Truncated CDATA form sometimes seen in logs: [CDATA[...]]
  const t = s.trim();
  if (t.startsWith("[CDATA[") && (t.endsWith("]]") || t.endsWith("]]>"))) {
    return t
      .replace(/^\[CDATA\[/, "")
      .replace(/\]\]>?$/, "")
      .replace(/\]\]$/, "");
  }

  return s;
}

function coerceTerminalArgsToShellString(args) {
  if (args === undefined || args === null) return "";

  // If already array-ish, join
  if (Array.isArray(args)) {
    return args
      .map((v) => (v === null || v === undefined ? "" : String(v)))
      .join(" ")
      .trim();
  }

  const s = unwrapCDataBestEffort(args).trim();
  if (!s) return "";

  // If it looks like a JSON array, parse + join
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) {
        return parsed
          .map((v) => (v === null || v === undefined ? "" : String(v)))
          .join(" ")
          .trim();
      }
    } catch (_) {
      // fallthrough
    }
  }

  return s;
}



function xmlEscapeText(s) {
  const v = asTrimmedString(s);
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wrapCData(s) {
  const v = asTrimmedString(s);
  // Avoid terminating CDATA accidentally
  return `<![CDATA[${v.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function serializeActionToXml(action) {
  if (!action || typeof action !== "object") return "<parse_error><message>Invalid action object</message></parse_error>";
  const type = action.type;
  const p = action.params || {};

  // Control/special
  if (type === "parse_error") {
    return `<parse_error><message>${xmlEscapeText(p.message || "Invalid XML/tool output")}</message></parse_error>`;
  }
  if (type === "pause_for_user_input") {
    return `<pause_for_user_input><message>${xmlEscapeText(p.message || "")}</message></pause_for_user_input>`;
  }
  if (type === "revise_plan") {
    // best-effort: keep minimal fields
    return `<revise_plan><mode>${xmlEscapeText(p.mode || "")}</mode><reason>${xmlEscapeText(p.reason || "")}</reason><tasks>${wrapCData(p.tasks || "")}</tasks></revise_plan>`;
  }
  if (type === "finish") {
    // Include explicit goal status so multi-action injection preserves required params.
    const st = p.status !== undefined ? `<status>${xmlEscapeText(p.status || "")}</status>` : "";
    return `<finish>${st}<message>${wrapCData(p.message || "")}</message></finish>`;
  }
  if (type === "evaluation") {
    return `<evaluation><status>${xmlEscapeText(p.status || "")}</status><comments>${wrapCData(p.comments || "")}</comments></evaluation>`;
  }
  if (type === "information") {
    return `<information><message>${wrapCData(p.message || "")}</message></information>`;
  }
  if (type === "patch_complete") {
    // Local orchestrator action: keep it serializable so multi-action injection doesn't turn it into "unknown action type".
    const msg = isNonEmptyString(p.message) ? `<message>${wrapCData(p.message)}</message>` : "";
    return `<patch_complete>${msg}</patch_complete>`;
  }

  // Tools (best-effort)
  if (type === "terminal_run") {
    // IMPORTANT:
    // - do NOT re-wrap JSON-array-like args into CDATA, otherwise it can end up executed literally
    // - normalize CDATA/json-array forms into a single shell-friendly string here as a backstop
    const normalizedArgs = p.args !== undefined ? coerceTerminalArgsToShellString(p.args) : "";
    const args =
      p.args !== undefined ? `<args>${xmlEscapeText(normalizedArgs)}</args>` : "";
    const cwd = p.cwd !== undefined ? `<cwd>${xmlEscapeText(p.cwd)}</cwd>` : "";
    return `<terminal_run><command>${xmlEscapeText(p.command || "")}</command>${args}${cwd}</terminal_run>`;
  }
  if (type === "write_code") {
    return `<write_code><path>${xmlEscapeText(p.path || "")}</path><content>${wrapCData(p.content || "")}</content></write_code>`;
  }
  if (type === "replace_code_block") {
    return `<replace_code_block><path>${xmlEscapeText(p.path || "")}</path><code_block>${wrapCData(p.code_block || "")}</code_block></replace_code_block>`;
  }
  if (type === "read_file") {
    return `<read_file><path>${xmlEscapeText(p.path || "")}</path></read_file>`;
  }
  if (type === "read_url") {
    return `<read_url><url>${xmlEscapeText(p.url || "")}</url></read_url>`;
  }
  if (type === "web_search") {
    const n = p.num_results !== undefined ? `<num_results>${xmlEscapeText(p.num_results)}</num_results>` : "";
    const topic = p.topic !== undefined ? `<topic>${xmlEscapeText(p.topic)}</topic>` : "";
    return `<web_search>${topic}<query>${xmlEscapeText(p.query || "")}</query>${n}</web_search>`;
  }
  if (type === "mcp_tool") {
    const args = p.arguments !== undefined ? `<arguments>${wrapCData(JSON.stringify(p.arguments))}</arguments>` : "";
    return `<mcp_tool><name>${xmlEscapeText(p.name || "")}</name>${args}</mcp_tool>`;
  }

  // Unknown tool: keep something that won't crash XML parsing on re-read
  return `<evaluation><status>failure</status><comments>${wrapCData(
    `Invalid tool call: unknown action type "${type}".`
  )}</comments></evaluation>`;
}


function getTerminalRunRunId(action, action_result) {
  // Prefer run_id carried by runtime meta (as per your architecture)
  if (action_result && typeof action_result === "object") {
    const meta = action_result.meta && typeof action_result.meta === "object" ? action_result.meta : {};
    // Common shapes observed in LemonAI runtimes:
    // - meta.action.params.run_id
    // - meta.action.params.runId
    // - meta.run_id / meta.runId
    const fromNested =
      meta.action && meta.action.params && (meta.action.params.run_id || meta.action.params.runId);
    const fromMeta = meta.run_id || meta.runId;
    const candidates = [fromNested, fromMeta];
    for (const c of candidates) {
      if (typeof c === "string" && c.trim()) return c.trim();
      if (typeof c === "number" && Number.isFinite(c)) return String(c);
    }
  }

  // Fallback: if the tool params include run_id (less ideal but acceptable)
  if (action && action.params && typeof action.params === "object") {
    const c = action.params.run_id || action.params.runId;
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }

  return null;
}

function getTerminalRunExitCode(action_result) {
  if (!action_result || typeof action_result !== "object") return null;
  const meta = action_result.meta && typeof action_result.meta === "object" ? action_result.meta : {};
  const candidates = [meta.exitCode, action_result.exitCode, action_result.code];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    // Be tolerant to runtimes that serialize exit codes as strings (e.g. "1")
    if (typeof c === "string" && c.trim() !== "") {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function getTerminalRunOutputText(action_result) {
  if (!action_result || typeof action_result !== "object") return "";
  const stdout = asTrimmedString(action_result.stdout || action_result.content);
  const stderr = asTrimmedString(action_result.stderr);
  const errText = asTrimmedString(action_result.error || action_result.comments);
  // Keep order: stdout, stderr, error/comments
  return `${stdout}\n${stderr}\n${errText}`.trim();
}

// Strictly "test failure" signatures (not generic runtime errors).
// Used ONLY when the command is already recognized as a test runner.
const TEST_FAILURE_SIGNATURE_RE = new RegExp(
  [
    // unittest / pytest
    "\\bFAILED\\s*\\(",
    "^FAILED\\b",
    "\\bFAIL:\\b",
    "\\bERROR:\\b",
    "\\bE\\s+AssertionError\\b",
    "\\bE\\s+TypeError\\b",
    "\\bE\\s+ValueError\\b",
    // Python exceptions typical in failing tests
    "Traceback\\s*\\(",
    "\\bAssertionError\\b",
    // JS test runners
    "\\bFAIL\\b\\s",         // e.g. Jest "FAIL  path/to/test"
    "\\bAssertionError\\b",
  ].join("|"),
  "im"
);

function isTerminalFailure(action, action_result) {
  if (!action || action.type !== "terminal_run") return false;
  if (!action_result || typeof action_result !== "object") return true;

  // Primary: explicit failure status.
  if (action_result.status === "failure") return true;

  // Primary: non-zero exit code (if provided).
  const exitCode = getTerminalRunExitCode(action_result);
  if (typeof exitCode === "number" && exitCode !== 0) return true;

  // Secondary: error signatures in stdout/stderr/error/content.
  const stdout = asTrimmedString(action_result.stdout || action_result.content);
  const stderr = asTrimmedString(action_result.stderr);
  const errText = asTrimmedString(action_result.error || action_result.comments);

  // Limit scan size defensively.
  const haystack = `${stdout}\n${stderr}\n${errText}`;
  const sample = haystack.length > 20000 ? haystack.slice(0, 20000) : haystack;
  return ERROR_SIGNATURE_RE.test(sample);
}

function isExpectedTestFailure(action, action_result) {
  // We only classify terminal_run failures here.
  if (!action || action.type !== "terminal_run") return false;
  if (!action_result || typeof action_result !== "object") return false;

  const cmd = asTrimmedString(action?.params?.command).trim();
  const args = coerceTerminalArgsToShellString(action?.params?.args);
  const full = `${cmd} ${args}`.toLowerCase();

  // Generic, language-agnostic test runner heuristics.
  // Goal: distinguish "tests are failing" (expected in dev loop) from technical/tool failures.
  //
  // We keep this broad to remain generic and avoid tying to a specific project.
  const patterns = [
    // Python
    /\bpytest\b/,
    /\bpython(?:\d+(?:\.\d+)?)?\b.*\b-m\b.*\bunittest\b/,
    /\bpython(?:\d+(?:\.\d+)?)?\b.*\b-m\b.*\bpytest\b/,
    /\bpython(?:\d+(?:\.\d+)?)?\b.*\b-m\b.*\bnose2\b/,
    /\bnose2\b/,
    // Node / JS
    /\bnpm\b.*\btest\b/,
    /\byarn\b.*\btest\b/,
    /\bpnpm\b.*\btest\b/,
    /\bbun\b.*\btest\b/,
    /\bnode\b.*\b--test\b/,
    /\bjest\b/,
    /\bvitest\b/,
    /\bmocha\b/,
    // Go / Rust
    /\bgo\b.*\btest\b/,
    /\bcargo\b.*\btest\b/,
    // .NET / Java / CMake
    /\bdotnet\b.*\btest\b/,
    /\bmvn\b.*\btest\b/,
    /\bgradle\b.*\btest\b/,
    /\bctest\b/,
  ];

  // STRICT: only classify as "expected test failure" if the command is a test runner.
  const isTestCommand = patterns.some((re) => re.test(full));
  if (!isTestCommand) return false;

  // Preferred signal: non-zero exit code.
  const exitCode = getTerminalRunExitCode(action_result);
  if (typeof exitCode === "number" && exitCode !== 0) return true;

  // Fallback: some runtimes mis-propagate/normalize exit codes.
  // When (and only when) the command is a recognized test runner, also inspect output
  // (including stderr) for explicit test-failure signatures.
  const out = getTerminalRunOutputText(action_result);
  if (!out) return false;
  const sample = out.length > 20000 ? out.slice(0, 20000) : out;
  return TEST_FAILURE_SIGNATURE_RE.test(sample);
}


function updatePromptModeFromTerminalRun(context, action, action_result) {
  if (!context || !action || action.type !== "terminal_run") return;
  const failed = isTerminalFailure(action, action_result);
  if (failed) {
    context.prompt_mode = "codecorrector";
	const trigger_run_id = getTerminalRunRunId(action, action_result);
    context.last_terminal_failure = {
      at: Date.now(),
      command: action?.params?.command,
      args: action?.params?.args,
      cwd: action?.params?.cwd,
	  trigger_run_id,
      status: action_result?.status,
      exitCode: getTerminalRunExitCode(action_result),
      stdout: asTrimmedString(action_result?.stdout || action_result?.content),
      stderr: asTrimmedString(action_result?.stderr),
      error: asTrimmedString(action_result?.error || action_result?.comments),
    };
  } else {
    context.prompt_mode = "build";
    // Keep last_terminal_failure for debugging, but mark resolved.
    if (context.last_terminal_failure && typeof context.last_terminal_failure === "object") {
      context.last_terminal_failure.resolved_at = Date.now();
    }
  }
}

function getOrInitErrorFeedbackState(context) {
  if (!context._errorFeedbackState) {
    context._errorFeedbackState = {
      readFileTransientByPath: new Map(),
      candidatesToRevalidate: new Set(),
      lastReflectionSource: null,
    };
  }
  return context._errorFeedbackState;
}

async function maybeRevalidateErrorFeedback(context, task_id) {
  const state = getOrInitErrorFeedbackState(context);
  if (!state.candidatesToRevalidate || state.candidatesToRevalidate.size === 0) return;

  const paths = Array.from(state.candidatesToRevalidate).sort();
  state.candidatesToRevalidate.clear();

  for (const p of paths) {
    try {
      const action = { type: 'read_file', params: { path: p } };
      const uuid = `recheck_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const res = context.runtime && typeof context.runtime.read_file === 'function'
        ? (context.runtime.read_file.length >= 2 ? await context.runtime.read_file(action, uuid) : await context.runtime.read_file(action))
        : null;

      const ok = res && res.status === 'success';
      if (ok) {
        const prev = state.readFileTransientByPath.get(p);
        state.readFileTransientByPath.delete(p);
        console.log(`[error-feedback] recheck ok for ${p} -> invalidating previous read_file error`);
        if (state.lastReflectionSource && state.lastReflectionSource.type === 'read_file' && state.lastReflectionSource.path === p) {
          // Clear the injected error feedback if it was sourced from this resolved error
          context.reflection = '';
          console.log(`[error-feedback] cleared context.reflection for resolved path ${p}`);
        }
      } else {
        const kind = res && res.meta && res.meta.error_kind ? res.meta.error_kind : '';
        console.log(`[error-feedback] recheck still failing for ${p} (kind=${kind}) -> keeping error feedback`);
      }
    } catch (e) {
      console.log(`[error-feedback] recheck exception for ${p}: ${e && e.message ? e.message : String(e)}`);
    }
  }
}


function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Build the allowed action/tool set from the tool registry (source of truth).
 *
 * IMPORTANT:
 * - Do NOT depend on task.tools (it can be empty/undefined even when runtime has tools).
 * - If the registry cannot be loaded, we fall back to permissive behavior (no type gating)
 *   and rely on per-tool arg validation below.
 */
function getAllowedActionTypesFromRegistry() {
  const set = new Set();

  // Always allow these control actions
  set.add("parse_error");
  set.add("pause_for_user_input");
  set.add("revise_plan");
  set.add("finish");
  // Best-effort: load tool registry (same module the runtime uses).
  // Depending on packaging, the registry may live at different paths.
  const candidates = [
    "@src/tools/index.js",
    "@src/tools/index",
    "../../tools/index.js",
    "../../tools/index",
  ];


  for (const modPath of candidates) {
    try {
      // eslint-disable-next-line import/no-dynamic-require, global-require
      const reg = require(modPath);
      if (reg && typeof reg === "object") {
        // Common shapes:
        //  - { toolName: ToolClassOrFactory, ... }
        //  - { tools: { toolName: ..., ... } }
        const obj = reg.tools && typeof reg.tools === "object" ? reg.tools : reg;
        for (const name of Object.keys(obj)) {
          if (typeof name === "string" && name.trim()) set.add(name.trim());
        }
        // If we successfully loaded, stop.
        break;
      }
    } catch (e) {
      // ignore and try next
    }
  }

  return set;

}


/**
 * Validate tool arguments strictly.
 * Returns: { ok: boolean, error_message?: string }
 *
 * NOTE:
 * - We only validate tool-ish actions (terminal_run, write_code, read_file, etc.)
 * - If the tool call is invalid, we want to:
 *   - remove the invalid assistant output from memory (so it doesn't propagate)
 *   - add a developer correction message (without the invalid XML)
 *   - retry inference
 */
function validateActionArgs(action) {
  if (!action || typeof action !== "object") {
    return { ok: false, error_message: "Invalid action object." };
  }
  const type = action.type;
  const p = action.params || {};

  const allowed = getAllowedActionTypesFromRegistry();
  // If we only have control actions (registry couldn't be loaded), don't gate by type.
  const registryLikelyLoaded = allowed.size > 4;
  if (registryLikelyLoaded && !allowed.has(type)) {
    return {
      ok: false,
      error_message:
        `Invalid action type: "${type}". Please output one or more supported tool calls in valid XML format.`,
    };
  }

  // Control actions accepted as-is (handled elsewhere)
  if (
    type === "parse_error" ||
    type === "pause_for_user_input" ||
    type === "revise_plan" ||
    type === "patch_complete" ||
    type === "information"
  ) {
    return { ok: true };
  }

  // Tool actions validation (strict).
  switch (type) {
    case "web_search": {
      // Required: query (string)
      if (!isNonEmptyString(p.query)) {
        return { ok: false, error_message: "Invalid tool call: web_search requires a non-empty <query>." };
      }
      // Optional: num_results (integer)
      if (p.num_results !== undefined) {
        const n = Number(p.num_results);
        if (!Number.isInteger(n) || n <= 0) {
          return { ok: false, error_message: "Invalid tool call: web_search <num_results> must be a positive integer." };
        }
      }
      return { ok: true };
    }

    case "read_url": {
      if (!isNonEmptyString(p.url)) {
        return { ok: false, error_message: "Invalid tool call: read_url requires a non-empty <url>." };
      }
      // Light sanity check (do not over-reject)
      if (!urlRegex.test(p.url.trim())) {
        return { ok: false, error_message: "Invalid tool call: read_url <url> must start with http:// or https://." };
      }
      return { ok: true };
    }

    case "terminal_run": {
      // Required: command (string)
      if (!isNonEmptyString(p.command)) {
        return {
          ok: false,
          error_message:
            "Invalid tool call: terminal_run requires a non-empty <command>. " +
            "Do NOT put <path>/<content> under <terminal_run>. " +
            "If you need to write a file, use <write_code> with <path> and <content>.",
        };
      }
      // Optional: args/cwd, but if present, must be strings (or empty string for args).
      if (p.args !== undefined && typeof p.args !== "string") {
        return { ok: false, error_message: "Invalid tool call: terminal_run <args> must be a string." };
      }
      if (p.cwd !== undefined && typeof p.cwd !== "string") {
        return { ok: false, error_message: "Invalid tool call: terminal_run <cwd> must be a string." };
      }
      return { ok: true };
    }

    case "write_code": {
      if (!isNonEmptyString(p.path)) {
        return { ok: false, error_message: "Invalid tool call: write_code requires a non-empty <path>." };
      }
      if (typeof p.content !== "string") {
        return { ok: false, error_message: "Invalid tool call: write_code requires <content> as a string." };
      }
      return { ok: true };
    }

    case "read_file": {
      if (!isNonEmptyString(p.path)) {
        return { ok: false, error_message: "Invalid tool call: read_file requires a non-empty <path>." };
      }
      return { ok: true };
    }

    case "mcp_tool": {
      // Based on schema: name (string) strongly expected, arguments optional object
      if (!isNonEmptyString(p.name)) {
        return { ok: false, error_message: "Invalid tool call: mcp_tool requires a non-empty <name>." };
      }
      if (p.arguments !== undefined && !isPlainObject(p.arguments)) {
        return { ok: false, error_message: "Invalid tool call: mcp_tool <arguments> must be an object." };
      }
      return { ok: true };
    }

    case "finish": {
      // In your schema/examples, finish requires message
      if (!isNonEmptyString(p.message)) {
        return { ok: false, error_message: "Invalid tool call: finish requires a non-empty <message>." };
      }
      // NEW: finish requires explicit goal status: SUCCESS or FAILED
      if (!isNonEmptyString(p.status)) {
        return { ok: false, error_message: "Invalid tool call: finish requires a non-empty <status> with value SUCCESS or FAILED." };
      }
      const st = String(p.status).trim().toUpperCase();
      if (st !== "SUCCESS" && st !== "FAILED") {
        return { ok: false, error_message: `Invalid tool call: finish <status> must be SUCCESS or FAILED (got: ${String(p.status)}).` };
      }
      return { ok: true };
    }

    default:
      // Allowed but not explicitly validated here (future tools). Keep permissive if the task allows it.
      return { ok: true };
  }
}


/**
 * Execute code behavior until task completion or maximum retry times reached
 * @param {Object} task - Task object containing requirement and id
 * @param {Object} context - Context object
 * @returns {Promise<Object>} - Task execution result
 */
const completeCodeAct = async (task = {}, context = {}) => {
  // Initialize parameters and environment
  const { requirement, id = 1, depth = 1 } = task;

  // Expose the current task id to downstream components (LLM call/logging).
  // The LLM never sees operator log tags; this is only used to correlate logs.
  // Prefer task.id when present, fall back to `id` (legacy/default).
  const task_id = (task && (task.id ?? task.task_id ?? task.taskId)) ?? id;
  context.task_id = task_id;
  context.current_task_id = task_id;
  // Optional structured task reference for callers that prefer it
  if (!context.task) context.task = task;
  
  if (depth > 1) {
    // const task_manager = context.task_manager;
    // process.exit(0);
  }
  const maxRetries = context.max_retry_times || MAX_RETRY_TIMES;
  // Allow 0 to mean "disabled" (do not treat 0 as falsy default).
  const maxTotalRetries = (context.max_total_retries ?? MAX_TOTAL_RETRIES);

  // Initialize memory and runtime
  const memory_dir = context.conversation_id.slice(0, 6);
  const memory = new LocalMemory({ memory_dir: memory_dir, key: task_id });
  context.memory = memory;
  memory._loadMemory();
  // @ts-ignore

  let retryCount = 0;
  let totalRetryAttempts = 0; // add：total retries times counter

  const messageHasRunIdMarker = (msg, runId) => {
    if (!runId || typeof runId !== "string") return false;
    const content = asTrimmedString(msg && (msg.content || msg.message || msg.text));
    if (!content) return false;
    return content.includes(`${TERMINAL_RUN_ID_MARKER_PREFIX}${runId}]`);
  };

  const messageMatchesRunId = (msg, runId) => {
    if (!runId) return false;
    if (!msg || typeof msg !== "object") return false;

    // Best-effort: detect runtime meta embedding
    const meta = msg.meta && typeof msg.meta === "object" ? msg.meta : null;
    if (meta) {
      const fromNested =
        meta.action && meta.action.params && (meta.action.params.run_id || meta.action.params.runId);
      const fromMeta = meta.run_id || meta.runId;
      if ((typeof fromNested === "string" && fromNested.trim() === runId) || String(fromNested) === runId) return true;
      if ((typeof fromMeta === "string" && fromMeta.trim() === runId) || String(fromMeta) === runId) return true;
    }

    // Fallback: marker in message content injected by this orchestrator
    if (messageHasRunIdMarker(msg, runId)) return true;

    return false;
  };

  const tryPurgeMessagesForRunId = async (runId) => {
    if (!runId || typeof runId !== "string" || !runId.trim()) return { purged: 0 };

    // Preferred: dedicated memory primitive (will be added in LocalMemory.js)
    if (memory && typeof memory.purgeTerminalRunByRunId === "function") {
      const n = await memory.purgeTerminalRunByRunId(runId);
      return { purged: typeof n === "number" ? n : 0 };
    }

    // Alternate: generic predicate-based removal
    if (memory && typeof memory.removeMessagesWhere === "function") {
      const n = await memory.removeMessagesWhere((m) => messageMatchesRunId(m, runId));
      return { purged: typeof n === "number" ? n : 0 };
    }

    // Last resort: in-place filter if the memory exposes setters (best effort)
    if (memory && typeof memory.getMessages === "function") {
      const msgs = await memory.getMessages();
      if (Array.isArray(msgs) && msgs.length > 0) {
        const filtered = msgs.filter((m) => !messageMatchesRunId(m, runId));

        // Try common setter/save shapes without assuming internals
        if (typeof memory.setMessages === "function") {
          await memory.setMessages(filtered);
          return { purged: msgs.length - filtered.length };
        }
        if (typeof memory._saveMemory === "function") {
          // Best-effort: mutate known property names used by some LocalMemory implementations
          if (Array.isArray(memory.messages)) memory.messages = filtered;
          if (Array.isArray(memory._messages)) memory._messages = filtered;
          await memory._saveMemory(filtered);
          return { purged: msgs.length - filtered.length };
        }
      }
    }

    // Pruning must be centralized in LocalMemory.addMessage(). Do not purge here.
    return { purged: 0 };
  };

  const handleRetry = async () => {
    retryCount++;
    totalRetryAttempts++;
    context.retryCount = retryCount;
    await delay(500);
  }

  // Main execution loop
  while (true) {
    try {
      // 1. LLM thinking
      await maybeRevalidateErrorFeedback(context, task.id);
      context.depth = depth || 1;
      let content = await thinking(requirement, context);

      // If the model returns an empty output, do NOT fallback to parsing old history (it can replay old tool calls).
      // Instead, inject a strict developer correction and retry.
      if (!isNonEmptyString(content)) {
		let removedAssistant = null;
        try {
          // Best-effort: drop the last assistant message if thinking() created one (often empty/invalid)
          if (memory && typeof memory.removeLastAssistantMessage === "function") {
            removedAssistant = await memory.removeLastAssistantMessage();
          }
        } catch (e) {
          // ignore
        }
		
        try {
          const invalidText = removedAssistant && typeof removedAssistant === "object"
            ? (removedAssistant.content || removedAssistant.message || removedAssistant.text)
            : content;
          await memory.addMessage(
            "developer",
            buildInvalidOutputPreview(invalidText)
          );
        } catch (e) {
          // ignore
        }

        await memory.addMessage(
          "developer",
          "Model returned an empty output. " +
            "Output one or more valid XML tool calls with all required arguments. " +
            "Do not output any other text."
        );

        await handleRetry();
        continue;
      }
      // console.log("thinking.result", content);

      // 2. Parse Action
      // try to parse action directly avoid llm don't continue
      const parsedActions = (typeof resolveActionsFromLLMOutput === "function")
        ? resolveActionsFromLLMOutput(content)
        : await resolveActions(content);
      const actions = Array.isArray(parsedActions) ? parsedActions : [];
      let action = actions[0];

      // Multi-action handling:
      // - remove the raw assistant message produced by thinking() (multi-actions in one message)
      // - then, during execution, inject assistant tool-call XML *just before* executing each action
      //   so the subsequent user tool-result stays adjacent and inherits the same prune_hash.
      let multiActionMode = false;
      if (actions.length > 1) {
        multiActionMode = true;
        try {
          if (memory && typeof memory.removeLastAssistantMessage === "function") {
            await memory.removeLastAssistantMessage();
          }
        } catch (e) {
          // ignore
        }
      }


      if (!action) {
        // NOTE:
        // We intentionally do NOT attempt to parse by concatenating prior assistant outputs when the current
        // output is invalid, because it can replay old tool calls.
        // Keep the existing retry path below (invalid XML feedback + retry).
      }
      console.log("action", action);

      if (action && action.type === 'parse_error') {
        // Drop the invalid assistant output so it doesn't get propagated,
        // BUT keep it visible to the model as MESSAGE5 for self-correction.
        let removedAssistant = null;
        try {
          removedAssistant = await memory.removeLastAssistantMessage();
        } catch (e) {
          // ignore
        }
        try {
          const invalidText = removedAssistant && typeof removedAssistant === "object"
            ? (removedAssistant.content || removedAssistant.message || removedAssistant.text)
            : content;
          await memory.addMessage(
            "developer",
            buildInvalidOutputPreview(invalidText)
          );
        } catch (e) {
          // ignore
        }
        // Add a high-priority correction without including the invalid XML.
        {
          const invalidText = removedAssistant && typeof removedAssistant === "object"
            ? (removedAssistant.content || removedAssistant.message || removedAssistant.text)
            : content;
          const unsupportedTool = extractNonXmlToolName(invalidText);
          const msg = isUnsupportedNonXmlToolCall(invalidText)
            ? buildUnsupportedToolCorrectionMessage(unsupportedTool)
            : (action.params?.message || 'Invalid XML/tool output: resolve action failed.') +
                ' Output one or more valid XML tool calls with all required arguments.' +
                ' If you output multiple tool calls, each one must be valid XML.';
          await memory.addMessage('developer', msg);
        }
        await handleRetry();
        continue;
      }

      // If we got multiple actions, execute them sequentially within this same loop turn.
      // If any action requires a retry (reflection failure or invalid XML/tool), we stop the sequence and retry.
      const actionsToExecute = actions.length ? actions : (action ? [action] : []);
	  let requestedRetry = false;
      let requestedRetryNoPenalty = false;

      for (let idx = 0; idx < actionsToExecute.length; idx++) {
        action = actionsToExecute[idx];
        if (!action) continue;
		
        // In multi-action mode, inject each tool-call as its own assistant message
        // immediately before its result is produced, to preserve tool-call/result adjacency
        // required by LocalMemory pruning (prune_hash pairing).
        if (multiActionMode) {
          try {
            await memory.addMessage("assistant", serializeActionToXml(action));
          } catch (e) {
            // ignore
          }
        }

        // Special case: synthesized invalid block from splitter -> treat as a tool call + result injection, then continue.
        if (action.type === "evaluation" && action.params && action.params.status === "failure") {
          const c = asTrimmedString(action.params.comments);
          // Inject "result" as user-visible error feedback so the model can self-correct, but do not stop the sequence.
          try {
            await memory.addMessage("user", sanitizeToolReturnForLLM(c));
          } catch (e) {
            // ignore
          }
          continue;
        }

        // 2.5 Strict tool args validation BEFORE any execution.
        // For multi-action outputs, we do NOT force a full retry on a single invalid action:
        // we convert it into an evaluation failure and keep processing remaining actions.
        if (action && action.type && action.type !== "parse_error") {
          const v = validateActionArgs(action);
          if (!v.ok) {
            const msg =
              (v.error_message || "Invalid tool call. Please output ONLY valid XML tool calls with required arguments.") +
              " (This action was skipped.)";
            try {
              // Add an explicit failure result for this invalid action.
              await memory.addMessage("user", sanitizeToolReturnForLLM(msg));
            } catch (e) {
              // ignore
            }
            continue;
          }
        }
 
        /**
         * Task routing that must happen immediately
         */
        if (action && action.type === 'revise_plan') {
          return {
            status: 'revise_plan',
            params: action.params
          }
        }

        if (action && action.type === 'pause_for_user_input') {
          return {
            status: 'pause_for_user_input',
            params: action.params
          }
        }

        /**
         * patch_complete (LOCAL orchestrator action)
         * - Switch back to build mode immediately
         * NOTE: This action MUST NOT be routed to the sandbox/runtime.
         */
        if (action && action.type === "patch_complete") {
          context.prompt_mode = "build";
          try {
            // patch_complete is a local orchestrator action; acknowledge to avoid an empty last message.
            await memory.addMessage("user", "Acknowledged.");
          } catch (e) {
            // ignore
          }
          // Continue with remaining actions (if any) is unsafe; stop sequence and go back to LLM.
          requestedRetry = true;
          break;
        }
		
        /**
         * information (LOCAL orchestrator action, log-only)
         * - MUST NOT be routed to the sandbox/runtime.
         * - Keep the assistant <information> block for observability in logs,
         *   but inject a minimal ACK so the last history message is not empty.
         * - Continue with remaining actions (if any).
         */
        if (action && action.type === "information") {
          try {
            // information is a log-only tool. Keep the assistant <information> block for observability,
            // but inject a minimal acknowledgement to avoid an empty last message.
            await memory.addMessage("user", "Acknowledged.");
          } catch (e) {
            // ignore
          }
          continue;
        }

        // 4. Check if action is 'finish' (task completed)
        if (action.type === "finish") {
          const result = await finish_action(action, context, task.id);
          // If <finish> is invalid (missing/incorrect status), do NOT end the task.
          // Feed the failure back into the loop so the model can correct its tool call.
          const invalidFinish =
            result &&
            result.status === "failure" &&
            result.meta &&
            result.meta.action_type === "finish" &&
            result.meta.finish_status_valid === false;
          if (invalidFinish) {
            // Ensure the invalid-finish error is visible to the model in the next turn.
            try {
              context.reflection = sanitizeToolReturnForLLM(result.comments || "");
            } catch (e) {
              // ignore
            }
            try {
              await memory.addMessage("user", sanitizeToolReturnForLLM(result.comments || ""));
            } catch (e) {
              // ignore
            }
            requestedRetry = true;
            requestedRetryNoPenalty = true;
            break;
          }
          // Persist the explicit finish status so prompt assembly can drop stale Error Feedback
          // when the model declares SUCCESS.
          try {
            const st = result?.meta?.finish_status || action?.params?.status;
            if (typeof st === "string" && st.length > 0) context.last_finish_status = st;
          } catch (e) {
            // ignore
          }
          return result;
        }

        // Check if action is 'to be continue' to completion content
        const actionToBeContinue = checkActionToBeContinue(action);
        if (actionToBeContinue === 'to be continue') {
          continue;
        }

        // 5. Execute action
        const action_result = await context.runtime.execute_action(action, context, task.id);
        if (!context.generate_files) {
          context.generate_files = [];
        }
        if (action_result.meta && action_result.meta.filepath) {
          context.generate_files.push(action_result.meta.filepath);
        }

        // Prompt-mode switching (build <-> codecorrector) is orchestrator-driven:
        updatePromptModeFromTerminalRun(context, action, action_result);

        // Track transient read_file failures by path, and schedule revalidation when a later write_code succeeds.
        try {
          const state = getOrInitErrorFeedbackState(context);
          const p = action && action.params && action.params.path ? action.params.path : null;

          if (action && action.type === 'write_code' && action_result && action_result.status === 'success' && typeof p === 'string' && p.trim()) {
            if (state.readFileTransientByPath.has(p)) {
              state.candidatesToRevalidate.add(p);
              console.log(`[error-feedback] write_code succeeded for ${p} -> scheduling recheck to invalidate prior read_file error`);
            }
          }

          if (action && action.type === 'read_file' && action_result && action_result.status === 'failure' && typeof p === 'string' && p.trim()) {
            const kind = action_result.meta && action_result.meta.error_kind ? action_result.meta.error_kind : '';
            // Only treat NOT_FOUND/INACCESSIBLE as transient candidates
            if (kind === 'NOT_FOUND' || kind === 'INACCESSIBLE') {
              state.readFileTransientByPath.set(p, { kind, message: action_result.error || '' });
              state.lastReflectionSource = { type: 'read_file', path: p, kind };
              console.log(`[error-feedback] recorded transient read_file error for ${p} (kind=${kind})`);
            } else {
              state.lastReflectionSource = { type: 'other', action: action.type };
            }
          } else {
            // Update lastReflectionSource for non-read_file failures so we don't incorrectly clear reflection later
            if (action_result && action_result.status === 'failure') {
              state.lastReflectionSource = { type: 'other', action: action.type };
            }
          }
        } catch (e) {
          // no-op
        }

        // 6. Reflection and evaluation
        const reflection_result = await reflection(requirement, action_result, context.conversation_id);
        const { status, comments } = reflection_result;

        // 7. Handle execution result
        if (status === "success") {
          retryCount = 0; // reset retryCount
		  context.retryCount = retryCount; // keep context in sync for logging/debugging
          const { content } = action_result;
          const task_tool = task.tools && task.tools[0];
          if (action.type === task_tool) {
            // finish now requires an explicit status; task_tool success implies SUCCESS.
            const finish_result = { params: { message: content, status: "SUCCESS" } }
            const result = await finish_action(finish_result, context, task.id);
            // Same as above: record last finish status for thinking.prompt gating.
            try {
              const st = result?.meta?.finish_status || finish_result?.params?.status;
              if (typeof st === "string" && st.length > 0) context.last_finish_status = st;
            } catch (e) {
              // ignore
            }
            return result;
          }
          continue;
        } else if (status === "failure") {
          // IMPORTANT:
          // Treat *test failures* as an expected outcome in dev loops:
          // - do NOT increment retryCount / totalRetryAttempts
          // - do NOT trip "max consecutive exceptions"
          // - still feed the failure output back to the LLM so it can fix code/tests
          const expectedTestFailure = isExpectedTestFailure(action, action_result);

          // Always preserve the run_id marker when present (used for pruning/debugging).
          let sanitizedComments = sanitizeToolReturnForLLM(comments);
          try {
            if (action && action.type === "terminal_run") {
              const runId = getTerminalRunRunId(action, action_result);
              if (runId) {
                sanitizedComments = `${sanitizedComments}\n\n${TERMINAL_RUN_ID_MARKER_PREFIX}${runId}]`;
              }
            }
          } catch (e) {}

          if (expectedTestFailure) {
            // A successful execution of a test runner proves the toolchain works.
            // Reset consecutive technical retry counter.
            retryCount = 0;
            context.retryCount = retryCount;

            context.reflection = sanitizedComments;
            try {
              const state = getOrInitErrorFeedbackState(context);
              state.lastReflectionSource = state.lastReflectionSource || { type: 'other', action: action.type };
            } catch (e) {}

            console.log("code-act.memory logging user prompt (expected test failure, no penalty)");
            await memory.addMessage("user", sanitizeToolReturnForLLM(comments));
            await delay(500);
            console.log("Test runner returned non-zero exit code; continuing without counting as exception.");

            requestedRetry = true;
            requestedRetryNoPenalty = true;
            break;
          }

          // NEW:
          // Do NOT count terminal_run failures with exitCode=1 as "consecutive exceptions".
          // This is useful for common, non-fatal shell conditions (e.g., grep/cat missing file)
          // that the agent can handle logically without tripping the stop mechanism.
          const exitCode = getTerminalRunExitCode(action_result);
          const nonFatalTerminalExit1 =
            action &&
            action.type === "terminal_run" &&
            action_result &&
            action_result.status === "failure" &&
            exitCode === 1;

          if (nonFatalTerminalExit1) {
            // Toolchain worked; reset consecutive technical retry counter.
            retryCount = 0;
            context.retryCount = retryCount;

            context.reflection = sanitizedComments;
            try {
              const state = getOrInitErrorFeedbackState(context);
              state.lastReflectionSource = state.lastReflectionSource || { type: "other", action: action.type };
            } catch (e) {}

            console.log("code-act.memory logging user prompt (terminal_run exitCode=1 treated as non-fatal, no penalty)");
            await memory.addMessage("user", sanitizeToolReturnForLLM(comments));
            await delay(500);
            console.log("terminal_run returned exitCode=1; continuing without counting as exception.");

            requestedRetry = true;
            requestedRetryNoPenalty = true;
            break;
          }

          // Non-test failures keep the existing retry/stop behavior.
          const { shouldContinue, result } = retryHandle(retryCount, totalRetryAttempts, maxRetries, maxTotalRetries, comments);
          if (!shouldContinue) {
            return result;
          }
          retryCount++;
          totalRetryAttempts++;

          context.reflection = sanitizedComments;
          try {
            const state = getOrInitErrorFeedbackState(context);
            state.lastReflectionSource = state.lastReflectionSource || { type: 'other', action: action.type };
          } catch (e) {}

          console.log("code-act.memory logging user prompt");
          await memory.addMessage("user", sanitizeToolReturnForLLM(comments));
          await delay(500);
		  // NOTE: Retry counters are intentionally kept silent to avoid confusing log analysis.
          // if (maxTotalRetries > 0) {
          //  console.log(`Retrying (${retryCount}/${maxRetries}). Total attempts: ${totalRetryAttempts}/${maxTotalRetries}...`);
          //} else {
          //  console.log(`Retrying (${retryCount}/${maxRetries}). Total attempts: ${totalRetryAttempts}...`);
          //}

          requestedRetry = true;
          break;
        }
      } // end for actionsToExecute

      if (requestedRetry) {
        if (requestedRetryNoPenalty) {
          // Do not increment retry counters for expected test failures.
          await delay(500);
        } else {
          await handleRetry();
        }
        continue;
      }



      /**
       * 任务处理
       */


      /**
       * 3. Action parse failed
       * ①. The max_tokens length is not enough, need to continue to supplement and improve
       * ②. The model return format is incorrect, parse action again
       */
      if (!action) {

        // Exceeded maximum length
        console.log("content.length", content.length, MAX_CONTENT_LENGTH);
        if (content.length > MAX_CONTENT_LENGTH) {
          return {
            status: "failure",
            comments: `Model output exception, stopping task`,
          }
        }

        // use retryHandle to handle retry logic
        const { shouldContinue, result } = retryHandle(retryCount, totalRetryAttempts, maxRetries, maxTotalRetries);
        if (!shouldContinue) {
          return result;
        }

        // Feedback invalid format
        // Drop the invalid assistant output so it doesn't get propagated,
        // BUT keep it visible to the model as MESSAGE5 for self-correction.
        let removedAssistant = null;
        try {
          removedAssistant = await memory.removeLastAssistantMessage();
        } catch (e) {
          // ignore
        }
        try {
          const invalidText = removedAssistant && typeof removedAssistant === "object"
            ? (removedAssistant.content || removedAssistant.message || removedAssistant.text)
            : content;
          await memory.addMessage(
            "developer",
            buildInvalidOutputPreview(invalidText)
          );
        } catch (e) {
          // ignore
        }
        // Add a high-priority correction without including the invalid XML.
        {
          const invalidText = removedAssistant && typeof removedAssistant === "object"
            ? (removedAssistant.content || removedAssistant.message || removedAssistant.text)
            : content;
          const unsupportedTool = extractNonXmlToolName(invalidText);
          const msg = isUnsupportedNonXmlToolCall(invalidText)
            ? buildUnsupportedToolCorrectionMessage(unsupportedTool)
            : "Invalid XML/tool output: could not resolve action. " +
                "Output one or more valid XML tool calls with all required arguments. " +
                "If you output multiple tool calls, each one must be valid XML.";
          await memory.addMessage('developer', msg);
        }

        await handleRetry();
        continue;
      }

      // NOTE: execution/reflection handling moved into the per-action loop above.
    } catch (error) {
      // 8. Exception handling
      console.error("An error occurred:", error);

      // 检查是否为需要暂停的错误类型: 积分不足 | LLM 调用失败
      if (isPauseRequiredError(error)) {
        return {
          status: "failure",
          comments: error.message,
          error: error
        };
      }

      // 普通错误处理逻辑
      // use retryHandle to handle retry logic, pass in error message
      const safeErrorMessage = sanitizeToolReturnForLLM(error?.message || String(error));
      await memory.addMessage("user", safeErrorMessage);
      const { shouldContinue, result } = retryHandle(retryCount, totalRetryAttempts, maxRetries, maxTotalRetries, safeErrorMessage);
      if (!shouldContinue) {
        return result;
      }
      retryCount++;
      totalRetryAttempts++;
	  // NOTE: Retry counters are intentionally kept silent to avoid confusing log analysis.
      //if (maxTotalRetries > 0) {
      //  console.log(`Retrying (${retryCount}/${maxRetries}). Total attempts: ${totalRetryAttempts}/${maxTotalRetries}...`);
      //} else {
      //  console.log(`Retrying (${retryCount}/${maxRetries}). Total attempts: ${totalRetryAttempts}...`);
      //}
    }
  }
};

module.exports = exports = completeCodeAct;
