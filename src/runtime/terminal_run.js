const { exec, spawn } = require('child_process');
const { restrictFilepath } = require('./runtime.util');

// Hard timeout for terminal_run (adjustable).
// If exceeded, the child process is killed and the action returns a clear timeout failure.
const TERMINAL_RUN_TIMEOUT_MS = 30_000;

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

const runCommand = (command, args, cwd) => {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    if (!isNonEmptyString(command)) {
      reject({
        error: 'terminal_run: missing or empty command',
        stderr: 'terminal_run: missing or empty command',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
      });
      return;
    }
    if (Array.isArray(args)) {
      args = args.join(' ');
    }
    if (args === undefined || args === null) {
      args = '';
    }
    if (typeof args !== 'string') {
      args = String(args);
    }
    const fullCommand = `${command} ${args}`;
    console.log('fullCommand', fullCommand, 'cwd', cwd);

    // Handle nohup command
    // NOTE: guard against undefined command (and keep behavior identical otherwise)
    if (typeof command === 'string' && command.includes('nohup')) {
      // Use shell to execute nohup command
      const child = spawn('sh', ['-c', fullCommand], {
        cwd,
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'] // Ignore all standard input output
      });
      child.unref(); // Allow parent process to exit independently of child process
      resolve({
        stdout: `Background process started, PID: ${child.pid}, output redirected to nohup.out`,
        stderr: '',
        exitCode: 0,
        signal: null,
        durationMs: Date.now() - startedAt,
      });
    } else {
      exec(
        fullCommand,
        {
          cwd,
          timeout: TERMINAL_RUN_TIMEOUT_MS,
          // Be explicit: if timeout triggers, kill the process.
          // (Note: exec's internal kill may not kill grandchildren; this still prevents indefinite hangs.)
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
        if (error) {
          const timedOut =
            (typeof error.killed === 'boolean' && error.killed === true) &&
            (typeof error.signal === 'string' && error.signal.toUpperCase().includes('KILL')) &&
            (typeof error.code !== 'number'); // timeout usually yields non-numeric code

          if (timedOut) {
            const timeoutMsg = `terminal_run: TIMEOUT after ${TERMINAL_RUN_TIMEOUT_MS}ms: ${fullCommand}`;
            reject({
              error: timeoutMsg,
              code: error.code,
              signal: error.signal,
              stderr: (stderr ? `${stderr}\n` : '') + timeoutMsg + '\n',
              stdout,
              exitCode: null,
              durationMs: Date.now() - startedAt,
              timedOut: true,
            });
            return;
          }

          // Preserve structured diagnostics for upstream fallback rendering.
          reject({
            error: error.message,
            code: error.code,
            signal: error.signal,
            stderr,
            stdout,
            exitCode: (typeof error.code === 'number' ? error.code : null),
            durationMs: Date.now() - startedAt,
          });
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: 0,
          signal: null,
          durationMs: Date.now() - startedAt,
        });
      });
    }
  });
}

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

const buildEmptyFailureFallback = (action, uuid, executionDir, err) => {
  const params = action?.params || {};
  const { command, args = [], cwd = '.' } = params;

  const lines = [];
  lines.push('terminal_run failed but no output was captured.');
  lines.push('');
  lines.push('Diagnostics:');
  lines.push(`- uuid: ${uuid || ''}`);
  lines.push(`- command: ${command || ''}`);
  lines.push(`- args: ${Array.isArray(args) ? safeStringify(args) : String(args ?? '')}`);
  lines.push(`- cwd (requested): ${cwd || ''}`);
  lines.push(`- cwd (resolved): ${executionDir || ''}`);
  lines.push('');
  lines.push('Raw error (best effort):');

  if (err && typeof err === 'object') {
    const shallow = {};
    for (const k of Object.keys(err)) shallow[k] = err[k];
    lines.push(safeStringify(shallow));
  } else {
    lines.push(safeStringify(err));
  }

  return lines.join('\n');
};


const terminal_run = async (action, uuid) => {
  const params = action?.params || {};
  const { command, args = [], cwd = '.' } = params;

  // Never crash / never attempt execution if tool args are invalid.
  if (!isNonEmptyString(command)) {
    const fallback = buildEmptyFailureFallback(action, uuid, '', { error: 'terminal_run: missing or empty command' });
    return {
      uuid,
      status: 'failure',
      error: 'terminal_run: missing or empty command',
      content: fallback,
      stdout: '',
      stderr: 'terminal_run: missing or empty command',
      meta: { action_type: action?.type }
    };
  }

  const executionDir = await restrictFilepath(cwd);
  try {
    const result = await runCommand(command, args, executionDir);
    const stdout = (result && typeof result.stdout === 'string') ? result.stdout : '';
    const stderr = (result && typeof result.stderr === 'string') ? result.stderr : '';
    const exitCode = (result && typeof result.exitCode === 'number') ? result.exitCode : 0;
    const signal = (result && typeof result.signal === 'string') ? result.signal : null;
    const durationMs = (result && typeof result.durationMs === 'number') ? result.durationMs : null;

    return {
      uuid,
      status: 'success',
      content: stdout || 'Execution result has no return content',
      stdout,
      stderr,
      meta: {
        action_type: action.type,
        command,
        args,
        cwd,
        resolved_cwd: executionDir,
        exitCode,
        signal,
        durationMs,
      }
    };
  } catch (e) {
    console.error('Error executing command:', e);

    const stderr = (e && typeof e === 'object' && typeof e.stderr === 'string') ? e.stderr : '';
    const stdout = (e && typeof e === 'object' && typeof e.stdout === 'string') ? e.stdout : '';
    const exitCode =
      (e && typeof e === 'object' && typeof e.exitCode === 'number') ? e.exitCode :
      (e && typeof e === 'object' && typeof e.code === 'number') ? e.code :
      null;
    const signal = (e && typeof e === 'object' && typeof e.signal === 'string') ? e.signal : null;
    const durationMs = (e && typeof e === 'object' && typeof e.durationMs === 'number') ? e.durationMs : null;
	const timedOut = (e && typeof e === 'object' && e.timedOut === true) ? true : false;

    const msg =
      stderr ||
      stdout ||
      (e && typeof e === 'object' && typeof e.error === 'string' ? e.error : '') ||
      (e && typeof e === 'object' && typeof e.message === 'string' ? e.message : '') ||
      '';

    const fallback = msg || buildEmptyFailureFallback(action, uuid, executionDir, e);

    return {
      uuid,
      status: 'failure',
      error: fallback,
      content: fallback,
      stdout,
      stderr: stderr || '',
      meta: {
        action_type: action?.type,
        command,
        args,
        cwd,
        resolved_cwd: executionDir,
        exitCode,
        signal,
        durationMs,
        timedOut,
        timeoutMs: TERMINAL_RUN_TIMEOUT_MS,
      }
    };
  }
}

module.exports = terminal_run;

