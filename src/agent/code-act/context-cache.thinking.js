require('dotenv').config();

const resolveThinkingPrompt = require("./thinking.prompt");
const resolveThinking = require("@src/utils/thinking");
const handleLLMResponseLog = require("./context-cache.llm.message");
const { deductPoints } = require('@src/utils/point')
const { PauseRequiredError } = require("@src/utils/errors");
const { normalizeLLMToolOutputToXML } = require('@src/xml');

const call = async (llm, prompt, messages, context = {}) => {
  const { conversation_id, user_id } = context;
  if (!prompt && messages.length > 0) {
    const message = messages[messages.length - 1];
    prompt = message.role === 'user' ? message.content : 'continue';
  }

  const content = await llm.chat(prompt, {
    sessionId: conversation_id,
    stream: true,
  });
  await handleLLMResponseLog(llm, prompt, conversation_id, messages);

  const usage = llm.usage;
  if (user_id && usage.input_tokens > 0) {
    const { notEnough } = await deductPoints(user_id, usage, conversation_id);
    if (notEnough) {
      throw new PauseRequiredError('Insufficient credits balance');
    }
  }

  return content;
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

const thinking = async (requirement, context = {}, llm) => {
  const { memory, retryCount } = context;
  const summarize = false;
  const messages = await memory.getMessages(summarize);
  if (retryCount > 0) {
    console.log('retryCount', retryCount);
  }

  // Build the system prompt at EVERY inference so dynamic placeholders
  // (e.g. {workspace_files}) are refreshed each turn.
  const prompt = await resolveThinkingPrompt(requirement, context);
  global.logging(context, 'thinking', prompt);

  // Persist the system prompt to memory ONLY once (first turn),
  // otherwise it will bloat memory and duplicate system instructions.
  const shouldPersistPromptToMemory = (messages.length === 0);

  global.logging(context, 'thinking', JSON.stringify(messages, null, 2));

  const content = await call(llm, prompt, messages, context);
  global.logging(context, 'thinking', content);
  if (shouldPersistPromptToMemory && prompt) {
    await memory.addMessage('user', prompt);
  }

  if (content && content.startsWith('<think>')) {
    const { thinking: extractedThinking, content: output } = resolveThinking(content);
//
    context.last_thinking = extractedThinking;
//
    const outputNormalized = normalizeAssistantOutputForMemory(output);
    await memory.addMessage('assistant', outputNormalized);
    return outputNormalized;
  }
  const contentNormalized = normalizeAssistantOutputForMemory(content);
  await memory.addMessage('assistant', contentNormalized);
  return contentNormalized;
}

module.exports = exports = thinking;