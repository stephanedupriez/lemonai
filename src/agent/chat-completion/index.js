require("module-alias/register");
require("dotenv").config();


const call = require("@src/utils/llm");
const { getDefaultModel } = require('@src/utils/default_model')
const resolveAutoReplyPrompt = require('@src/agent/prompt/auto_reply.js');
const sub_server_request = require('@src/utils/sub_server_request')
const conversation_token_usage = require('@src/utils/get_sub_server_token_usage')

// model_type: 'assistant' (rapide) ou 'reasoning' (2e modèle)
const chat_completion = async (question, options, conversation_id, onTokenStream, model_type = 'assistant') => {
  let model_info = await getDefaultModel(conversation_id, model_type)
  if (model_info.is_subscribe) {
    let replay = await chat_completion_server(question, options, conversation_id, onTokenStream, model_type)
    return replay
  }
  return chat_completion_local(question, options, conversation_id, onTokenStream, model_type)
}

const chat_completion_server = async (question, options, conversation_id, onTokenStream, model_type = 'assistant') => {
  // let [res, token_usage] = await sub_server_request('/api/sub_server/auto_reply', {
  let res = await sub_server_request('/api/sub_server/chat_completion', {
    question,
    options,
    conversation_id,
    model_type,
  })
  if (onTokenStream) {
    onTokenStream(res)
  }
  return res
};

const chat_completion_local = async (question, options, conversation_id, onTokenStream, model_type = 'assistant') => {
  // Call the model to get a response in English based on the goal

  const abortController = new AbortController();
  const signal = abortController.signal;
  options.signal = signal;
  return call(question, conversation_id, model_type, options, onTokenStream);
}



module.exports = exports = chat_completion;
