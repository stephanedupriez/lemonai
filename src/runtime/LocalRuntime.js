function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    try {
      return String(value);
    } catch (__) {
      return '[unstringifiable]';
    }
  }
}

function buildTerminalRunEmptyFailureFallback(action, uuid, task_id, details) {
  const params = action?.params || {};
  const { command, args = [], cwd = '.' } = params;
  const lines = [];
  lines.push('terminal_run failed but no output was captured.');
  lines.push('');
  lines.push('Diagnostics:');
  lines.push(`- task_id: ${task_id || ''}`);
  lines.push(`- uuid: ${uuid || ''}`);
  lines.push(`- command: ${command || ''}`);
  lines.push(`- args: ${Array.isArray(args) ? safeStringify(args) : String(args ?? '')}`);
  lines.push(`- cwd: ${cwd || ''}`);
  lines.push('');
  lines.push('Runtime details (best effort):');
  lines.push(safeStringify(details));
  return lines.join('\n');
}


function sanitizeToolReturnForLLM(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Remove absolute conversation workspace paths, e.g.:
  // /workspace/user_1/Conversation_75c470/...
  return text.replace(/\/workspace\/user_\d+\/Conversation_[^\/\s'"]+\/?/g, '');
}

function buildVisibleActionResultText(result) {
  // IMPORTANT:
  // - Some runtimes put stdout in `content` (success path)
  // - Some runtimes put tracebacks/exception output in `error` (failure path)
  // - Some infra failures only populate `comments`
  // We must always return a non-empty diagnostic string when possible.
  if (!result || typeof result !== 'object') return '';

  let text =
    (typeof result.content === 'string' && result.content) ||
    (typeof result.stderr === 'string' && result.stderr) ||
    (typeof result.error === 'string' && result.error) ||
    (typeof result.comments === 'string' && result.comments) ||
    '';

  // Fallback for commands that legitimately have no stdout (rm, mkdir, etc.)
  if (!text && result.status === 'success') {
    text = 'Execution result has no return content';
  }

  return sanitizeToolReturnForLLM(text);
}


function classifyReadFileErrorKind(err) {
  const code = err && (err.code || err.errno) ? String(err.code || err.errno) : '';
  if (!code) return '';
  if (code === 'ENOENT') return 'NOT_FOUND';
  if (code === 'EACCES' || code === 'EPERM') return 'INACCESSIBLE';
  return code; // fallback useful for logs/debug
}


const fs = require('fs').promises;
const path = require('path');
const { write_code: util_write_code, patch_code: util_patch_code, replace_code_block: util_replace_code_block } = require('./utils/tools');
const tools = require("@src/tools/index.js");
const { v4: uuidv4 } = require("uuid");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const Message = require('@src/utils/message');

const terminal_run = require('./terminal_run');
const read_file = require('./read_file');

const { restrictFilepath } = require('./runtime.util');

/**
 * @typedef {import('types/LocalRuntime').LocalRuntime} LocalRuntimeInterface
 * @typedef {import('types/LocalRuntime').Action} Action
 * @typedef {import('types/LocalRuntime').ActionResult} ActionResult
 * @typedef {import('types/LocalRuntime').Memory} Memory
 */

class LocalRuntime {

  /**
   * Create a local runtime instance
   * @param {Object} [options={}] - Configuration options
   * @param {Memory} options.memory - Memory management instance
   */
  constructor(options) {
    this.memory = null
  }

  async handle_memory(result, action, memory) {
    const type = action.type;
    const memorized_type = new Set([
      'read_file',
      'write_code',
      'patch_code',
      'replace_code_block',
      'terminal_run'
    ]);
    const { status, meta = {} } = result;
    const visibleText = buildVisibleActionResultText(result);

    // We generally avoid storing failures to reduce noise, but `terminal_run` and `read_file`
    // failures are essential for debugging (tracebacks, ENOENT, etc.).
    const shouldStoreFailure = (type === 'terminal_run' || type === 'read_file');

    if (status === 'success' || shouldStoreFailure) {
      console.log('LocalRuntime.handle_memory.memory logging user prompt');
      const memorized = memorized_type.has(type) || (result.memorized || false);
      let contentToStore = visibleText;
      if (!contentToStore && type === 'terminal_run') {
        // task_id isn't available here; still emit a useful fallback.
        contentToStore = buildTerminalRunEmptyFailureFallback(action, result?.uuid || '', '', {
          status: result?.status,
          meta: result?.meta,
          comments: result?.comments,
        });
      }
      if (contentToStore) {
        await memory.addMessage('user', contentToStore, type, memorized, meta);
      }
    }
    return memory;
  }

  async callback(result, context = {}) {
    const { onTokenStream } = context;
    if (onTokenStream) {
      onTokenStream(result);
    }
  }

  /**
   * @param {Action} action 
   * @param {*} context 
   * @returns {Promise<ActionResult>}
   */
  async execute_action(action, context = {}, task_id) {
    const { type, params } = action;

    // Call the corresponding method based on action.type
    console.log('action', action.type);
    const uuid = uuidv4();

    // action running message
    const tool = tools[type];
    if (tool.getActionDescription) {
      const description = await tool.getActionDescription(params);
      const value = {
        uuid: uuid,
        content: description,
        status: 'running',
        meta: {
          task_id: task_id,
          action_type: type,
        },
        timestamp: new Date().valueOf()
      }
      const msg = Message.format({ uuid: uuid, status: 'running', content: description, action_type: type, task_id: task_id });
      context.onTokenStream(msg)
      await this.callback(msg, context);
      Message.saveToDB(msg, context.conversation_id);
      await delay(500);
    }

    /**
     * @type {ActionResult}
     */
    let result;
    switch (type) {
      case 'write_code':
        result = await this.write_code(action, uuid);
        break;
      case 'patch_code':
        result = await this.patch_code(action, uuid);
        break;
      case 'replace_code_block':
        result = await this.replace_code_block(action, uuid);
        break;
      case 'terminal_run':
        result = await terminal_run(action, uuid);
        break;
      case 'read_file':
        result = await this.read_file(action, uuid);
        break;
      default:
        if (tool) {
          console.log('LocalRuntime.execute_action.tool', tool.name, params);
          const execute = tool.execute;
          try {
            const execute_result = await execute(params);
            // console.log('LocalRuntime.execute_action.tool.execute', execute_result);
            const { content, meta = {} } = execute_result;
            result = {
              uuid,
              status: 'success',
              content: sanitizeToolReturnForLLM(content),
              memorized: tool.memorized || false,
              meta
            };
          } catch (error) {
            const safeErrorMessage = sanitizeToolReturnForLLM(error?.message || String(error));
            result = { uuid, status: 'failure', error: safeErrorMessage, content: '', stderr: '' };
          }        } else {
          result = { status: 'failure', error: `Unknown action type: ${type}`, content: '', stderr: '' };
        }
    }

    // Save action execution result to memory
    console.log('LocalRuntime.execute_action', result);
    await this.handle_memory(result, action, context.memory);
    // Callback processing
    let meta_url = ''
    let meta_json = []
    let meta_file_path = ''
    let meta_content = ''
    if (result.meta) {
      meta_url = result.meta.url || ''
      meta_json = result.meta.json || []
      meta_file_path = result.meta.filepath || ''
      meta_content = result.meta.content || ''
    }
    let visibleText = buildVisibleActionResultText(result);
    if (!visibleText && type === 'terminal_run' && result?.status === 'failure') {
      visibleText = buildTerminalRunEmptyFailureFallback(action, uuid || '', task_id || '', {
        status: result?.status,
        meta: result?.meta,
        comments: result?.comments,
      });
    }
    const msg = Message.format({
      status: result.status,
      memorized: result.memorized || '',
      // Always show something meaningful, especially for failure where tracebacks can live in `error`.
      content: visibleText,
      action_type: type,
      task_id: task_id,
      uuid: uuid || '',
      url: meta_url,
      json: meta_json,
      filepath: meta_file_path,
      meta_content: meta_content,
      comments: sanitizeToolReturnForLLM((result && result.comments) || '')
    });
    await this.callback(msg, context);
    await Message.saveToDB(msg, context.conversation_id);
    return result;
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async write_code(action, uuid) {
    return util_write_code(action, uuid);
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async patch_code(action, uuid) {
    return util_patch_code(action, uuid);
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async replace_code_block(action, uuid) {
    return util_replace_code_block(action, uuid);
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async read_file(action, uuid) {
    const requestedPath = action?.params?.origin_path || action?.params?.path || '';
    let { path: filepath } = action.params;
    filepath = await restrictFilepath(filepath);

    try {
      const content = await read_file(filepath);
      return {
        uuid,
        status: 'success',
        content, error: "",
        meta: {
          action_type: action.type,
          filepath,
          error_kind: ''
        }
      };
    } catch (error) {
      const safeErrorMessage = sanitizeToolReturnForLLM(error?.message || String(error));
      const error_kind = classifyReadFileErrorKind(error);
      return {
        uuid,
        status: 'failure',
        content: "",
        error: `Failed to read file ${requestedPath}: ${safeErrorMessage}`,
        meta: {
          action_type: action.type,
          filepath,
          error_kind
        }
      };
    }
  }
}

module.exports = LocalRuntime;