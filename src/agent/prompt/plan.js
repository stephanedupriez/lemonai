const { resolveTemplate, loadTemplate } = require("@src/utils/template");
const { resolvePlanningKnowledge } = require("@src/knowledge/index");

const describeUploadFiles = files => {
  let content = ''
  if (!Array.isArray(files)) return content;
  for (let file of files) {
    content += 'upload/' + file.name + "\n"
  }
  return content;
}

const resolveTemplateFilename = (planning_mode) => {
  // Backward-compatible defaults:
  // - undefined / null / '' / 'base' / 'default' => planning.txt
  if (!planning_mode || planning_mode === 'base' || planning_mode === 'default') {
    return 'planning.txt'
  }
  return `planning.${planning_mode}.txt`
}

const resolvePlanningPrompt = async (goal, options) => {
  const { files, previousResult, agent_id, planning_mode, project_type } = options;

  const templateFilename = resolveTemplateFilename(planning_mode);
  // loadTemplate MUST throw if the template file does not exist (hard fail)
  const promptTemplate = await loadTemplate(templateFilename);
  const system = `Current Time: ${new Date().toLocaleString()}`
  const uploadFileDescription = describeUploadFiles(files);
  // 尝试不使用experience
  // const experiencePrompt = await resolveExperiencePrompt(goal, conversation_id)
  const experiencePrompt = ''
  const best_practice_knowledge = await resolvePlanningKnowledge({ agent_id });
  const prompt = await resolveTemplate(promptTemplate, {
    goal,
    files: uploadFileDescription,
    previous: previousResult,
    system,
    experiencePrompt,
    best_practice_knowledge,
    project_type,
  })
  return prompt;
}

module.exports = exports = resolvePlanningPrompt;