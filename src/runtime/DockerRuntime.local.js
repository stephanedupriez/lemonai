/**
 * NOTE ABOUT POSSIBLE DUPLICATION OF FAILURE MESSAGES IN THE LLM PROMPT
 * --------------------------------------------------------------------
 * In Lemon AI, the same failure text can end up being appended twice as `role=user`
 * in the prompt history, typically for `read_file` / `terminal_run` errors.
 *
 * Why:
 *  - This runtime layer (DockerRuntime.local.js) stores tool outcomes into memory
 *    via `handle_memory()` (see below). For failures, we intentionally keep some
 *    failure outputs (notably read_file + terminal_run) because they are needed
 *    for debugging (tracebacks, ENOENT, etc.).
 *  - The agent layer (e.g. code-act.js) may ALSO store an "error feedback" message
 *    as `role=user` after a failure, and it often reuses the same text (or a
 *    byte-for-byte identical string) as what the runtime already stored.
 *
 * Symptom:
 *  - Two consecutive identical `role=user` messages appear (MESSAGE2/MESSAGE3).
 *  - This also happens with `terminal_run` failures: the full traceback/stderr
 *    can be injected twice (MESSAGE6/MESSAGE7), producing noisy duplicated stacktraces.
 *
 * Mitigations (implementation elsewhere):
 *  - De-duplicate adjacent identical messages in memory.addMessage(), or
 *  - Ensure only one of the two layers stores the raw failure text and the other
 *    stores a short meta note.
 *
 * This file keeps the behavior unchanged; this comment is here so future changes
 * don't accidentally reintroduce the duplication pattern.
 */

const fs = require('fs').promises;
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const Docker = require('dockerode');
const os = require('os');
const DOCKER_HOST_ADDR = process.env.DOCKER_HOST_ADDR;
const { write_code: util_write_code, patch_code: util_patch_code, replace_code_block: util_replace_code_block } = require('./utils/tools');
const { getDefaultModel } = require('@src/utils/default_model')

let dockerOptions = {};
if (os.platform() === 'win32') {
  // Windows: 使用 named pipe
  dockerOptions.socketPath = '//./pipe/docker_engine';
} else {
  // Linux/macOS: 使用默认的 Unix socket
  dockerOptions.socketPath = '/var/run/docker.sock';
}
const docker = new Docker(dockerOptions);

const Message = require('@src/utils/message');

const tools = require("../tools/index.js");
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

function normalizeTerminalRunResultShape(action, data) {
  if (!data || typeof data !== 'object') return data;
  if (action?.type !== 'terminal_run') return data;

  const meta = (data.meta && typeof data.meta === 'object') ? data.meta : {};

  // Normalize stdout/content/stderr to stable fields.
  const stdout =
    (typeof data.stdout === 'string') ? data.stdout :
    (typeof data.content === 'string') ? data.content :
    '';
  const stderr = (typeof data.stderr === 'string') ? data.stderr : '';

  // Normalize exitCode (prefer meta.exitCode, then common fallbacks).
  let exitCode = meta.exitCode;
  if (typeof exitCode !== 'number') {
    if (typeof data.exitCode === 'number') exitCode = data.exitCode;
    else if (typeof data.code === 'number') exitCode = data.code;
  }
  // If failure but missing exitCode, use 1. If success but missing, use 0.
  if (data.status === 'failure' && typeof exitCode !== 'number') exitCode = 1;
  if (data.status === 'success' && typeof exitCode !== 'number') exitCode = 0;

  return {
    ...data,
    stdout,
    // Keep legacy behavior: `content` is what the UI / memory usually displays.
    content: stdout,
    stderr,
    meta: { ...meta, exitCode },
  };
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

    const { getDirpath } = require('@src/utils/electron');
    let workspace_dir = getDirpath(process.env.WORKSPACE_DIR || 'workspace');
    if (DOCKER_HOST_ADDR) {
      workspace_dir = process.env.ACTUAL_HOST_WORKSPACE_PATH;
    }
    this.user_id = context.user_id
    this.workspace_dir = workspace_dir;
    this.host_port = null;
    this.vscode_port = null;
    this.app_port_1 = null;
    this.app_port_2 = null;
  }

  // 要操作容器必须先执行connect_container
  async connect_container() {
    // 查看容器是否存在，如果不存在，初始化容器，如果存在但是没启动，start容器
    let container;
    try {
      container = docker.getContainer('lemon-runtime-sandbox')
      const container_info = await container.inspect();
      if (container_info.State.Status === 'exited') {
        console.log('DockerRuntime.connect_container.container exited, start container');
        await container.start();
      } else if (container_info.State.Status === 'running') {
        console.log('DockerRuntime.connect_container.container is running');
      }
    } catch (err) {
      console.log('DockerRuntime.connect_container.getContainer', err.message);
      container = await this.init_container();
    }

    let container_info = await container.inspect()
    this.host_port = Object.keys(container_info.NetworkSettings.Ports)[0].split('/')[0]
    this.vscode_port = Object.keys(container_info.NetworkSettings.Ports)[1].split('/')[0]
    this.app_port_1 = Object.keys(container_info.NetworkSettings.Ports)[2].split('/')[0]
    this.app_port_2 = Object.keys(container_info.NetworkSettings.Ports)[3].split('/')[0]

    // const cmdArgs = container_info.Config.Cmd;
    // // 遍历命令行参数，找到对应的端口值
    // for (let i = 0; i < cmdArgs.length; i++) {
    //   if (cmdArgs[i] === '--port') {
    //     this.host_port = cmdArgs[i + 1];
    //   } else if (cmdArgs[i] === '--vscode_port') {
    //     this.vscode_port = cmdArgs[i + 1];
    //   }
    // }

    return container;
  }

  async find_available_port(port_range) {
    const port = await find_available_tcp_port(port_range[0], port_range[1]);
    return port
  }

  async init_container() {
    // 初始化容器
    console.log('DockerRuntime.init_container');

    const host_port = await this.find_available_port(EXECUTION_SERVER_PORT_RANGE);
    this.host_port = host_port
    const vscode_port = await this.find_available_port(VSCODE_PORT_RANGE);
    const app_port_1 = await this.find_available_port(APP_PORT_RANGE_1);
    const app_port_2 = await this.find_available_port(APP_PORT_RANGE_2);

    const PortBindingsMap = {}
    PortBindingsMap[`${host_port}/tcp`] = [{ HostPort: `${host_port}` }]
    PortBindingsMap[`${vscode_port}/tcp`] = [{ HostPort: `${vscode_port}` }]
    PortBindingsMap[`${app_port_1}/tcp`] = [{ HostPort: `${app_port_1}` }]
    PortBindingsMap[`${app_port_2}/tcp`] = [{ HostPort: `${app_port_2}` }]


    const exposedPortsMap = {}
    exposedPortsMap[`${host_port}/tcp`] = {}
    exposedPortsMap[`${vscode_port}/tcp`] = {}
    exposedPortsMap[`${app_port_1}/tcp`] = {}
    exposedPortsMap[`${app_port_2}/tcp`] = {}

    const imageName = 'hexdolemonai/lemon-runtime-sandbox:latest';
    await this.ensureImageExists(docker, imageName);

    const container = await docker.createContainer({
      Image: imageName,
      name: 'lemon-runtime-sandbox',                // 容器名称
      Cmd: ['node', 'chataa/action_execution_server.js', '--port', `${host_port}`, '--vscode_port', `${vscode_port}`],  // 启动命令
      WorkingDir: '/chataa/code',                // 容器内工作目录
      ExposedPorts: exposedPortsMap,
      HostConfig: {
        Binds: [
          // 本地目录 : 容器目录 : 模式（rw 可读写 / ro 只读）
          `${this.workspace_dir}:/workspace:rw`
        ],
        PortBindings: PortBindingsMap,
        AutoRemove: false,  // 如需容器退出后自动删除，可改为 true
        // NetworkMode: 'host',
      },
    });
    // 2. 启动容器
    await container.start();
    return container;
  }

  async ensureImageExists(docker, imageName) {
    try {
      await docker.getImage(imageName).inspect();
      console.log(`[Docker] Image ${imageName} already exists`);
    } catch (err) {
      if (err.statusCode === 404) {
        console.log(`[Docker] Image ${imageName} not found locally, pulling from registry...`);
        await new Promise((resolve, reject) => {
          docker.pull(imageName, (err, stream) => {
            if (err) {
              return reject(new Error(`[Docker] Failed to pull image: ${err.message}`));
            }
            docker.modem.followProgress(stream, (err, res) => {
              if (err) return reject(new Error(`[Docker] Pull image progress error: ${err.message}`));
              resolve(res);
            });
          });
        });
        console.log(`[Docker] Image ${imageName} pulled successfully`);
      } else {
        throw new Error(`[Docker] Failed to inspect image: ${err.message}`);
      }
    }
  }

  async handle_memory(result, action, memory) {
    const type = action.type;
    const tool = tools[type];
    const memorized_type = new Set(['read_file', "write_code", "patch_code", "replace_code_block", "terminal_run"]);
    const visibleText = buildVisibleActionResultText(result);
    // We generally avoid storing failures to reduce noise, but `terminal_run` and `read_file`
    // failures are essential for debugging (tracebacks, ENOENT, etc.).
    //
    // IMPORTANT (duplication risk):
    // - This function may store the failure text as a `role=user` message (see shouldStoreFailure).
    // - The agent layer may also append "error feedback" as `role=user` after failures.
    // If both layers append the same string, the LLM prompt history can contain duplicated
    // consecutive messages (MESSAGE2/MESSAGE3).
    //
    // Terminal_run-specific note:
    // - `visibleText` for terminal_run failures often contains full stderr/tracebacks.
    // - If the agent layer also re-logs the same traceback as error feedback, users will see
    //   duplicated stacktraces (e.g., MESSAGE6/MESSAGE7).
    const shouldStoreFailure = (type === 'terminal_run' || type === 'read_file');
	
    // -------------------------------------------------------------------------
    // replace_code_block (success): store a generic confirmation message
    // -------------------------------------------------------------------------
    // Rationale:
    // - Avoid keeping the LLM in "repair loop" by showing fresh file contents right after a patch.
    // - Provide a short, deterministic acknowledgement instead.
    if (type === 'replace_code_block' && result?.status === 'success') {
      const requestedPath =
        (action?.params?.origin_path && String(action.params.origin_path)) ||
        (action?.params?.path && String(action.params.path)) ||
        '';

      if (requestedPath) {
        const confirmation = `The patch has been successfully applied to the file ${requestedPath}`;
        const memorized = memorized_type.has('replace_code_block');
        let action_memory = "";
        if (memorized && tool && tool.resolveMemory) {
          action_memory = sanitizeToolReturnForLLM(tool.resolveMemory(action, confirmation));
        }
        const meta = {
          action,
          action_memory,
          status: 'success'
        };
        await memory.addMessage('user', confirmation, 'replace_code_block', memorized, meta);
      }

      return memory;
    }
	
    if (result.status === 'success' || shouldStoreFailure) {
      let content = visibleText;
      if (!content && type === 'terminal_run') {
        // NOTE (duplication risk):
        // Even when stdout/stderr is missing and we synthesize a fallback block here,
        // the agent layer might also generate/log a similar fallback as error feedback.
        // This can still result in duplicated user messages in the prompt.
        content = buildTerminalRunEmptyFailureFallback(action, result?.uuid || '', {
          status: result?.status,
          meta: result?.meta,
        });
      }
      if (!content) return memory;
      // handle memory
      const memorized = memorized_type.has(type)
      let action_memory = ""
      if (memorized && tool && tool.resolveMemory) {
        action_memory = sanitizeToolReturnForLLM(tool.resolveMemory(action, content));
      }
      const meta = {
        action,
        action_memory,
        status: result.status
      }
      // NOTE (duplication risk):
      // This `addMessage('user', ...)` can collide with an additional `addMessage('user', ...)`
      // performed by the agent layer after a failure (error-feedback / reflection), producing
      // duplicated consecutive `role=user` entries in the prompt.
      // This is especially visible for `terminal_run` because the duplicated text is often
      // a long traceback; the duplication increases context bloat and can mislead the LLM
      // into thinking there were multiple distinct failures.
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
	
    // -----------------------------------------------------------------------
    // terminal_run grouping + pruning key (relative, conversation-scoped)
    // -----------------------------------------------------------------------
    // Goals:
    // 1) Attach a random run_id so multiple messages related to the same terminal_run
    //    can be correlated in history.
    // 2) Attach (cwd, command) as a stable pruning key so old terminal_run outputs for the
    //    same command in the same cwd can be pruned by LocalMemory using its existing
    //    "file snapshot key" mechanism (origin_path/origin_*).
    //
    // Notes:
    // - The LLM only reasons about conversation-relative paths, so we keep everything relative
    //   ('.', 'src', etc.). No absolute /workspace paths are introduced here.
    // - We intentionally store a synthetic "origin_path" for terminal_run so LocalMemory's
    //   existing pruning-by-file-key logic can prune older terminal_run snapshots by (cwd,command).
    if (type === 'terminal_run') {
      action.params = action.params || {};
      const cwd_rel = (typeof action.params.origin_cwd === 'string' && action.params.origin_cwd.trim())
        ? action.params.origin_cwd.trim()
        : (typeof action.params.cwd === 'string' && action.params.cwd.trim())
          ? action.params.cwd.trim()
          : '.';
      const cmd = (typeof action.params.command === 'string' ? action.params.command : '').trim();
      const argsStr = (typeof action.params.args === 'string' ? action.params.args : '').trim();
      const commandLine = `${cmd}${argsStr ? ' ' + argsStr : ''}`.trim();
      const run_id = (typeof action.params.run_id === 'string' && action.params.run_id.trim())
        ? action.params.run_id.trim()
        : `tr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      action.params.run_id = run_id;
      action.params.origin_cwd = cwd_rel;
      action.params.origin_command = commandLine;
      // Synthetic stable key to enable pruning of older terminal_run snapshots for the same (cwd,command).
      action.params.origin_path = `terminal_run:${cwd_rel}::${commandLine}`;
    }
	
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

      // ✅ Injecte le think (si présent) dans le meta envoyé à l'UI
      msg.meta = msg.meta || {};
      if (context.last_thinking) {
        msg.meta.thinking = context.last_thinking;
        // ✅ Important : on vide pour ne pas le réutiliser sur l'action suivante
        context.last_thinking = '';
      }

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
        // Preserve a stable, conversation-relative cwd for meta/pruning,
        // but ALWAYS send a conversation-prefixed cwd to the sandbox.
        // (The sandbox mount root is /workspace.)
        {
          const requestedRelCwd =
            (typeof action.params.origin_cwd === 'string' && action.params.origin_cwd.trim())
              ? action.params.origin_cwd.trim()
              : (typeof action.params.cwd === 'string' && action.params.cwd.trim())
                ? action.params.cwd.trim()
                : '.';

          action.params.origin_cwd = requestedRelCwd;

          const base = path.join(`user_${this.user_id}`, dir_name);
          action.params.cwd = (requestedRelCwd && requestedRelCwd !== '.')
            ? path.join(base, requestedRelCwd)
            : base;
        }
        result = await this._call_docker_action(action, uuid);
        // Preserve terminal_run correlation fields on the result for downstream layers (agent/UI/memory).
        if (result && typeof result === 'object') {
          result.meta = (result.meta && typeof result.meta === 'object') ? result.meta : {};
          result.meta.run_id = action?.params?.run_id || result.meta.run_id;
          result.meta.origin_cwd = action?.params?.origin_cwd || result.meta.origin_cwd;
          result.meta.origin_command = action?.params?.origin_command || result.meta.origin_command;
          result.meta.origin_path = action?.params?.origin_path || result.meta.origin_path;
        }
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
      case 'web_search': {
        const searchQuery = (action.params.query || action.params.topic || '').trim();
        const num_results = action.params.num_results || 3;

        if (!searchQuery) {
          result = {
            uuid,
            status: 'failure',
            content: 'web_search: query is empty',
            memorized: false,
            meta: {},
          };
          break;
        }

        // On délègue au sandbox via terminal_run
        const subAction = {
          type: 'terminal_run',
          params: {
            command: 'python',
            args: `/workspace/ddg/ddg_playwright_search.py "${searchQuery.replace(/"/g, '\\"')}"`,
            cwd: '.', // workspace sera résolu côté sandbox, et le script est en chemin absolu
          },
        };

        const subResult = await this._call_docker_action(subAction, uuid);

        if (!subResult || subResult.status !== 'success') {
          result = {
            uuid,
            status: 'failure',
            content: `DDG local search failed: ${subResult && (subResult.error || subResult.content) || 'Unknown error'
              }`,
            memorized: false,
            meta: {},
          };
          break;
        }

const stdout = subResult.content || '';
if (!stdout.trim()) {
  result = {
    uuid,
    status: 'failure',
    content: 'DDG local search returned empty stdout.',
    memorized: false,
    meta: {},
  };
  break;
}

let raw_json;
try {
  raw_json = JSON.parse(stdout);
} catch (e) {
  result = {
    uuid,
    status: 'failure',
    content: `DDG local search JSON parse error: ${e.message || String(e)}`,
    memorized: false,
    meta: { raw_stdout: stdout },
  };
  break;
}

// 🔵 Normalisation pour retrouver l’ancien comportement:
// - si le script renvoie { query, results: [...], num_results }
// - on passe meta.json = results[]
let normalized_results;
if (Array.isArray(raw_json)) {
  normalized_results = raw_json;
} else if (raw_json && Array.isArray(raw_json.results)) {
  normalized_results = raw_json.results;
} else {
  normalized_results = [];
}

const formatted = JSON.stringify(normalized_results, null, 2);
const content = `Web search results for "${searchQuery}":\n\n${formatted}`;

result = {
  uuid,
  status: 'success',
  content,
  memorized: false,
  meta: {
    json: normalized_results,   // ✅ comme formatJSON() avant
    raw_json: raw_json,         // (optionnel, pour debug)
  },
};
break;

      }

      case 'read_url': {
        const targetUrl = (action.params.url || '').trim();

        if (!targetUrl) {
          result = {
            uuid,
            status: 'failure',
            content: 'read_url: url is empty',
            memorized: false,
            meta: {},
          };
          break;
        }

        // On délègue au sandbox via terminal_run (script Playwright+bs4 dans le workspace)
        const subAction = {
          type: 'terminal_run',
          params: {
            command: 'python',
            args: `/workspace/read_url/read_url.py "${targetUrl.replace(/"/g, '\\"')}"`,
            cwd: '.', // workspace est résolu côté sandbox
          },
        };

        const subResult = await this._call_docker_action(subAction, uuid);

        if (!subResult || subResult.status !== 'success') {
          result = {
            uuid,
            status: 'failure',
            content: `read_url failed: ${subResult && (subResult.error || subResult.content) || 'Unknown error'}`,
            memorized: false,
            meta: {},
          };
          break;
        }

        const stdout = subResult.content || '';
        if (!stdout.trim()) {
          result = {
            uuid,
            status: 'failure',
            content: 'read_url returned empty stdout.',
            memorized: false,
            meta: {},
          };
          break;
        }

        let raw_json;
        try {
          raw_json = JSON.parse(stdout);
        } catch (e) {
          result = {
            uuid,
            status: 'failure',
            content: `read_url JSON parse error: ${e.message || String(e)}`,
            memorized: false,
            meta: { raw_stdout: stdout },
          };
          break;
        }

        const text = (raw_json && typeof raw_json.text === 'string') ? raw_json.text : '';
        const title = (raw_json && typeof raw_json.title === 'string') ? raw_json.title : '';
        const final_url = (raw_json && typeof raw_json.final_url === 'string') ? raw_json.final_url : targetUrl;
        const statusCode = (raw_json && (typeof raw_json.status === 'number' || typeof raw_json.status === 'string'))
          ? raw_json.status
          : '';

        result = {
          uuid,
          status: 'success',
          content: text || `Read URL "${final_url}" OK.`,
          memorized: false,
          meta: {
            json: [
              {
                title,
                final_url,
                status: statusCode,
                // html potentiellement présent si tu le renvoies depuis le script python
                ...(raw_json && typeof raw_json.html === 'string' ? { html: raw_json.html } : {}),
              },
            ],
            raw_json, // (optionnel) utile en debug
          },
        };
        break;
      }

      default:
        if (tool) {
          if (action.params.file_path) {
            action.params.file_path = path.join(__dirname, '../../workspace', `user_${this.user_id}`, dir_name, action.params.file_path)
          }
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

    // Ensure terminal_run correlation fields are visible in UI meta if needed (sanitized downstream).
    if (type === 'terminal_run') {
      result.meta = result.meta || {};
      result.meta.run_id = result.meta.run_id || action?.params?.run_id || '';
      result.meta.origin_cwd = result.meta.origin_cwd || action?.params?.origin_cwd || '';
      result.meta.origin_command = result.meta.origin_command || action?.params?.origin_command || '';
      result.meta.origin_path = result.meta.origin_path || action?.params?.origin_path || '';
    }

    const visibleText = buildVisibleActionResultText(result);
    let finalVisibleText = visibleText;
    if (!finalVisibleText && type === 'terminal_run' && result?.status === 'failure') {
      finalVisibleText = buildTerminalRunEmptyFailureFallback(action, uuid || '', {
        status: result?.status,
        meta: result?.meta,
      });
    }
    const msg = Message.format({
      status: result.status,
      memorized: result.memorized || '',
      // Always show something meaningful, especially for failure where tracebacks live in `error`.
      content: finalVisibleText,
      action_type: type,
      task_id: task_id,
      uuid: uuid || '',
      url: meta_url,
      json: meta_json,
      filepath: meta_file_path,
      meta_content: meta_content,
    });
    await this.callback(msg, context);
    await Message.saveToDB(msg, context.conversation_id);
    return result;
  }

  async _call_docker_action(action, uuid) {
    const host = DOCKER_HOST_ADDR ? DOCKER_HOST_ADDR : 'localhost'
    const request = {
      method: 'POST',
      url: `http://${host}:${this.host_port}/execute_action`,
      data: { action: action, uuid: uuid },
    };
    try {
      const response = await axios(request);

      // Low-level observability for intermittent infra failures.
      console.log('[DockerRuntime.local._call_docker_action] http status:', response?.status);
      if (response && response.data && typeof response.data === 'object') {
        console.log('[DockerRuntime.local._call_docker_action] response keys:', Object.keys(response.data));
      }

      const data = response?.data?.data;
      if (!data) {
        console.error(
          '[DockerRuntime.local._call_docker_action] Missing response.data.data. Raw body:',
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

      // Always return a stable shape for terminal_run so the agent can detect failures
      // using status/exitCode + error patterns over stdout/stderr.
      return normalizeTerminalRunResultShape(action, data);
    } catch (e) {
      const details = extractAxiosErrorDetails(e);
      console.error('[DockerRuntime.local._call_docker_action] axios error details:', safeStringify(details));

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
      };    }
  }

  async callback(result, context = {}) {
    const { onTokenStream } = context;
    if (onTokenStream) {
      onTokenStream(result);
    }
  }
}

module.exports = DockerRuntime;