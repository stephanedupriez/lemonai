// action_execution_server.js

console.log('[DEBUG] Script started (top of file).'); // 新增

const Koa = require('koa');
const argv = require('minimist')(process.argv.slice(2));
const { koaBody } = require('koa-body');
const terminal_run = require('./terminal_run');
const browser = require('./browser')
const path = require('path');
const fs = require('fs/promises');
const { run: vscode_init } = require('./plugins/vscode/index');
const { run: browser_init } = require('./plugins/browser/index');
const { restrictFilepath } = require('./runtime.util');
const { getDirpath } = require('./utils/electron');
const WORKSPACE_DIR = getDirpath(process.env.WORKSPACE_DIR || 'workspace');

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Normalize a user-provided path into a workspace-relative display string.
// - strips leading slashes (so "/home/x.py" displays as "home/x.py")
// - normalizes separators
// - best-effort avoids traversal hints in the display
const formatWorkspaceRelativePath = (p) => {
  if (!isNonEmptyString(p)) return '';
  const normalized = path.normalize(String(p)).replace(/^([/\\])+/, '');
  return normalized;
};

const toIntOrUndefined = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
};

/**
 * Best-effort user_id extraction.
 *
 * Goal: avoid hardcoding `user_1` while still matching the same workspace
 * resolution strategy as write_code (restrictFilepath(..., user_id)).
 *
 * Supported inputs (best effort):
 * - request body: { user_id }
 * - request body: { meta: { user_id } }
 * - action.params: { user_id }
 * - action.params: { meta: { user_id } }
 */
const getUserIdFromRequest = (body, action) => {
  const b = (body && typeof body === 'object') ? body : {};
  const a = (action && typeof action === 'object') ? action : {};
  const ap = (a.params && typeof a.params === 'object') ? a.params : {};

  const candidates = [
    b.user_id,
    b?.meta?.user_id,
    ap.user_id,
    ap?.meta?.user_id,
  ];

  for (const c of candidates) {
    const n = toIntOrUndefined(c);
    if (typeof n === 'number') return n;
  }
  return undefined;
};

/**
 * write_code
 * params:
 *  - path: string (workspace-relative or absolute-under-workspace)
 *  - content: string
 *  - origin_path?: string (absolute workspace path, preferred when present)
 *
 * Semantics: write file under workspace (restricted), then (optionally) probe-dump
 * the exact bytes written as seen on disk.
 */
const write_code = async (action, uuid, user_id) => {
  const params = (action && action.params && typeof action.params === 'object') ? action.params : {};
  const relPath = params.path;
  const content = params.content;
  const origin_path = params.origin_path;

  if (!isNonEmptyString(relPath)) {
    return buildFailureResult({ action, uuid, reason: 'write_code: missing params.path' });
  }
  if (typeof content !== 'string') {
    return buildFailureResult({ action, uuid, reason: 'write_code: missing or invalid params.content' });
  }

  const preferred = isNonEmptyString(origin_path) ? origin_path : relPath;
  let targetPath = await resolveWorkspacePath(preferred, user_id);

  // Best-effort: if we resolved to a non-user workspace but the file actually lives in a Conversation_* folder,
  // locate it (or at least locate the conversation root) so we don't accidentally write in the wrong place.
  if (!(await fileExists(targetPath))) {
    if (!path.isAbsolute(preferred)) {
      const found = await findInWorkspaceConversations(preferred);
      if (found) targetPath = found;
    }
  }

  // Ensure parent dir exists when writing a new file under a conversation folder.
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
  } catch (_) {
    // ignore; writeFile will fail with a useful error if path is invalid
  }

  try {
    await fs.writeFile(targetPath, content, 'utf8');
  } catch (err) {
    return buildFailureResult({
      action,
      uuid,
      reason:
        `write_code: failed to write file: ${targetPath}` +
        (isNonEmptyString(origin_path) ? ` (origin_path: ${origin_path})` : '') +
        ` (path: ${relPath || ''})`,
      err,
    });
  }

  const displayPath = formatWorkspaceRelativePath(relPath);
  return {
    uuid,
    status: 'success',
    content:
      `File ${displayPath || 'file'} written successfully.\n` +
      `IMPORTANT: All file paths MUST be relative to the workspace root.\n` +
      `Do NOT use absolute paths like /home/..., /etc/..., C:\\..., etc.`,
    meta: {
      action_type: action.type,
      filepath: targetPath,
    },
  };
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (_) {
    try {
      return String(value);
    } catch (__) {
      return '[unstringifiable]';
    }
  }
};

const resolveWorkspacePath = async (p, user_id) => {
  // Resolve a possibly relative path under workspace and restrict it.
  const resolvedUnderWorkspace = path.resolve(__dirname, WORKSPACE_DIR, p || '.');
  // IMPORTANT:
  // To match write_code behavior, pass user_id when available so paths resolve under
  // /workspace/user_<id>/... instead of /workspace/... when your runtime uses per-user workspaces.
  return await restrictFilepath(resolvedUnderWorkspace, user_id);
};

const fileExists = async (p) => {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch (_) {
    return false;
  }
};

/**
 * Best-effort lookup for a relative filepath inside existing conversation workspaces.
 * This avoids hardcoding "user_1" and works even when the request body does not include user_id/meta.
 *
 * Search order:
 *  1) /workspace/user_<N>/Conversation_<ID>/<relPath>
 *  2) /workspace/Conversation_<ID>/<relPath>
 *
 * Returns absolute path if found, otherwise null.
 */
const findInWorkspaceConversations = async (relPath) => {
  if (!isNonEmptyString(relPath)) return null;

  // Safety: normalize relPath and forbid traversal.
  const normalized = path.normalize(relPath).replace(/^([/\\])+/, '');
  if (normalized === '..' || normalized.includes('..' + path.sep)) return null;

  const workspaceRoot = path.resolve(__dirname, WORKSPACE_DIR);

  const tryFindUnder = async (rootDir, conversationPrefix) => {
    let entries;
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (_) {
      return null;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name || '';
      if (!name.startsWith(conversationPrefix)) continue;
      const candidate = path.join(rootDir, name, normalized);
      if (await fileExists(candidate)) return candidate;
    }
    return null;
  };

  // 1) /workspace/user_*/Conversation_*/file
  let users;
  try {
    users = await fs.readdir(workspaceRoot, { withFileTypes: true });
  } catch (_) {
    users = [];
  }
  for (const ent of users) {
    if (!ent.isDirectory()) continue;
    const uname = ent.name || '';
    if (!uname.startsWith('user_')) continue;
    const hit = await tryFindUnder(path.join(workspaceRoot, uname), 'Conversation_');
    if (hit) return hit;
  }

  // 2) /workspace/Conversation_*/file (legacy layout)
  const legacy = await tryFindUnder(workspaceRoot, 'Conversation_');
  if (legacy) return legacy;

  return null;
};

const normalizeTerminalRunResult = async ({ action, uuid, result }) => {
  if (!result || typeof result !== 'object') return result;

  const meta = (result.meta && typeof result.meta === 'object') ? result.meta : {};
  const out = (typeof result.stdout === 'string') ? result.stdout : (typeof result.content === 'string' ? result.content : '');
  const err = (typeof result.stderr === 'string') ? result.stderr : '';

  let exitCode = meta.exitCode;
  if (typeof exitCode !== 'number') {
    // Common fallbacks if terminal_run did not provide it.
    if (typeof result.exitCode === 'number') exitCode = result.exitCode;
    else if (typeof result.code === 'number') exitCode = result.code;
  }

  // If status says failure but exitCode is missing, default to 1.
  if (result.status === 'failure' && typeof exitCode !== 'number') exitCode = 1;
  // If status says success and exitCode missing, default to 0.
  if (result.status === 'success' && typeof exitCode !== 'number') exitCode = 0;

  // Ensure resolved_cwd is always present (best effort) and stable.
  // action_execution_server overrides cwd to an absolute workspace path; keep it too.
  const resolved_cwd = (typeof meta.resolved_cwd === 'string' && meta.resolved_cwd.trim())
    ? meta.resolved_cwd
    : (action?.params && typeof action.params.cwd === 'string' ? action.params.cwd : undefined);

  return {
    ...result,
    stdout: out,
    // Keep content as the "stdout-like" display field for backward compatibility.
    content: out,
    stderr: err,
    meta: {
      ...meta,
      action_type: action?.type || meta.action_type,
      command: action?.params?.command ?? meta.command,
      args: action?.params?.args ?? meta.args,
      cwd: action?.params?.cwd ?? meta.cwd,
      resolved_cwd,
      exitCode,
    },
  };
};

const buildFailureResult = ({ action, uuid, reason, err }) => {
  const actionType = action?.type;
  const details = [];
  details.push('Action execution failed.');
  details.push('');
  details.push('Diagnostics:');
  details.push(`- uuid: ${uuid || ''}`);
  details.push(`- action.type: ${actionType || ''}`);
  details.push(`- reason: ${reason || ''}`);
  details.push('');
  if (err) {
    details.push('Raw error (best effort):');
    if (err && typeof err === 'object') {
      const shallow = {};
      for (const k of Object.keys(err)) shallow[k] = err[k];
      details.push(safeStringify(shallow));
      if (isNonEmptyString(err.stack)) {
        details.push('');
        details.push('Stack:');
        details.push(err.stack);
      }
    } else {
      details.push(safeStringify(err));
    }
  }
  const content = details.join('\n');
  return {
    uuid,
    status: 'failure',
    error: content,
    content,
    meta: {
      action_type: actionType,
    },
  };
};


// Create Koa application instance
const app = new Koa();

// Register koaBody middleware first to parse POST request body
app.use(koaBody({
  multipart: true
}));

// Route handling
app.use(async ctx => {
  if (ctx.method === 'POST' && ctx.path === '/execute_action') {
    // Be defensive: never let the server return an empty/undefined result.
    const body = ctx.request.body || {};
    const action = body.action;
    const uuid = body.uuid;
    const user_id = getUserIdFromRequest(body, action);

    // Keep existing debug visibility but avoid crashing on circular structures.
    try {
      console.log('[ACTION_EXECUTION_SERVER] Incoming request:', safeStringify({ uuid, action_type: action?.type }));
    } catch (_) {
      console.log('[ACTION_EXECUTION_SERVER] Incoming request (unstringifiable)');
    }

    let result;
    try {
      if (!action || typeof action !== 'object') {
        result = buildFailureResult({ action, uuid, reason: 'Missing or invalid `action` object' });
      } else if (!isNonEmptyString(action.type)) {
        result = buildFailureResult({ action, uuid, reason: 'Missing or invalid `action.type`' });
      } else {
        switch (action.type) {
          case 'write_code': {
            // Ensure write_code uses the same user-scoped workspace resolution as terminal_run/replace_code_block.
            action.params = action.params || {};
            if (typeof action.params.user_id === 'undefined' && typeof user_id === 'number') {
              action.params.user_id = user_id;
            }
            result = await write_code(action, uuid, user_id);
            break;
          }
          case 'terminal_run': {
            action.params = action.params || {};
            // Resolve cwd under workspace and ensure it is safe.
            const requestedCwd = action.params.cwd || '.';
            // Match write_code behavior: resolve under user-scoped workspace when user_id is available.
            action.params.cwd = await resolveWorkspacePath(requestedCwd, user_id);

            result = await terminal_run(action, uuid);
            // Normalize result shape so upstream can reliably detect failures.
            result = await normalizeTerminalRunResult({ action, uuid, result });
            break;
          }
          case 'replace_code_block': {
            // Ensure replace_code_block uses the same user-scoped workspace resolution as terminal_run/write_code.
            action.params = action.params || {};
            if (typeof action.params.user_id === 'undefined' && typeof user_id === 'number') {
              action.params.user_id = user_id;
            }
            result = await replace_code_block(action, uuid, user_id);
            break;
          }
          case 'browser': {
            result = await browser(action, uuid);
            break;
          }
          default: {
            result = buildFailureResult({ action, uuid, reason: `Unknown action type: ${action.type}` });
            break;
          }
        }
      }
    } catch (err) {
      console.error('[ACTION_EXECUTION_SERVER] Handler threw an exception:', err);
      result = buildFailureResult({ action, uuid, reason: 'Unhandled exception in action handler', err });
    }

    // Hard guarantee: never return undefined / invalid result, and never allow empty failure content.
    if (!result || typeof result !== 'object') {
      result = buildFailureResult({ action, uuid, reason: 'Handler returned undefined or non-object result' });
    }
    if (result.status === 'failure') {
      const hasContent = isNonEmptyString(result.content);
      const hasError = isNonEmptyString(result.error);
      if (!hasContent || !hasError) {
        const fallback = buildFailureResult({
          action,
          uuid,
          reason: 'Failure result had empty content/error; applying server fallback',
        });
        // Preserve any existing fields but guarantee non-empty message.
        result = {
          ...result,
          status: 'failure',
          content: hasContent ? result.content : fallback.content,
          error: hasError ? result.error : fallback.error,
        };
      }
    }

    ctx.body = {
      message: 'Received POST /action',
      data: result,
    };
  } else {
    ctx.body = 'Koa server is running!';
  }
});

(async () => {
  try {
    const vscode_port = argv.vscode_port || 3001;
    await vscode_init('root', vscode_port);
  } catch (err) {
    console.error('[ACTION_EXECUTION_SERVER] Initialization error caught!');
    console.error('Error message:', err.message);
  }
})();

const port = argv.port || argv.p || 3000;

app.listen(port, () => {
  console.log(`Server started on http://localhost:${port}`);
});