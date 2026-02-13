/* eslint-disable no-console */
const extractTemplateVariables = (template) => {
  // Match ONLY non-escaped template variables: {var} but not \{var}
  const regex = /(?<!\\)\{([^}]+)\}/g;
  const set = new Set();
  let match;

  while ((match = regex.exec(template))) {
    const variable = match[1].trim();
    set.add(variable);
  }
  return Array.from(set);
}

const preprocessValue = (value, variables) => {
  // Avoid mutating the original input object (can be reused by callers)
  const out = { ...(value || {}) };
  for (const variable of variables) {
    if (out[variable] === undefined) {
      out[variable] = '';
    }
    if (typeof out[variable] !== 'string') {
      out[variable] = JSON.stringify(out[variable]);
    }
  }
  return out;
}

const parseTemplate = (template, data) => {
  // Replace ONLY non-escaped variables: {var} but not \{var}
  return template.replace(/(?<!\\)\{([^}]+)\}/g, (match, variable) => {
    const trimmedVariable = variable.trim();
    if (data.hasOwnProperty(trimmedVariable)) {
      return data[trimmedVariable];
    } else {
      // 如果变量未在数据对象中找到，保留原始模板变量
      return match;
    }
  });
}

const resolveTemplate = async (template, value = {}) => {
  const variables = extractTemplateVariables(template);
  const normalized = preprocessValue(value, variables);
  const prompt = parseTemplate(template, normalized);
  return prompt;
}

const fs = require('fs');
const path = require('path');
// 确保临时目录存在
const { getDirpath } = require('@src/utils/electron');
const cache_dir = getDirpath('Caches/template');
fs.mkdirSync(cache_dir, { recursive: true }); // 创建目录，如果已存在则不做任何操作

// Normalize Windows/Mac newlines to LF to avoid log bloat and prompt inflation.
// - CRLF (\r\n) -> LF (\n)
// - CR   (\r)   -> LF (\n)
const normalizeNewlines = (s) => {
  if (typeof s !== 'string') return s;
  // First collapse CRLF, then remaining CR (classic Mac) to LF.
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

const loadTemplate = async (filename) => {
  try {
    const cache_file = path.resolve(cache_dir, filename);
    console.log('cache_file', cache_file);
    if (fs.existsSync(cache_file)) {
      return normalizeNewlines(fs.readFileSync(cache_file, 'utf8'));
    }
    // Primary location (this repo): app/src/template/<filename>
    const primaryPath = path.resolve(__dirname, '../template', filename);
    if (fs.existsSync(primaryPath)) {
      return normalizeNewlines(fs.readFileSync(primaryPath, 'utf8'));
    }

    // Fallback location (some setups may still reference src/template/<filename>)
    const fallbackPath = path.resolve(__dirname, '../../template', filename);
    if (fs.existsSync(fallbackPath)) {
      return normalizeNewlines(fs.readFileSync(fallbackPath, 'utf8'));
    }

    console.error('[template.loadTemplate] template not found:', {
      filename,
      primaryPath,
      fallbackPath,
      cache_file
    });
    // Hard fail: callers (e.g., planning) must stop if the prompt template is missing.
    const err = new Error(`Template not found: ${filename}`);
    err.code = 'TEMPLATE_NOT_FOUND';
    err.meta = { filename, primaryPath, fallbackPath, cache_file };
    throw err;
  } catch (error) {
    console.error('[template.loadTemplate] failed to load template:', filename, error?.message || error);
    // Hard fail: do not silently continue with empty templates.
    throw error instanceof Error ? error : new Error(String(error));
  }
}

module.exports = exports = {
  extractTemplateVariables,
  resolveTemplate,
  loadTemplate
}