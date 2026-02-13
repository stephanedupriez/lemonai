require('dotenv').config()
require("module-alias/register");
const DefaultModelSetting = require('@src/models/DefaultModelSetting');
const Model = require('@src/models/Model');
const Plantform = require('@src/models/Platform');
const Conversation = require('@src/models/Conversation')

const _defaultModelCache = {};

const _fetchDefaultModel = async (type = 'assistant') => {
  const defaultModelSetting = await DefaultModelSetting.findOne({ where: { setting_type: type } });
  if (!defaultModelSetting) return null;
  const model = await Model.findOne({ where: { id: defaultModelSetting.dataValues.model_id } });
  if (!model) return null;
  const model_name = model.dataValues.model_id;
  const platform = await Plantform.findOne({ where: { id: model.dataValues.platform_id } });
  if (!platform) return null;

  const api_key = platform.dataValues.api_key;
  const base_url = platform.dataValues.api_url
  let api_url = platform.dataValues.api_url;
  if (type === 'assistant') {
    api_url = platform.dataValues.api_url + '/chat/completions';
  }
  const platform_name = platform.dataValues.name;

  return { model_name, model_types, platform_name, api_key, api_url, base_url: base_url, is_subscribe: false };
};

/**
 * Retourne le modèle à utiliser pour une conversation.
 * - Par défaut: modèle "rapide" = conversation.model_id
 * - Si model_type === 'reasoning': on utilise conversation.reasoning_model_id si défini, sinon fallback sur model_id
 *
 * @param {string} conversation_id
 * @param {string} model_type
 */
const getDefaultModel = async (conversation_id, model_type = 'assistant') => {
  const conversation = await Conversation.findOne({ where: { conversation_id } })
  if (!conversation) return null;

  const useReasoning = (model_type === 'reasoning');
  const chosenModelId = useReasoning
    ? (conversation.dataValues.reasoning_model_id || conversation.dataValues.model_id)
    : conversation.dataValues.model_id;

  const model = await Model.findOne({ where: { id: chosenModelId } });
  if (!model) return null;
  const model_name = model.dataValues.model_id;
  const model_types = model.dataValues.model_types;
  const platform = await Plantform.findOne({ where: { id: model.dataValues.platform_id } });
  if (!platform) return null;

  const api_key = platform.dataValues.api_key;
  const base_url = platform.dataValues.api_url
  let api_url = platform.dataValues.api_url;
  api_url = platform.dataValues.api_url + '/chat/completions';
  const platform_name = platform.dataValues.name;

  return { model_name, model_types, platform_name, api_key, api_url, base_url: base_url, is_subscribe: platform.is_subscribe };
};

const getCustomModel = async (model_id) => {

  const model = await Model.findOne({ where: { model_id: model_id } });
  if (!model) return null;
  const model_name = model.dataValues.model_id;
  const model_types = model.dataValues.model_types;
  const platform = await Plantform.findOne({ where: { id: model.dataValues.platform_id } });
  if (!platform) return null;

  const api_key = platform.dataValues.api_key;
  const base_url = platform.dataValues.api_url
  let api_url = platform.dataValues.api_url;
  api_url = platform.dataValues.api_url + '/chat/completions';
  const platform_name = platform.dataValues.name;

  return { model_name, model_types, platform_name, api_key, api_url, base_url: base_url, is_subscribe: false };

};

const updateDefaultModel = async (type = 'assistant') => {
  const modelInfo = await _fetchDefaultModel(type);
  if (modelInfo) {
    _defaultModelCache[type] = modelInfo;
  }
  return modelInfo;
};

module.exports = {
  getDefaultModel,
  updateDefaultModel,
  getCustomModel,
};