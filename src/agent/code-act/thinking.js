require('dotenv').config();

const crypto = require('crypto');
const resolveThinkingPrompt = require("./thinking.prompt");
const resolveThinking = require("@src/utils/thinking");
const { getDefaultModel } = require('@src/utils/default_model')
const { normalizeLLMToolOutputToXML } = require('@src/xml');

const call = require("@src/utils/llm");
const THINKING_MODEL_TYPE = 'reasoning';

const chat_completion = require('@src/agent/chat-completion/index')

const extractOutput = (content, context) => {
  if (content && content.startsWith('<think>')) {
    const { thinking: extractedThinking, content: output } = resolveThinking(content);
    // On stocke le thinking si présent (utile UI/debug)
    context.last_thinking = extractedThinking;
    return output;
  }
  return content;
};

/**
 * Best-effort extraction of <finish><status>...</status> from the assistant XML.
 *
 * Why here?
 * - We normalize and persist the assistant XML in memory at this layer.
 * - Later stages (prompt assembly) may want to know whether the previous goal
 *   ended in SUCCESS or FAILED in order to decide whether to show === Error Feedback ===.
 *
 * This does NOT replace the runtime validation (finish_action enforces strict values).
 * It only persists a hint on the context object for downstream prompt gating.
 */
const maybeExtractFinishStatus = (outputXml, context) => {
  if (!outputXml || typeof outputXml !== 'string') return;
  try {
    // Keep the regex intentionally tolerant about whitespace/newlines.
    const m = outputXml.match(/<finish>\s*(?:[\s\S]*?)<status>\s*([^<]+?)\s*<\/status>/i);
    if (!m || !m[1]) return;
    const st = String(m[1]).trim();
    if (st) context.last_finish_status = st;
  } catch (_) {
    // Best-effort: never break the agent if parsing fails.
  }
};


/**
 * Normalize LLM tool outputs into canonical LemonAI XML BEFORE persisting to memory.
 * This ensures LocalMemory can compute stable pruning keys even when the model
 * outputs JSON-in-XML-body (e.g. <terminal_run>{...}</terminal_run>).
 */
const normalizeAssistantOutputForMemory = (output) => {
  if (!output || typeof output !== 'string') return output;
  try {
    const normalized = normalizeLLMToolOutputToXML(output);
    return (typeof normalized === 'string' && normalized.trim()) ? normalized : output;
  } catch (_) {
    // Best-effort only: never break the agent if normalization fails.
    return output;
  }
};

/**
 * Force the "system prompt" to be message index 0 for the LLM call,
 * without persisting it into the conversation memory.
 *
 * This prevents prompt duplication later in the message list (e.g. after write_code).
 */
const withPromptAsMessage0 = (messages, prompt) => {
  const out = Array.isArray(messages) ? [...messages] : [];
  const promptMsg = { role: 'user', content: String(prompt || '') };

  // IMPORTANT:
  // Do NOT overwrite out[0]. Overwriting drops the first real conversation message
  // (e.g. the previous assistant XML such as <write_code>...</write_code>), which causes
  // regressions where the LLM cannot see what it wrote in the previous turn.
  //
  // Instead, prepend the prompt as message[0] while keeping the rest of the history intact.
  if (out.length > 0) {
    const first = out[0];
    // Avoid duplicating the same prompt if a caller accidentally already prepended it.
    if (
      first &&
      typeof first === 'object' &&
      first.role === promptMsg.role &&
      typeof first.content === 'string' &&
      first.content === promptMsg.content
    ) {
      return out;
    }
  }

  out.unshift(promptMsg);
  return out;
};

// Best-effort extraction of current task id for operator log correlation (not sent to the model).
// This is propagated to the LLM call options so llm.base.js can log it on each [MESSAGE...].
const resolveTaskIdForLLMOptions = (context = {}) => {
  try {
    const candidates = [
      context.task_id,
      context.current_task_id,
      context.taskId,
      context.currentTaskId,
      context.task && context.task.id,
      context.task && context.task.task_id,
      context.task && context.task.taskId,
      context.requirement && context.requirement.id,
    ];
    for (const c of candidates) {
      if (c === undefined || c === null) continue;
      const s = String(c).trim();
      if (s) return s;
    }
  } catch (_) {}
  return undefined;
};

const thinking = async (requirement, context = {}) => {

  // Task Goal phase: use the reasoning model deterministically.
  // No tool detection / no fast-pass retry.
  let model_info = await getDefaultModel(context.conversation_id, THINKING_MODEL_TYPE)

  if (model_info.is_subscribe) {
    let content = await thinking_server(requirement, context)
    return content
  }
  let content = await thinking_local(requirement, context)
  return content
}

const thinking_server = async (requirement, context = {}) => {
  const { memory, retryCount } = context;
  // console.log('memory', memory);
  const summarize = false;
  const messages = await memory.getMessages(summarize);
  if (retryCount > 0) {
    // Retry with user reply
    console.log('retryCount', retryCount);
    // messages.pop();
  }

  // If last message is assistant, return directly, support quickly playback and run action
  const message = messages[messages.length - 1];
  if (message && message.role === 'assistant') {
    // return message.content;
  }

  // Use LLM thinking to instruct next action
  let prompt = '';
  // IMPORTANT: prompt is contextual (build vs codecorrector). We must rebuild it when mode changes,
  // not only on the very first message.
  prompt = await resolveThinkingPrompt(requirement, context);
  global.logging(context, 'thinking', prompt);

  // Single reasoning pass (task goal)
  const task_id = resolveTaskIdForLLMOptions(context);
  const options = {
    messages: withPromptAsMessage0(messages, prompt),
    ...(task_id ? { task_id } : {}),
  };
  // IMPORTANT: prompt must be provided ONLY via options.messages[0] to avoid double-injection.
  const content = await chat_completion('', options, context.conversation_id, undefined, THINKING_MODEL_TYPE);
  global.logging(context, 'thinking_reasoning', content);

  const output = extractOutput(content, context);
  const outputNormalized = normalizeAssistantOutputForMemory(output);
  maybeExtractFinishStatus(outputNormalized, context);
  await memory.addMessage('assistant', outputNormalized);
  return outputNormalized;
}

const thinking_local = async (requirement, context = {}) => {
  const { memory, retryCount } = context;
  // console.log('memory', memory);
  const summarize = false;
  const messages = await memory.getMessages(summarize);
  if (retryCount > 0) {
    // Retry with user reply
    console.log('retryCount', retryCount);
    // messages.pop();
  }

  // If last message is assistant, return directly, support quickly playback and run action
  const message = messages[messages.length - 1];
  if (message && message.role === 'assistant') {
    // return message.content;
  }

  // Use LLM thinking to instruct next action
  let prompt = '';
  // IMPORTANT: prompt is contextual (build vs codecorrector). We must rebuild it when mode changes,
  // not only on the very first message.
  prompt = await resolveThinkingPrompt(requirement, context);
  global.logging(context, 'thinking', prompt);


  // Single reasoning pass (task goal)
  const task_id = resolveTaskIdForLLMOptions(context);
  const options = {
    messages: withPromptAsMessage0(messages, prompt),
    ...(task_id ? { task_id } : {}),
  };
  // IMPORTANT: prompt must be provided ONLY via options.messages[0] to avoid double-injection.
  const content = await call('', context.conversation_id, THINKING_MODEL_TYPE, options);
  global.logging(context, 'thinking_reasoning', content);

  const output = extractOutput(content, context);
  const outputNormalized = normalizeAssistantOutputForMemory(output);
  maybeExtractFinishStatus(outputNormalized, context);
  await memory.addMessage('assistant', outputNormalized);
  return outputNormalized;
}

module.exports = exports = thinking;