const path = require('path');
const axios = require('axios');
const Docker = require('dockerode');
const os = require('os');
const DOCKER_HOST_ADDR = process.env.DOCKER_HOST_ADDR;
const ECI_SERVER_HOST = process.env.ECI_SERVER_HOST
const { write_code: util_write_code, patch_code: util_patch_code, replace_code_block: util_replace_code_block } = require('./utils/tools');
const { getDefaultModel } = require('@src/utils/default_model')
// const { createConf } = require('@src/utils/nginx')


const Message = require('@src/utils/message');

const tools = require("../tools/index.js");
const mcp_tool = require("@src/mcp/tool");
tools['mcp_tool'] = mcp_tool;

const { v4: uuidv4 } = require("uuid");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { find_available_tcp_port } = require('./utils/system');

const read_file = require('./read_file');

const { restrictFilepath } = require('./runtime.util');

function extractConversationWorkspaceRoot(absPath) {
  const s = String(absPath || '');
  // Expected shape: /workspace/user_<id>/Conversation_<token>/...
  const m = s.match(/(\/workspace\/user_\d+\/Conversation_[^\/]+\/?)/);
  if (!m) return '';
  let root = m[1] || '';
  if (root && !root.endsWith('/')) root += '/';
  return root;
}

function stripConversationWorkspaceRoot(text, workspaceRoot) {
  if (!text) return text;
  const root = String(workspaceRoot || '');
  if (!root) return text;
  // Replace both with and without trailing slash.
  const rootNoSlash = root.endsWith('/') ? root.slice(0, -1) : root;
  return String(text)
    .split(root).join('')
    .split(rootNoSlash).join('');
}

function sanitizeToolReturnForLLM(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  // Remove absolute conversation workspace paths injected by the runtime, e.g.:
  // /workspace/user_1/Conversation_75c470/...
  let out = text.replace(/\/workspace\/user_\d+\/Conversation_[^\/\s'"]+\/?/g, '');

  // Also remove relative conversation prefixes that can still leak into tool output, e.g.:
  // "Conversation_75c470/ttt.py" -> "ttt.py"
  // This keeps paths stable in the chat history and avoids leaking internal workspace layout.
  out = out.replace(/\bConversation_[^\/\s'"]+\//g, '');
  return out;
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

  // Fallback for tools that legitimately have no stdout (rm, mkdir, etc.)
  if (!text && result.status === 'success') {
    text = 'Execution result has no return content';
  }
  return sanitizeToolReturnForLLM(text);
}

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

function firstNonEmptyString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

function buildTerminalRunEmptyFailureFallback(action, uuid, details) {
  const params = action?.params || {};
  const { command, args = [], cwd = '.' } = params;
  const lines = [];
  lines.push('terminal_run failed but no output was captured.');
  lines.push('');
  lines.push('Diagnostics:');
  lines.push(`- uuid: ${uuid || ''}`);
  lines.push(`- command: ${command || ''}`);
  lines.push(`- args: ${Array.isArray(args) ? safeStringify(args) : String(args ?? '')}`);
  lines.push(`- cwd: ${cwd || ''}`);
  lines.push('');
  lines.push('Runtime details (best effort):');
  lines.push(safeStringify(details));
  return lines.join('\n');
}

function extractAxiosErrorDetails(e) {
  const details = {
    message: e?.message,
    code: e?.code,
    name: e?.name,
    isAxiosError: !!e?.isAxiosError,
    errno: e?.errno,
    syscall: e?.syscall,
    address: e?.address,
    port: e?.port,
  };
  if (e?.config) {
    details.config = {
      method: e.config.method,
      url: e.config.url,
      timeout: e.config.timeout,
    };
  }
  if (e?.response) {
    details.response = {
      status: e.response.status,
      statusText: e.response.statusText,
      data: e.response.data,
      headers: e.response.headers,
    };
  }
  if (typeof e?.toJSON === 'function') {
    try {
      details.toJSON = e.toJSON();
    } catch (_) { }
  }
  return details;
}


function classifyReadFileErrorKind(err) {
  const code = err && (err.code || err.errno) ? String(err.code || err.errno) : '';
  if (!code) return '';
  if (code === 'ENOENT') return 'NOT_FOUND';
  if (code === 'EACCES' || code === 'EPERM') return 'INACCESSIBLE';
  return code; // fallback useful for logs/debug
}


EXECUTION_SERVER_PORT_RANGE = [30000, 39999]
VSCODE_PORT_RANGE = [40000, 49999]
APP_PORT_RANGE_1 = [50000, 54999]
APP_PORT_RANGE_2 = [55000, 59999]

/**
 * @typedef {import('./DockerRuntime').DockerRuntime} LocalRuntimeInterface
 * @typedef {import('./DockerRuntime').Action} Action
 * @typedef {import('./DockerRuntime').ActionResult} ActionResult
 * @typedef {import('./DockerRuntime').Memory} Memory
 */

class DockerRuntime {

  /**
   * 创建一个docker运行时实例
   * @param {Object} [options={}] - 配置选项
   * @param {Memory} options.memory - 记忆管理实例
   */
  constructor(context) {
    this.user_id = context.user_id
    // this.workspace_dir = workspace_dir;
    this.host_port = null;
    this.vscode_port = null;
    this.app_port_1 = null;
    this.app_port_2 = null;
    this.docker_host = null;
  }

  // 要操作容器必须先执行connect_container
  async connect_container() {
    // 查看容器是否存在，如果不存在，初始化容器，如果存在设置全局docker_host

    // 先创建一个，todo检查是否存在

    const request = {
      method: 'POST',
      url: `${ECI_SERVER_HOST}/status`,
      data: { name: `user-${this.user_id}-lemon-runtime-sandbox` },
    };

    const response = await axios(request)

    if (response.data.TotalCount > 0) {
      this.docker_host = response.data.ContainerGroups[0].IntranetIp
    } else {
      await this.init_container();
    }

    this.host_port = 9001
    this.vscode_port = 9002
    this.app_port_1 = 10001
    this.app_port_2 = 10002

    return;
  }

  get_vscode_url(dir_name) {
    return `https://${this.user_id}-vscode.lemonai.ai?folder=/workspace/${dir_name}`
  }

  async find_available_port(port_range) {
    const port = await find_available_tcp_port(port_range[0], port_range[1]);
    return port
  }

  async init_container() {
    // 初始化容器
    console.log('DockerRuntime.init_container');
    const request = {
      method: 'POST',
      url: `${ECI_SERVER_HOST}/amd`,
      data: { name: `user-${this.user_id}-lemon-runtime-sandbox`, workspace: `user_${this.user_id}` },
    };
    try {
      const response = await axios(request);
      this.docker_host = response.data.IntranetIp
      // await createConf(this.docker_host, this.user_id)
    } catch (e) {
      throw e
    }

    return
  }

  async handle_memory(result, action, memory) {
    const type = action.type;
    const tool = tools[type];
    const memorized_type = new Set(['read_file', "write_code", "patch_code", "replace_code_block", "terminal_run"]);
    const visibleText = buildVisibleActionResultText(result);
    // We generally avoid storing failures to reduce noise, but `terminal_run` and `read_file`
    // failures are essential for debugging (tracebacks, ENOENT, etc.).
    const shouldStoreFailure = (type === 'terminal_run' || type === 'read_file');
    if (result.status === 'success' || shouldStoreFailure) {
      const content = visibleText;
      // handle memory
      const memorized = memorized_type.has(type) || (result.memorized || false);
      let action_memory = ""
      if (memorized && tool && tool.resolveMemory) {
        action_memory = sanitizeToolReturnForLLM(tool.resolveMemory(action, content));
      }
      const meta = {
        action,
        action_memory,
        status: result.status
      }
      await memory.addMessage('user', content, action.type, memorized, meta);
    }
    return memory;
  }

  /**
   * @param {Action} action 
   * @param {*} context 
   * @returns {Promise<ActionResult>}
   */
  async execute_action(action, context = {}, task_id) {
    const { type, params } = action;
    // 根据 action.type 调用对应的方法
    console.log('action', action.type);
    const uuid = uuidv4();
    // action running message
    const tool = tools[type];
    if (tool && tool.getActionDescription) {
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
      // context.onTokenStream(msg)
      await this.callback(msg, context);
      Message.saveToDB(msg, context.conversation_id);
      await delay(500);
    }

    /**
     * @type {ActionResult}
     */
    let result;
    const dir_name = 'Conversation_' + context.conversation_id.slice(0, 6);
    switch (type) {
      case 'write_code':
        if (action.params.path) {
          action.params.origin_path = action.params.path;
          action.params.path = path.join(dir_name, action.params.path)
        }
        result = await this.write_code(action, uuid);
        break;
      case 'patch_code':
        if (action.params.path) {
          // Keep a stable, unprefixed path for downstream memory coalescing.
          // (The runtime prefixes the actual on-disk path with the conversation dir.)
          action.params.origin_path = action.params.path;
          action.params.path = path.join(dir_name, action.params.path)
        }
        result = await this.patch_code(action, uuid);
        break;
      case 'replace_code_block':
        if (action.params.path) {
          // Keep a stable, unprefixed path for downstream memory coalescing.
          // (The runtime prefixes the actual on-disk path with the conversation dir.)
          action.params.origin_path = action.params.path;
          action.params.path = path.join(dir_name, action.params.path)
        }
        // replace_code_block is executed locally (lemon-app) to avoid sandbox routing.
        result = await this.replace_code_block(action, uuid);
        break;
      case 'terminal_run':
        if (action.params.cwd) {
          action.params.cwd = path.join(dir_name, action.params.cwd)
        } else {
          action.params.cwd = `./${dir_name}`
        }
        result = await this._call_docker_action(action, uuid);
        break;
      case 'read_file':
        if (action.params.path) {
          // Keep a stable, unprefixed path for downstream memory coalescing.
          // (The runtime prefixes the actual on-disk path with the conversation dir.)
          action.params.origin_path = action.params.path;
          action.params.path = path.join(dir_name, action.params.path)
        }
        result = await this.read_file(action, uuid);
        break;
      case 'browser':
        let model_info = await getDefaultModel(context.conversation_id)
        const llm_config = {
          model_name: model_info.model_name,
          api_url: model_info.base_url,
          api_key: model_info.api_key
        }
        // llm_config.api_url='http://host.docker.internal:3002/api/agent/v1'
        action.params.llm_config = llm_config
        action.params.conversation_id = context.conversation_id
        result = await this._call_docker_action(action, uuid)
        break;
      default:
        if (tool) {
          console.log('DockerRuntime.execute_action.tool', tool.name, params);
          try {
            const execute = tool.execute;
            params.conversation_id = context.conversation_id
            const execute_result = await execute(params, uuid, context);
            console.log(`${tool.name}.call.result`, execute_result);
            // console.log('LocalRuntime.execute_action.tool.execute', execute_result);
            const { content, meta = {} } = execute_result;
            result = { uuid, status: 'success', content, memorized: tool.memorized || false, meta };
          } catch (error) {
            result = { status: 'failure', error: error.message, content: '', stderr: '' };
          }
        } else {
          result = { status: 'failure', error: `Unknown action type: ${type}`, content: '', stderr: '' };
        }
    }
    // 保存 action 执行结果到 memory
    console.log('DockerRuntime.execute_action', result);
    await this.handle_memory(result, action, context.memory);
    // 回调处理
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
    const visibleText = buildVisibleActionResultText(result);
    const msg = Message.format({
      status: result.status,
      memorized: result.memorized || '',
      // Always show something meaningful, especially for failure where tracebacks live in `error`.
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
    
    msg.meta = msg.meta || {};
    if (context.last_thinking) {
      msg.meta.thinking = context.last_thinking;
      context.last_thinking = '';
    }
    await this.callback(msg, context);
    await Message.saveToDB(msg, context.conversation_id);
    return result;
  }

  async _call_docker_action(action, uuid) {
    const host = this.docker_host
    const request = {
      method: 'POST',
      url: `http://${host}:${this.host_port}/execute_action`,
      data: { action: action, uuid: uuid },
    };
    try {
      const response = await axios(request);

      // Low-level observability for intermittent infra failures.
      console.log('[DockerRuntime._call_docker_action] http status:', response?.status);
      if (response && response.data && typeof response.data === 'object') {
        console.log('[DockerRuntime._call_docker_action] response keys:', Object.keys(response.data));
      } else {
        console.log('[DockerRuntime._call_docker_action] response has no JSON body');
      }

      const data = response?.data?.data;
      if (!data) {
        console.error(
          '[DockerRuntime._call_docker_action] Missing response.data.data. Raw body:',
          safeStringify(response?.data)
        );
        const details = { http_status: response?.status, body: response?.data };
        const fallback = (action?.type === 'terminal_run')
          ? buildTerminalRunEmptyFailureFallback(action, uuid, details)
          : `Failed to do ${action?.type}: missing response.data.data`;
        return { uuid, status: 'failure', content: fallback, error: fallback, comments: fallback };
      }

      // Ensure `terminal_run` failures are never empty (UI + memory + evaluator).
      if (action?.type === 'terminal_run' && data?.status === 'failure') {
        const msg = firstNonEmptyString(data?.content, data?.stderr, data?.error, data?.comments);
        if (!msg) {
          const details = { http_status: response?.status, body: response?.data };
          const fallback = buildTerminalRunEmptyFailureFallback(action, uuid, details);
          data.content = fallback;
          data.error = data.error || fallback;
          data.comments = data.comments || fallback;
        }
      }

      return data;
    } catch (e) {
      const details = extractAxiosErrorDetails(e);
      console.error('[DockerRuntime._call_docker_action] axios error details:', safeStringify(details));

      const errorMsg =
        firstNonEmptyString(
          e?.message,
          (typeof e?.errors === 'string' ? e.errors : ''),
          (e?.errors && typeof e.errors === 'object' ? safeStringify(e.errors) : ''),
          ''
        ) || 'unknown error';

      const base = `Failed to do ${action?.type}: ${errorMsg}`;
      const fallback = (action?.type === 'terminal_run')
        ? buildTerminalRunEmptyFailureFallback(action, uuid, details)
        : `${base}\n\nAxios details:\n${safeStringify(details)}`;

      return {
        uuid,
        status: 'failure',
        content: fallback,
        error: fallback,
        comments: fallback,
        meta: {
          action_type: action?.type,
        }
      };
    }
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async write_code(action, uuid) {
    return util_write_code(action, uuid, this.user_id);
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async patch_code(action, uuid) {
    return util_patch_code(action, uuid, this.user_id);
  }
  
  /**
  * @param {Action} action
  * @returns {Promise<ActionResult>}
  */
  async replace_code_block(action, uuid) {
    return util_replace_code_block(action, uuid, this.user_id);
  }

  /**
   * @param {Action} action
   * @returns {Promise<ActionResult>}
   */
  async read_file(action) {
    const requestedPath = action?.params?.origin_path || action?.params?.path || '';
    let { path: filepath } = action.params;
    filepath = await restrictFilepath(filepath, this.user_id);

    try {
      const content = await read_file(filepath);
      return {
        status: 'success',
        content,
        error: "",
        meta: { filepath: filepath, action_type: action.type, error_kind: '' }
      };
    } catch (error) {
      const workspaceRoot = extractConversationWorkspaceRoot(filepath);
      const safeErrorMessage = stripConversationWorkspaceRoot(error?.message || String(error), workspaceRoot);
      const error_kind = classifyReadFileErrorKind(error);
      return {
        status: 'failure',
        content: "",
        error: `Failed to read file ${requestedPath}: ${safeErrorMessage}`,
        meta: {
          filepath: filepath,
          action_type: action.type,
          error_kind
        }
      };
    }
  }

  async callback(result, context = {}) {
    const { onTokenStream } = context;
    if (onTokenStream) {
      onTokenStream(result);
    }
  }
}

module.exports = DockerRuntime;