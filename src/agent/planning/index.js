require("module-alias/register");
require("dotenv").config();

const sub_server_request = require('@src/utils/sub_server_request')

const { getDefaultModel } = require('@src/utils/default_model')

const planning = async (goal, options) => {
  const { conversation_id } = options;
  let model_info = await getDefaultModel(conversation_id)
  if (model_info.is_subscribe) {
    let clean_tasks = await planning_server(goal, options)
    return clean_tasks
  }

  let clean_tasks = await planning_local(goal, options)
  return clean_tasks
};

const planning_server = async (goal, options) => {
  const { conversation_id, files, previousResult } = options;
  // const [res, token_usage] = await sub_server_request('/api/sub_server/planning', {
  const res = await sub_server_request('/api/sub_server/planning', {
    goal,
    options
  })

  return res
};

const resolvePlanningPromptBP = require("@src/agent/prompt/plan");
const { resolveMarkdown } = require("@src/utils/markdown");
const resolveThinking = require("@src/utils/thinking");
const retryWithFormatFix = require("./retry_with_format_fix");

// Strict project type selection (planning only)
const ALLOWED_PROJECT_TYPES = new Set([
  "software_development",
  "search",
  "statistical_study",
]);

const normalizeProjectTypeOutput = (text) => {
  if (!text) return "";
  let s = String(text).trim();

  // Strip <think> if present
  if (s.startsWith("<think>")) {
    const { content } = resolveThinking(s);
    s = String(content || "").trim();
  }

  // Strip common wrappers
  s = s.replace(/^```[a-zA-Z0-9_-]*\s*/m, "").replace(/```$/m, "").trim();

  // If JSON-ish, try to extract a field named project_type or the first string value
  // but remain strict: we still require exact match to one of the allowed labels.
  const m = s.match(/"project_type"\s*:\s*"([^"]+)"/i);
  if (m && m[1]) return m[1].trim();

  // Take first non-empty line/token
  const firstLine = s.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || "";
  return firstLine.replace(/^["']|["']$/g, "").trim();
};

const classifyProjectType = async (goal, options, conversation_id) => {
  // Ask LLM for project type using a dedicated planning mode.
  // resolvePlanningPromptBP must map planning_mode='project_type' to planning.project_type.txt
  const classifierPrompt = await resolvePlanningPromptBP(goal, {
    ...options,
    planning_mode: "project_type",
  });

  const processResult = async (raw) => {
    const projectType = normalizeProjectTypeOutput(raw);
    return projectType;
  };
  const validate = (projectType) => ALLOWED_PROJECT_TYPES.has(projectType);

  const projectType = await retryWithFormatFix(
    classifierPrompt,
    processResult,
    validate,
    conversation_id
  );

  if (!ALLOWED_PROJECT_TYPES.has(projectType)) {
    // Hard fail as requested (no silent fallback)
    throw new Error(
      `Invalid project type from LLM: "${projectType}". Expected one of: software_development, search, statistical_study.`
    );
  }

  return projectType;
};

const mapProjectTypeToPlanningMode = (projectType) => {
  // planning_mode values must be supported by resolvePlanningPromptBP template resolver.
  // We map project_type -> planning.<project_type>.txt (hard fail if missing).
  switch (projectType) {
    case "software_development":
      // planning.software_development.txt
      return "software_development";
    case "search":
      // planning.search.txt
      return "search";
    case "statistical_study":
      // planning.statistical_study.txt
      return "statistical_study";
    default:
      return null;
  }
};

const planning_local = async (goal, options = {}) => {
  const { conversation_id } = options;
  // 1) Select project type (hard fail if invalid)
  const project_type = await classifyProjectType(goal, options, conversation_id);
  const planning_mode = mapProjectTypeToPlanningMode(project_type);
  if (!planning_mode) {
    throw new Error(
      `No planning_mode mapping for project type: "${project_type}".`
    );
  }

  // 2) Resolve planning prompt (hard fail if template not found)
  let prompt;
  try {
    // For "default", keep compatibility: pass planning_mode only if resolver expects it.
    const promptOptions =
      planning_mode === "default"
        ? { ...options, project_type }
        : { ...options, project_type, planning_mode };
    prompt = await resolvePlanningPromptBP(goal, promptOptions);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(
      `Planning prompt template not found or failed to resolve for project_type="${project_type}" (planning_mode="${planning_mode}"): ${msg}`
    );
  }

  // 结果处理器
  const processResult = async (markdown) => {
    // 处理 thinking 标签
    if (markdown && markdown.startsWith('<think>')) {
      const { content: output } = resolveThinking(markdown);
      markdown = output;
    }
    const tasks = await resolveMarkdown(markdown);
    return tasks || [];
  };
  // 验证函数
  const validate = (tasks) => Array.isArray(tasks) && tasks.length > 0;

  return await retryWithFormatFix(prompt, processResult, validate, conversation_id);
}
module.exports = exports = planning;
