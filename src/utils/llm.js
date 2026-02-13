const { getDefaultModel } = require('@src/utils/default_model')

const createLLMInstance = require("@src/completion/llm.one.js");
const parseJSON = require("./json.js");
const { PauseRequiredError } = require("@src/utils/errors");

const calcToken = require('@src/completion/calc.token.js')
const Conversation = require('@src/models/Conversation.js')


const defaultOnTokenStream = (ch) => {
  process.stdout.write(ch);
}

const DEFAULT_MODEL_TYPE = "assistant";
const REASONING_MODEL_TYPE = "reasoning";

const LLM_LOGS = require('@src/models/LLMLogs.js');

/**
 * @param {*} prompt 
 * @param {*} model_type 
 * @param {*} options 
 * @param {*} onTokenStream 
 * @returns {Promise<Object>}
 */
const call = async (prompt, conversation_id, model_type = DEFAULT_MODEL_TYPE, options = { temperature: 0 }, onTokenStream = defaultOnTokenStream) => {
  const model_info = await getDefaultModel(conversation_id, model_type)
  const model = `provider#${model_info.platform_name}#${model_info.model_name}`;
// Note: we will wrap `onTokenStream` below to add log boundaries for the real LLM output.
  //const llm = await createLLMInstance(model, onTokenStream, { model_info });


  // 判断模型
  //if (model_info.model_name === 'deepseek-v3-250324') {
  //  options.max_tokens = 16000;
  //} else if (model_info.model_name === 'deepseek-v3-1-250821') {
  //  options.max_tokens = 32000;
  //}
  
  const { response_format, messages = [], ...restOptions } = options;
  const context = { messages };

  // Inject /no_think when the *model configuration* has "reasoning" checked in UI.
  // This is independent from model_type (assistant vs reasoning_model_id per conversation).
  const modelTypes = Array.isArray(model_info.model_types) ? model_info.model_types : [];
  const isReasoningCheckedInUI = modelTypes.includes(REASONING_MODEL_TYPE);
  const isQwen3 = (typeof model_info.model_name === 'string' && model_info.model_name.includes('qwen3'));
  
  if (isReasoningCheckedInUI && isQwen3) {
    // User requirement: append "/no_think" at the end of the LAST message of the history.
    if (Array.isArray(messages) && messages.length > 0) {
      const lastIdx = messages.length - 1;
      const lastMsg = messages[lastIdx];
      if (lastMsg && typeof lastMsg.content === 'string') {
        // Avoid duplicates if something already appended it upstream.
        if (!lastMsg.content.includes('\n/no_think') && !lastMsg.content.endsWith('/no_think')) {
          lastMsg.content = `${lastMsg.content}\n/no_think`;
        }
      }
    } else if (prompt) {
      // Fallback: if there is no messages history, append to prompt.
      if (!prompt.includes('\n/no_think') && !prompt.endsWith('/no_think')) {
        prompt = `${prompt}\n/no_think`;
      }
    }
  }

  //const content = await llm.completion(prompt, context, restOptions);

  // Keep the same input prompt string for token accounting.
  // Prompt logging is performed in llm.base.js (single source of truth: exact messages payload).
  const inputPromptForLog = (messages || []).map(item => item.content).join('\n') + '\n' + (prompt || '');

  // Option A: open [SORTIE LLM] on the *first streamed token* so that
  // framework logs (e.g. "prompt http call") won't be captured inside [SORTIE LLM].
  let outputTagOpened = false;
  const wrappedOnTokenStream = (ch) => {
    if (!outputTagOpened) {
      outputTagOpened = true;
      process.stdout.write(`[SORTIE LLM]\n`);
    }
    onTokenStream(ch);
  };

  const llm = await createLLMInstance(model, wrappedOnTokenStream, { model_info });

  let content;
  try {
    content = await llm.completion(prompt, context, restOptions);
  } finally {
    // Close the output tag even if the LLM call throws.
    // If the model produced no streamed token, still emit empty output boundaries.
    if (!outputTagOpened) {
      process.stdout.write(`[SORTIE LLM]\n`);
      outputTagOpened = true;
    }
    process.stdout.write(`\n[/SORTIE LLM]\n`);
  }


  // 处理 ERR_BAD_REQUEST 错误
  if (typeof content === 'string' && content.startsWith('ERR_BAD_REQUEST')) {
    throw new PauseRequiredError("LLM Call Failed");
  }

  //const inputPrompt = messages.map(item => item.content).join('\n') + '\n' + prompt;
  const inputPrompt = inputPromptForLog;
  const input_tokens = calcToken(inputPrompt)
  const output_tokens = calcToken(content)
  if (conversation_id) {
    const conversation = await Conversation.findOne({ where: { conversation_id: conversation_id } })
    if (conversation) {
      // @ts-ignore
      conversation.input_tokens = conversation.input_tokens + input_tokens
      // @ts-ignore
      conversation.output_tokens = conversation.output_tokens + output_tokens
      await conversation.save()
    }
  }

  if (response_format === 'json') {
    const json = parseJSON(content);
    // @ts-ignore
    await LLM_LOGS.create({ model, prompt, messages, content, json, conversation_id });
    return json;
  }
  // @ts-ignore
  await LLM_LOGS.create({ model, prompt, messages, content, conversation_id });
  //return content
  return content;
}

module.exports = exports = call;
