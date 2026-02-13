const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const resolveToolPrompt = require('@src/agent/prompt/tool');

function sanitizeToolReturnForLLM(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  // Remove absolute conversation workspace paths, e.g.:
  // /workspace/user_1/Conversation_75c470/...
  return text.replace(/\/workspace\/user_\d+\/Conversation_[^\/\s'"]+\/?/g, "");
}

function normalizeConversationDirName(conversationId) {
  const s = (conversationId ?? '').toString().trim();
  if (!s) return '';
  if (s.startsWith('Conversation_')) return s;
  // In Lemon, conversation folder is often derived from the first 6 chars.
  // Keep existing behavior if already short, otherwise slice to 6.
  const token = s.length > 6 ? s.slice(0, 6) : s;
  return `Conversation_${token}`;
}

async function existsDir(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch (_) {
    return false;
  }
}

function shouldSkipPath(relPosix) {
  const norm = (relPosix || '').replace(/\\/g, '/');
  if (!norm) return true;
  // Skip compiled python artifacts
  if (norm.endsWith('.pyc')) return true;
  
  // Skip orchestrator artifact(s)
  if (norm === 'todo.md' || norm === './todo.md' || norm.endsWith('/todo.md')) return true;
  // Skip heavy / irrelevant dirs
  const deny = [
    /^\.\/?\.git(\/|$)/,
    /^\.\/?node_modules(\/|$)/,
    /^\.\/?__pycache__(\/|$)/,
    /^\.\/?\.venv(\/|$)/,
    /^\.\/?venv(\/|$)/,
    /^\.\/?dist(\/|$)/,
    /^\.\/?build(\/|$)/,
    /^\.\/?target(\/|$)/,
    /^\.\/?\.cache(\/|$)/,
  ];
  return deny.some((re) => re.test(norm));
}

async function resolveConversationWorkspaceRoot(context) {
  // Prefer explicit runtime cwd/workspace if present (should already point to Conversation_xxx).
  const candidates = [
    context?.runtime?.resolved_cwd,
    context?.runtime?.cwd,
    context?.runtime?.workspace_dir,
    context?.workspace_dir,
    context?.conversation_workspace_dir,
  ].map((v) => (v ?? '').toString().trim()).filter(Boolean);

  for (const c of candidates) {
    if (c && await existsDir(c)) return c;
  }

  // Derive from /workspace layout.
  const convDirName = normalizeConversationDirName(context?.conversation_id);
  if (convDirName) {
    // Fast path for common single-user case.
    const p1 = path.posix.join('/workspace', 'user_1', convDirName);
    if (await existsDir(p1)) return p1;

    // Best-effort: scan /workspace/user_* for the conversation directory.
    try {
      const entries = await fsp.readdir('/workspace', { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (!/^user_\d+$/.test(ent.name)) continue;
        const p = path.posix.join('/workspace', ent.name, convDirName);
        if (await existsDir(p)) return p;
      }
    } catch (_) {
      // ignore
    }
  }

  return '';
}

async function listConversationFilesForPrompt(context, { maxDepth = 2, maxFiles = 200 } = {}) {
  const rootDir = await resolveConversationWorkspaceRoot(context);
  if (!rootDir) return '';

  const files = [];
  async function walk(relDir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fsp.readdir(path.join(rootDir, relDir), { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const ent of entries) {
      if (files.length >= maxFiles) return;
      const relPath = relDir ? path.join(relDir, ent.name) : ent.name;
      const relPosix = relPath.replace(/\\/g, '/');
      if (shouldSkipPath(relPosix)) continue;
      if (ent.isDirectory()) {
        if (shouldSkipPath(relPosix + '/')) continue;
        await walk(relPath, depth + 1);
      } else if (ent.isFile()) {
        files.push(`./${relPosix}`);
      }
    }
  }

  await walk('', 0);
  files.sort((a, b) => a.localeCompare(b));
  return files.join('\n');
}


// 提示词转换函数
const { describeLocalMemory, loadConversationMemory, describeUploadFiles, describeSystem } = require("./thinking.util");

const resolveServers = require("@src/mcp/server.js");
const { resolveMcpServerPrompt } = require("@src/mcp/prompt.js");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const { resolveThinkingKnowledge } = require("@src/knowledge/index");

// 模板加载解析
const { resolveTemplate, loadTemplate } = require("@src/utils/template");

const { resolveEvaluateOptions } = require("./evaluate.prompt");

const resolveRoleHeader = async (context = {}) => {
  const mode = (context.prompt_mode || 'build').toLowerCase();
  // Default to build header if mode is unknown.
  const filename =
    (mode === 'codecorrector' || mode === 'error_correction' || mode === 'error') ?
      'thinking_header_codecorrector.txt' :
      'thinking_header_build.txt';
  try {
    return await loadTemplate(filename);
  } catch (e) {
    // Fail-safe: keep agent functional even if header files are missing.
    // Returning empty header is safer than throwing here (would break the whole loop).
    console.error('[thinking.prompt] Failed to load role header template:', filename, e?.message || e);
    return '';
  }
};

const resolveRootTaskGoal = (context = {}) => {
  // Root Task must always be present, including in code correction mode.
  // In correction mode, the header/prompt should instruct the model to treat it
  // as secondary guidance, but it should not be removed from the prompt.
  return context.goal || '';
};


const resolveThinkingPrompt = async (requirement = '', context = {}) => {

  const { reflection: rawReflection = '', goal = '', depth = 1 } = context;
  global.logging(context, 'thinking.prompt', `goal: ${goal}`);
  const reflection = sanitizeToolReturnForLLM(rawReflection);

  const memory = await describeLocalMemory(context);
  const tools = await resolveToolPrompt(); // system tools
  const servers = await resolveServers(context);
  const mcpToolsPrompt = await resolveMcpServerPrompt(servers); // mcp server tools
  // console.log("mcpToolsPrompt", mcpToolsPrompt);
  const uploadFileDescription = describeUploadFiles(context.files || []);
  const previousResult = await loadConversationMemory(context.conversation_id);
  const app_ports = JSON.stringify([context.runtime.app_port_1, context.runtime.app_port_2])
  const system = describeSystem();
  const knowledge = await resolveThinkingKnowledge(context);
  const role_header = await resolveRoleHeader(context);
  const root_task_goal = resolveRootTaskGoal(context);
  const workspace_files = await listConversationFilesForPrompt(context);

  const thinking_options = {
    system, // 系统信息
    app_ports, // 端口信息
    previous: previousResult, // 前置记录结果
    memory, // 执行记录
    files: uploadFileDescription, // 上传文件信息
    goal: root_task_goal, // Root Task (always present)
    requirement, // 当前需求
    reflection, // 反馈信息
    best_practices_knowledge: knowledge,
    tools: tools + '\n' + mcpToolsPrompt, // 工具列表
    role_header, // Prompt header (build vs codecorrector)
	workspace_files, // Conversation workspace file list (updated each inference)
  }

  // 动态评估提示词
  const evaluate_options = await resolveEvaluateOptions(context);
  Object.assign(thinking_options, evaluate_options)
  global.logging(context, 'thinking.prompt', `evaluate_options.current_plan: ${evaluate_options.current_plan}`);

  const promptTemplate = await loadTemplate('thinking.txt');
  let thinking_prompt = await resolveTemplate(promptTemplate, thinking_options)

  // If the previous goal was explicitly SUCCESS, remove the entire Error Feedback block
  // from the prompt to avoid cognitive "error anchoring" on stale issues.
  // The finish action now requires an explicit status (SUCCESS|FAILED).
  // - SUCCESS => do not carry error feedback forward
  // - FAILED  => keep error feedback for the next goal
  const lastFinishStatusRaw =
    context?.last_finish_status ??
    context?.lastFinishStatus ??
    context?.finish_status ??
    context?.finishStatus;
  const lastFinishStatus =
    typeof lastFinishStatusRaw === "string" ? lastFinishStatusRaw.trim().toUpperCase() : "";
  if (lastFinishStatus === "SUCCESS") {
    // Remove only the Error Feedback section (including its content and trailing END marker).
    thinking_prompt = thinking_prompt.replace(
      // Be tolerant to Windows newlines (\r\n) and ensure we remove the whole block reliably.
      /\r?\n=== Error Feedback ===\r?\n[\s\S]*?\r?\n=== END ===\r?\n?/,
      "\n"
    );
  }

  return thinking_prompt;
}

module.exports = resolveThinkingPrompt;