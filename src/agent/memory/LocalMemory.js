const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TERMINAL_RUN_ID_MARKER_PREFIX = "[terminal_run_id:";
const TERMINAL_RUN_ID_MARKER_RE = /\[terminal_run_id:([^\]\s]+)\]/g;



// ---------------------------------------------------------------------------
// Pruning configuration
// ---------------------------------------------------------------------------
// Centralize "how many occurrences to keep" for unified pruning.
// Semantics: keep N latest occurrences TOTAL (history + incoming), per toolCallKey group.
const PRUNE_KEEP_OCCURRENCES = 3;

// Hard cap on total characters kept in memory context (after unified pruning).
// Keeps contiguous groups sharing the same prune_hash together.
// Set to 0 to disable.
const PRUNE_MAX_CHARS = 60_000;

// ---------------------------------------------------------------------------
// Anti-loop (repeat detection)
// ---------------------------------------------------------------------------
// If an assistant message repeats any of the previous N assistant messages (ignoring user turns),
// inject an error message right after it to force the LLM to change behavior.
const REPEAT_DETECT_WINDOW = 2;

// ---------------------------------------------------------------------------
// Pruning debug (Docker logs)
// ---------------------------------------------------------------------------
// Enabled by default (no env var, no args) as requested.
const PRUNE_DEBUG_ALWAYS_ON = true;

function pruneLog(...args) {
  if (!PRUNE_DEBUG_ALWAYS_ON) return;
  try {
    console.log('[prune_hash]', ...args);
  } catch (_) {}
}

// ensure the temporary directory exists
const { getDirpath } = require('@src/utils/electron');
const cache_dir = getDirpath('Caches/memory');
fs.mkdirSync(cache_dir, { recursive: true });

const { json2xml } = require("@src/utils/format");

function sanitizeToolReturnForLLM(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  // Remove conversation workspace paths from LLM-visible context.
  // Covers both absolute and (some) relative forms observed in logs:
  // - /workspace/user_1/Conversation_75c470/...
  // - ./user_1/Conversation_75c470/...
  // - user_1/Conversation_75c470/...
  return text.replace(/(?:\/workspace\/|\.\/)?user_\d+\/Conversation_[^\/\s'"]+\/?/g, "");
}

function extractTerminalRunIdsFromText(text) {
  if (typeof text !== 'string' || !text) return [];
  const ids = [];
  let m;
  while ((m = TERMINAL_RUN_ID_MARKER_RE.exec(text)) !== null) {
    if (m[1]) ids.push(String(m[1]).trim());
  }
  // reset regex state for safety if reused
  TERMINAL_RUN_ID_MARKER_RE.lastIndex = 0;
  return ids.filter(Boolean);
}

function messageHasTerminalRunIdMarker(message, runId) {
  if (!runId || typeof runId !== 'string') return false;
  const c = message?.content;
  if (typeof c !== 'string' || !c) return false;
  return c.includes(`${TERMINAL_RUN_ID_MARKER_PREFIX}${runId}]`);
}

function messageMetaHasRunId(message, runId) {
  if (!message || !runId) return false;
  const meta = message?.meta && typeof message.meta === 'object' ? message.meta : null;
  if (!meta) return false;
  const fromNested = meta?.action?.params?.run_id || meta?.action?.params?.runId;
  const fromMeta = meta?.run_id || meta?.runId;
  return String(fromNested || '') === String(runId) || String(fromMeta || '') === String(runId);
}

function normalizeForToolDetection(content) {
  if (typeof content !== 'string' || !content) return '';
  // Remove <think>...</think> blocks from the search buffer to avoid false tool detection.
  // Be conservative: strip them even if they appear multiple times.
  const stripped = content.replace(/<\s*think\s*>[\s\S]*?<\s*\/\s*think\s*>/gi, '');
  return stripped.trimStart();
}

function normalizeForRepeatDetection(content) {
  if (typeof content !== 'string' || !content) return '';
  // Keep this conservative to avoid unexpected behavior changes:
  // - trim whitespace
  // - do NOT strip XML tags, do NOT collapse internal spaces
  return content.trim();
}

function computeRepeatHashFromContent(content) {
  const normalized = normalizeForRepeatDetection(content);
  if (!normalized) return '';
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

function findRecentAssistantRepeatHashes(messages, maxCount) {
  const out = [];
  if (!Array.isArray(messages) || !messages.length) return out;
  const n = Math.max(0, Number.isFinite(maxCount) ? maxCount : 0);
  for (let i = messages.length - 1; i >= 0 && out.length < n; i--) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    if (m?.meta?.pruned) continue;
    const h = m?.meta?.repeat_hash;
    if (typeof h === 'string' && h) out.push(h);
  }
  return out;
}

function getStableFileKey(meta = {}, fallbackContent = '') {
  const p = meta?.action?.params || {};
  const keyFromAction = p.origin_path || p.path;
  if (keyFromAction && typeof keyFromAction === 'string') {
    // Normalize to a stable key so "/workspace/.../x.py" matches "x.py"
    return path.basename(keyFromAction);
  }

  // Some LLM transcripts store the target path in XML:
  // <write_code><path>game.py</path>...</write_code>
  if (fallbackContent && typeof fallbackContent === 'string') {
    const normalized = normalizeForToolDetection(fallbackContent);
    // Only parse <path> when the message clearly begins with a tool call.
    if (/^<\s*(write_code|read_file|patch_code|replace_code_block)\b/i.test(normalized)) {
      const tagMatch = normalized.match(/<\s*path\s*>([^<\n\r]+)<\s*\/\s*path\s*>/i);
      if (tagMatch && tagMatch[1]) {
        const p2 = String(tagMatch[1]).trim();
        if (p2) return path.basename(p2);
      }
    }
  }

  // In your recent runs, assistant write_code messages often carry the path here:
  // meta.filepath: "/workspace/.../tic_tac_toe_game.py"
  // Normalize to a stable key (basename) so it matches "tic_tac_toe_game.py" too.
  const fp = meta?.filepath;
  if (fp && typeof fp === 'string') return path.basename(fp);

  // Some message variants put the filename directly as the message content.
  // Be conservative: only accept plain filenames (no XML/angle brackets).
  if (fallbackContent && typeof fallbackContent === 'string') {
    const s = String(fallbackContent).trim();
    if (s && !s.includes('<') && !s.includes('>') && !s.includes('\n') && !s.includes('\r')) {
      return path.basename(s);
    }
  }

  return '';
}

function isTerminalRunResultMessage(message) {
  if (!message) return false;
  const t = (message?.action_type || message?.meta?.action_type || '').toString();
  return t === 'terminal_run_result';
}

function getStableTerminalRunResultKey(message) {
  if (!message) return '';
  const meta = message?.meta || {};

  // Preferred: meta.stable_key
  if (typeof meta.stable_key === 'string' && meta.stable_key.trim()) {
    return meta.stable_key.trim();
  }

  // Conservative fallbacks (do not guess from content):
  // allow a stable_key to be placed inside meta.action.params
  const sk1 = meta?.action?.params?.stable_key;
  if (typeof sk1 === 'string' && sk1.trim()) return sk1.trim();

  // allow a stable_key to be placed at top-level action (rare variants)
  const sk2 = message?.action?.params?.stable_key;
  if (typeof sk2 === 'string' && sk2.trim()) return sk2.trim();

  return '';
}


function getStableTerminalRunKeyFromMeta(meta = {}) {
  const p = meta?.action?.params || {};
  const command = typeof p.command === 'string' ? p.command : '';
  if (!command) return '';

  const argsRaw = p.args;
  const args = Array.isArray(argsRaw)
    ? argsRaw.map(String)
    : (typeof argsRaw === 'string'
      ? argsRaw.split(/\s+/).filter(Boolean)
      : []);

  const cwd = typeof p.cwd === 'string' ? p.cwd : '';
  return `${command}||${args.join(' ')}||${cwd || ''}`;
}

function getStableTerminalRunKey(message) {
  // The project usually stores action info in message.meta.action, but be robust.
  const meta = message?.meta || {};
  const directMetaKey = getStableTerminalRunKeyFromMeta(meta);
  if (directMetaKey) return directMetaKey;
  // Fallback if some variants store action at top-level.
  return getStableTerminalRunKeyFromMeta({ action: message?.action });
}

function getLogicalActionTypeFromMessage(message) {
  const t = (message?.action_type || message?.meta?.action_type || message?.meta?.action?.type || '').toString();
  if (t === 'read_file' || t === 'write_code' || t === 'patch_code' || t === 'replace_code_block' || t === 'terminal_run') return t;
 
  // Some tool-call messages can be stored as plain XML in content.
  const c = message?.content;
  if (typeof c !== 'string' || !c) return '';
  const normalized = normalizeForToolDetection(c);
  // Be conservative: only treat it as a tool call if it begins the message.
  const m = normalized.match(/^<\s*(read_file|write_code|patch_code|replace_code_block|terminal_run)\b/i);
  return m ? String(m[1]).toLowerCase() : '';
}

function getLogicalActionType(role, action_type = '', meta = {}, content = '') {
  const t = (action_type || meta?.action_type || meta?.action?.type || '').toString();
  if (t === 'read_file' || t === 'write_code' || t === 'patch_code' || t === 'replace_code_block' || t === 'terminal_run') return t;
  if (role === 'assistant' && typeof content === 'string' && content) {
    const normalized = normalizeForToolDetection(content);
    // Be conservative: only treat it as a tool call if it begins the message.
    const m = normalized.match(/^<\s*(read_file|write_code|patch_code|replace_code_block|terminal_run)\b/i);
    return m ? String(m[1]).toLowerCase() : '';
  }
  return '';
}

function getStableKeyForLogicalAction(message, logicalActionType) {
  if (!message || !logicalActionType) return '';

  if (logicalActionType === 'terminal_run') {
    const mk = getStableTerminalRunKey(message);
    if (mk) return mk;

    // Conservative XML fallback: only if clearly parseable.
    const c = message?.content;
    if (typeof c !== 'string' || !c) return '';
    const normalized = normalizeForToolDetection(c);
    if (!/^<\s*terminal_run\b/i.test(normalized)) return '';
    // attribute form: command="..."
    let command = (normalized.match(/\bcommand\s*=\s*"([^"]+)"/i) || [])[1] || '';
    // tag form: <command>...</command>
    if (!command) {
      const cm = normalized.match(/<\s*command\s*>([^<\n\r]+)<\s*\/\s*command\s*>/i);
      command = cm && cm[1] ? String(cm[1]).trim() : '';
    }
    if (!command) return '';
    let args = (normalized.match(/\bargs\s*=\s*"([^"]*)"/i) || [])[1] || '';
    if (!args) {
      const am = normalized.match(/<\s*args\s*>([\s\S]*?)<\s*\/\s*args\s*>/i);
      args = am && am[1] ? String(am[1]).trim() : '';
    }
    let cwd = (normalized.match(/\bcwd\s*=\s*"([^"]*)"/i) || [])[1] || '';
    if (!cwd) {
      const dm = normalized.match(/<\s*cwd\s*>([^<\n\r]+)<\s*\/\s*cwd\s*>/i);
      cwd = dm && dm[1] ? String(dm[1]).trim() : '';
    }
    return `${command}||${String(args).trim()}||${cwd || ''}`;
  }

  // read_file / write_code
  const mk = getStableFileKey(message?.meta, message?.content);
  if (mk) return mk;

  // Conservative XML fallback: only if clearly parseable.
  const c = message?.content;
  if (typeof c !== 'string' || !c) return '';
  const normalized = normalizeForToolDetection(c);
  if (!/^<\s*(write_code|read_file|patch_code|replace_code_block)\b/i.test(normalized)) return '';
  const p = (normalized.match(/\borigin_path\s*=\s*"([^"]+)"/i) || [])[1]
    || (normalized.match(/\bpath\s*=\s*"([^"]+)"/i) || [])[1]
    || '';
  if (p) return path.basename(p);

  // Tag form: <path>...</path>
  const tagMatch = normalized.match(/<\s*path\s*>([^<\n\r]+)<\s*\/\s*path\s*>/i);
  const p2 = tagMatch && tagMatch[1] ? String(tagMatch[1]).trim() : '';
  if (!p2) return '';
  return path.basename(p2);
}

function computePruneHash(toolName, normalizedKey) {
  if (!toolName || !normalizedKey) return '';
  const raw = `${String(toolName)}||${String(normalizedKey)}`;
  // Short, deterministic, LLM-safe identifier.
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function computeToolCallKey(toolName, normalizedKey) {
  if (!toolName || !normalizedKey) return '';
  const raw = `${String(toolName)}||${String(normalizedKey)}`;
  // Same shape as prune_hash, but stored separately and ONLY on tool-call messages.
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function pruneDebugEnabled() {
  // Enabled by default via constant (no env var / args).
  return PRUNE_DEBUG_ALWAYS_ON;
}

function pruneDebugLog(...args) {
  // Keep backward-compatible call sites, but route to always-on logger.
  pruneLog(...args);
}

function applyUnifiedPruneByHash(messages, pruneHash, keepN = 1, incomingStartsNewGroup = true) {
  if (!Array.isArray(messages) || !pruneHash) {
    pruneLog('skip:invalid_args', {
      hasMessagesArray: Array.isArray(messages),
      pruneHash: pruneHash ? String(pruneHash) : '',
    });
    return;
  }
  const keep = Math.max(1, Number.isFinite(keepN) ? keepN : 1);
  pruneLog('enter', { pruneHash, keep, incomingStartsNewGroup, historyLen: messages.length });

  // "Occurrence-aware" pruning:
  // We define an occurrence as ONE assistant tool-call plus its adjacent tool-result(s),
  // but we cannot rely on strict adjacency because other assistant/user messages may interleave.
  //
  // Deterministic policy:
  // - Occurrence is anchored on ASSISTANT messages having prune_hash=H.
  // - The occurrence includes that assistant message AND the immediate following USER message
  //   if it also has prune_hash=H.
  // - keep=1 keeps the latest anchored occurrence (tool-call + its result together).
  //
  // addMessage() prunes BEFORE pushing the incoming message:
  // - if incomingStartsNewGroup=true, we keep 0 occurrences from history (we are about to add a new one)
  // - else (incoming continues the current occurrence), we keep the last keep occurrences from history.

  // 1) Build anchored occurrences from history.
  // IMPORTANT: Do NOT include already-pruned messages in occurrence detection, otherwise
  // "blank shells" can keep being counted as the latest occurrence and prevent pruning.
  const occurrences = [];
  let skippedEmptyAssistantContent = 0;
  let skippedPruned = 0;
  let skippedNonAssistant = 0;
  for (let idx = 0; idx < messages.length; idx++) {
    const m = messages[idx];
    if (!m) continue;
    if (m.role !== 'assistant') { skippedNonAssistant++; continue; }
    if (m?.meta?.prune_hash !== pruneHash) continue;
    if (m?.meta?.pruned) { skippedPruned++; continue; }
    if (typeof m.content === 'string' && m.content.length === 0) { skippedEmptyAssistantContent++; continue; }

    const start = idx;
    let end = idx;

    const next = messages[idx + 1];
    if (
      next &&
      next.role === 'user' &&
      next?.meta?.prune_hash === pruneHash &&
      !next?.meta?.pruned &&
      !(typeof next.content === 'string' && next.content.length === 0)
    ) {
      end = idx + 1;
    }

    occurrences.push({ start, end });
  }

  if (occurrences.length === 0) {
    pruneLog('no_occurrences_in_history', {
      pruneHash,
      historyLen: messages.length,
      skippedNonAssistant,
      skippedPruned,
      skippedEmptyAssistantContent,
    });
    return;
  }

  // 2) Decide how many occurrences to keep from history.
  // NOTE: For keep=1:
  // - when a NEW occurrence is starting, we keep 0 from history (new one will become the kept occurrence)
  // - when continuing an occurrence, we keep 1 from history.
  const keepFromHistory = incomingStartsNewGroup ? Math.max(0, keep - 1) : keep;
  const keepOccurrences = keepFromHistory > 0 ? occurrences.slice(-keepFromHistory) : [];

  // 3) Build a keep set of indices.
  const keepIdx = new Set();
  for (const oc of keepOccurrences) {
    for (let k = oc.start; k <= oc.end; k++) keepIdx.add(k);
  }

  pruneDebugLog('apply', {
    pruneHash,
    keep,
    incomingStartsNewGroup,
    keepFromHistory,
    occurrences,
    keepOccurrences,
  });

  // 4) Prune everything in non-kept occurrences (call + result together).
  const blanked = [];
  for (const oc of occurrences) {
    for (let k = oc.start; k <= oc.end; k++) {
      if (keepIdx.has(k)) continue;
	  blanked.push(k);
      pruneDebugLog('blank', {
        idx: k,
        role: messages[k]?.role,
        action_type: messages[k]?.action_type,
        logical: getLogicalActionTypeFromMessage(messages[k]),
      });
      blankMessagePayload(messages[k], 'unified_prune_hash_keep_only_latest');
    }
  }

  pruneLog('exit', {
    pruneHash,
    occurrencesCount: occurrences.length,
    keepFromHistory,
    keptCount: keepOccurrences.length,
    blankedCount: blanked.length,
    blanked,
  });
}

function applyUnifiedPruneByToolCallKey(messages, toolCallKey, keepN = 1, incomingStartsNewGroup = true) {
  if (!Array.isArray(messages) || !toolCallKey) {
    pruneLog('toolCallKey:skip:invalid_args', {
      hasMessagesArray: Array.isArray(messages),
      toolCallKey: toolCallKey ? String(toolCallKey) : '',
    });
    return;
  }
  const keep = Math.max(1, Number.isFinite(keepN) ? keepN : 1);

  // Step 1) Find tool-call anchors by toolCallKey (ONLY assistant tool-call messages have it).
  const anchors = [];
  const hashes = new Set();
  let missingHash = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== 'assistant') continue;
    const k = m?.meta?.toolCallKey;
    if (!k || k !== toolCallKey) continue;
    const ph = m?.meta?.prune_hash;
    if (!ph) { missingHash++; continue; }
    anchors.push({ idx: i, pruneHash: ph });
    hashes.add(ph);
  }

  pruneLog('toolCallKey:scan', {
    toolCallKey,
    historyLen: messages.length,
    anchorsFound: anchors.length,
    uniquePruneHashes: Array.from(hashes),
    missingHashCount: missingHash,
  });

  // Rule: if toolCallKey OR prune_hash is missing for the matched group, do nothing.
  if (anchors.length === 0) return;
  if (missingHash > 0) {
    pruneLog('toolCallKey:abort:missing_prune_hash_on_anchors', { toolCallKey, missingHash });
    return;
  }
  if (hashes.size !== 1) {
    // Safety: avoid partial pruning if something inconsistent is stored.
    pruneLog('toolCallKey:abort:inconsistent_prune_hashes', {
      toolCallKey,
      uniquePruneHashes: Array.from(hashes),
    });
    return;
  }

  // Step 2) Prune occurrences by prune_hash (blank tool-call + its result together).
  const targetHash = Array.from(hashes)[0];
  applyUnifiedPruneByHash(messages, targetHash, keep, incomingStartsNewGroup);
}

function blankMessagePayload(message, reason) {
  if (!message) return;
  // Ensure pruned messages never appear in "Previous Conversation".
  // (They remain in the JSON history for index/ordering stability, but are not "memorized".)
  message.memorized = false;
  // Most renderers/loggers use message.content; clear it.
  message.content = '';
  // Some pipelines keep large payloads in meta; clear the common fields.
  if (message.meta) {
    message.meta.content = '';
    message.meta.action_memory = '';
    // patch_code may store the diff in meta.diff (keep history lean when pruned)
    if (typeof message.meta.diff !== 'undefined') message.meta.diff = '';
    // terminal_run often stores heavy output in these fields
    if (typeof message.meta.stdout !== 'undefined') message.meta.stdout = '';
    if (typeof message.meta.stderr !== 'undefined') message.meta.stderr = '';
    if (typeof message.meta.result !== 'undefined') message.meta.result = '';
    message.meta.pruned = true;
    message.meta.pruned_reason = reason || 'pruned';
    // If some versions store payload in meta.action.params.content, clear it too.
    if (message.meta.action?.params?.content) {
      message.meta.action.params.content = '';
    }
    // And if patch_code stores payload in meta.action.params.diff, clear it too.
    if (message.meta.action?.params?.diff) {
      message.meta.action.params.diff = '';
    }
    // And if replace_code_block stores payload in meta.action.params.code_block, clear it too.
    if (message.meta.action?.params?.code_block) {
      message.meta.action.params.code_block = '';
    }
  }
}

function estimateMessageCharCost(message) {
  if (!message || typeof message !== 'object') return 0;
  // Count "characters of each message" in a predictable way.
  // Primary: message.content (what goes into prompt most often).
  // Secondary: meta.action_memory (can also be injected), action_type.
  let n = 0;
  const c = message.content;
  if (typeof c === 'string') n += c.length;
  const at = message.action_type;
  if (typeof at === 'string') n += at.length;
  const am = message?.meta?.action_memory;
  if (typeof am === 'string') n += am.length;
  return n;
}

function getPruneHashForGrouping(message) {
  const ph = message?.meta?.prune_hash;
  return typeof ph === 'string' ? ph : '';
}

function applyCharBudgetPruneKeepingPruneHashGroups(messages, maxChars, extraIncomingChars = 0) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  const budget = Number.isFinite(maxChars) ? maxChars : 0;
  if (!budget || budget <= 0) return;

  if (messages.length === 0) return;

  // Build contiguous blocks by prune_hash for indices [0..end].
  // Block = { start, end, pruneHash, chars }
  const blocks = [];
  let i = 0;
  while (i < messages.length) {
    const start = i;
    const ph = getPruneHashForGrouping(messages[i]);
    let chars = 0;
    let j = i;
    while (j < messages.length) {
      const ph2 = getPruneHashForGrouping(messages[j]);
      if (ph2 !== ph) break;
      chars += estimateMessageCharCost(messages[j]);
      j++;
    }
    const end = j - 1;
    blocks.push({ start, end, pruneHash: ph, chars });
    i = j;
  }

  // Walk from newest to oldest blocks, summing chars.
  // When we exceed budget, we keep the block that exceeded (to avoid cutting too aggressively),
  // but drop all blocks older than it (full blocks only).
  let sum = Math.max(0, Number.isFinite(extraIncomingChars) ? extraIncomingChars : 0);
  let cutoffStart = 0; // keep everything by default

  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const b = blocks[bi];
    sum += b.chars;
    if (sum > budget) {
      cutoffStart = b.start;
      break;
    }
  }

  if (cutoffStart <= 0) {
    pruneLog('char_budget:keep_all', {
      budget,
      sumWithIncoming: sum,
      blocks: blocks.length,
      messagesLen: messages.length,
    });
    return;
  }

  // Remove messages [0 .. cutoffStart-1] (oldest), removing full blocks only.
  const removedCount = cutoffStart;
  const removedPreview = [];
  const previewMax = 8;
  for (let k = 0; k < cutoffStart && removedPreview.length < previewMax; k++) {
    removedPreview.push({
      idx: k,
      role: messages[k]?.role,
      action_type: messages[k]?.action_type,
      prune_hash: messages[k]?.meta?.prune_hash || '',
      content_len: typeof messages[k]?.content === 'string' ? messages[k].content.length : 0,
    });
  }

  messages.splice(0, removedCount);

  pruneLog('char_budget:pruned', {
    budget,
    sumWithIncoming: sum,
    cutoffStart,
    removedCount,
    removedPreview,
    remainingLen: messages.length,
    blocksCount: blocks.length,
  });
}

function isInformationToolCall(role, content) {
  if (role !== 'assistant') return false;
  if (typeof content !== 'string' || !content) return false;
  const normalized = normalizeForToolDetection(content);
  return /^<\s*information\b/i.test(normalized);
}

function isAcknowledgedMessage(role, content) {
  if (role !== 'user') return false;
  if (typeof content !== 'string') return false;
  const s = content.trim();
  return s === 'Acknowledged.' || s === 'Acknowledged';
}

class LocalMemory {
  constructor(options = {}) {
    this.options = options;
    this.memory_dir = options.memory_dir;
    if (this.memory_dir) {
      const dir = path.resolve(cache_dir, this.memory_dir);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.key = options.key; // primary key ID
    console.log(`LocalMemory initialized with key: ${this.key}`);

    // When we detect a repeated assistant output, we must REPLACE the next
    // "Acknowledged." user message with the error (to keep strict alternation).
    this._pendingRepeatError = null;
  }
  
  
  /**
   * Remove ALL messages that match a predicate.
   * Returns number of removed messages.
   */
  async removeMessagesWhere(predicateFn) {
    const messages = await this._loadMemory();
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    const filtered = [];
    let removed = 0;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      let match = false;
      try {
        match = !!predicateFn(m, i, messages);
      } catch (e) {
        match = false;
      }
      if (match) {
        removed++;
        continue;
      }
      filtered.push(m);
    }

    if (removed > 0) {
      await this._saveMemory(filtered);
    }
    return removed;
  }

  /**
   * Purge a terminal_run "thread" by its run_id:
   * - the terminal_run result message carrying that run_id (meta)
   * - all user/assistant error/reflection messages that contain the run_id marker
   * - any tool-call message that also carries marker/meta (best effort)
   *
   * IMPORTANT: does not touch MESSAGE0.
   */
  async purgeTerminalRunByRunId(runId) {
    if (!runId || typeof runId !== 'string' || !runId.trim()) return 0;
    const rid = runId.trim();
    // We also optionally purge the immediate preceding assistant tool-call <terminal_run>
    // that triggered the terminal_run_result, even if it doesn't carry run_id/marker.
    // Implementation: first pass finds indices to remove, second pass removes them safely.
    const messages = await this._loadMemory();
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    const toRemove = new Set();

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;

      const matchByMeta = messageMetaHasRunId(m, rid);
      const matchByMarker = messageHasTerminalRunIdMarker(m, rid);
      const matchByExtract = extractTerminalRunIdsFromText(m?.content || '').includes(rid);

      if (matchByMeta || matchByMarker || matchByExtract) {
        toRemove.add(i);

        // Proximity purge: if the previous message looks like the assistant tool-call for terminal_run, remove it too.
        const prevIndex = i - 1;
        if (prevIndex >= 0) {
          const prev = messages[prevIndex];
          const prevType = getLogicalActionTypeFromMessage(prev);
          if (prev && prev.role === 'assistant' && prevType === 'terminal_run') {
            toRemove.add(prevIndex);
          }
        }
      }
    }

    if (toRemove.size === 0) return 0;

    const filtered = [];
    for (let i = 0; i < messages.length; i++) {
      if (toRemove.has(i)) continue;
      filtered.push(messages[i]);
    }
    await this._saveMemory(filtered);
    return toRemove.size;

    /*
    // Old predicate-only implementation (kept as reference)
    return await this.removeMessagesWhere((m) => {
      if (!m || typeof m !== 'object') return false;
      // Direct meta linkage (preferred)
      if (messageMetaHasRunId(m, rid)) return true;
      // Marker linkage in content (used by code-act.js)
      if (messageHasTerminalRunIdMarker(m, rid)) return true;
      // Also purge messages that include multiple run_id markers and include this one
      const ids = extractTerminalRunIdsFromText(m?.content || '');
      if (ids.includes(rid)) return true;
      return false;
    });
    */
  }

  _getFilePath() {
    if (this.memory_dir) {
      const dir = path.resolve(cache_dir, this.memory_dir);
      return path.resolve(dir, `${this.key}.json`);
    }
    // use this.key as the file name, store in the specified temporary directory
    return path.resolve(cache_dir, `${this.key}.json`);
  }

  async _loadMemory() {
    const filePath = this._getFilePath();
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      // if the file does not exist or there is an error reading it, return an empty array
      if (error.code !== 'ENOENT') {
        console.error(`Error reading memory file for ${this.key}:`, error);
      }
      return [];
    }
  }

  async _saveMemory(messages) {
    const filePath = this._getFilePath();
    try {
      fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), 'utf-8');
      console.log(`Memory for task ${this.key} saved successfully.`);
    } catch (error) {
      console.error(`Error saving memory file for ${this.key}:`, error);
      throw new Error(`Failed to save memory for task ${this.key}`);
    }
  }

  /**
   * Remove the last message that matches a predicate.
   * Returns the removed message, or null if nothing matched.
   */
  async removeLastMessageWhere(predicateFn) {
    const messages = await this._loadMemory();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      let ok = false;
      try {
        ok = !!predicateFn(m, i, messages);
      } catch (e) {
        ok = false;
      }
      if (ok) {
        const removed = messages.splice(i, 1)[0];
        await this._saveMemory(messages);
        return removed || null;
      }
    }
    return null;
  }

  /**
   * Remove the last assistant message (used to drop an invalid XML/tool output
   * so it does not get propagated in the next inference).
   * Returns the removed message, or null if no assistant message was found.
   */
  async removeLastAssistantMessage() {
    return await this.removeLastMessageWhere((m) => m?.role === 'assistant');
  }

  /**
   * Convenience: remove the last message regardless of role.
   * Returns the removed message, or null if memory is empty.
   */
  async popLastMessage() {
    const messages = await this._loadMemory();
    if (!messages.length) return null;
    const removed = messages.pop() || null;
    await this._saveMemory(messages);
    return removed;
  }


  async addMessage(role, content, action_type = '', memorized = false, meta = {}) {
    // 1. load message list
	const KEEP_N = PRUNE_KEEP_OCCURRENCES;
	
    const messages = await this._loadMemory();

    const buildRepeatErrorText = () => ([
      'ERROR: repeated assistant output detected.',
      'You must NOT repeat the same message again.',
      'You must change strategy and produce a different output and/or call a concrete tool.',
    ].join(' '));

    // Fallback: if a repeat was detected previously but no "Acknowledged." arrived,
    // inject the error before the next assistant message to restore alternation.
    if (role === 'assistant' && this._pendingRepeatError) {
      const pending = this._pendingRepeatError;
      this._pendingRepeatError = null;
      messages.push({
        role: 'user',
        content: pending.errText || buildRepeatErrorText(),
        action_type: 'llm_output_rejected_repeat',
        memorized: false,
        meta: {
          repeat_detected: true,
          repeat_hash: pending.repeat_hash || '',
          prune_hash: pending.prune_hash || '',
          prune_hash_keep: KEEP_N,
        },
      });
    }

    // Always sanitize paths before storing/injecting into context.
    // This keeps memory stable and prevents path leakage, even if callers forget.
    content = sanitizeToolReturnForLLM(content);

    const logicalActionType = getLogicalActionType(role, action_type, meta, content);
	
    // If we previously detected a repeated assistant output, the runtime typically
    // appends a user "Acknowledged.". Replace that acknowledged with the error.
    if (role === 'user' && isAcknowledgedMessage(role, content) && this._pendingRepeatError) {
      const pending = this._pendingRepeatError;
      this._pendingRepeatError = null;

      // Replace content/action_type/meta (keep strict assistant/user alternation).
      content = pending.errText || buildRepeatErrorText();
      action_type = 'llm_output_rejected_repeat';
      if (!meta || typeof meta !== 'object') meta = {};
      meta.repeat_detected = true;
      meta.repeat_hash = pending.repeat_hash || '';

      // Ensure the injected/replaced user message has a prune_hash.
      // Prefer grouping it with the repeated assistant message (same prune_hash) if available.
      if (pending.prune_hash && !meta.prune_hash) {
        meta.prune_hash = pending.prune_hash;
      }
      if (meta.prune_hash) {
        meta.prune_hash_keep = KEEP_N;
      }
    }

    // ---------------------------------------------------------------------
    // Anti-loop: detect repeats of assistant output (ignoring user turns).
    // We want the repeated assistant message to still be stored, then append
    // a forcing error message right after it by REPLACING the next "Acknowledged."
    // user message. This keeps strict alternation: assistant/user, assistant/user.
    //
    // IMPORTANT:
    // - Only applies to role="assistant"
    // - Skips pruned assistant messages
    // - Compares against the previous N assistant messages (default 2)
    // ---------------------------------------------------------------------
    let repeatDetected = false;
    let incomingRepeatHash = '';
    if (role === 'assistant' && typeof content === 'string' && content) {
      incomingRepeatHash = computeRepeatHashFromContent(content);
      if (incomingRepeatHash) {
        // Store repeat_hash for later comparisons.
        if (meta && typeof meta === 'object') {
          meta.repeat_hash = incomingRepeatHash;
        }
        const recent = findRecentAssistantRepeatHashes(messages, REPEAT_DETECT_WINDOW);
        if (recent.includes(incomingRepeatHash)) {
          repeatDetected = true;
        }
      }
    }

    // De-dupe adjacent identical messages (same role + same content).
    // IMPORTANT: do NOT require action_type equality: runtime + agent layers may log the same text with different action_type values.
    // This prevents duplicated error feedback like MESSAGE2/MESSAGE3 in the LLM prompt.
    const last = messages.length ? messages[messages.length - 1] : null;
    if (
      last &&
      last.role === role &&
      typeof last.content === 'string' &&
      typeof content === 'string' &&
      last.content === content
    ) {
      return;
    }
	
    // Unified pruning (single entry point):
    // - Identify identical tool-call groups by toolCallKey (tool + arguments).
    // - Then prune the group by prune_hash (occurrence = tool-call + result).
    // - NO fallback: if toolCallKey or prune_hash is empty, do nothing.
    let incomingPruneHash = (meta && typeof meta === 'object' && typeof meta.prune_hash === 'string')
      ? meta.prune_hash
      : '';

    const isTermResult = isTerminalRunResultMessage({ role, content, action_type, meta });
	
    // toolCallKey is ONLY set on assistant tool-call messages (not on results).
    const isToolCallAssistant =
      role === 'assistant' &&
      !isTermResult &&
      (logicalActionType === 'read_file' ||
        logicalActionType === 'write_code' ||
        logicalActionType === 'patch_code' ||
        logicalActionType === 'replace_code_block' ||
        logicalActionType === 'terminal_run');

    let incomingToolCallKey = '';
    if (isToolCallAssistant) {
      const stableKey = getStableKeyForLogicalAction({ role, content, action_type, meta }, logicalActionType);
      incomingToolCallKey = computeToolCallKey(logicalActionType, stableKey);
      if (incomingToolCallKey && meta && typeof meta === 'object') {
        meta.toolCallKey = incomingToolCallKey;
      }
      // prune_hash for tool-call: derived from the same (tool + stableKey).
      if (!incomingPruneHash) {
        incomingPruneHash = computePruneHash(logicalActionType, stableKey);
      }
    }

    // terminal_run_result: do NOT set toolCallKey; prune_hash may be computed only if stable_key exists.
    if (!incomingPruneHash && isTermResult) {
      const stableKey = getStableTerminalRunResultKey({ role, content, action_type, meta });
      incomingPruneHash = computePruneHash('terminal_run', stableKey);
    }

    // information tool-call: assign a prune_hash so it can be grouped/pruned like other tool calls.
    // We use a short digest of the normalized content as a stable key.
    if (!incomingPruneHash && isInformationToolCall(role, content)) {
      const normalized = normalizeForToolDetection(content);
      const infoKey = crypto.createHash('sha1').update(normalized, 'utf8').digest('hex').slice(0, 16);
      incomingPruneHash = computePruneHash('information', infoKey);
    }

    // "Acknowledged." assistant messages that immediately follow an <information> tool-call
    // inherit the same prune_hash, so they stay in the same contiguous block.
    if (!incomingPruneHash && isAcknowledgedMessage(role, content) && messages.length) {
      const prev = messages[messages.length - 1];
      const prevHash = prev?.meta?.prune_hash;
      if (
        prev &&
        typeof prevHash === 'string' &&
        prevHash &&
        isInformationToolCall(prev.role, prev.content)
      ) {
        incomingPruneHash = prevHash;
      }
    }
	
    // Explicit inheritance for result messages: if the previous message is the tool-call,
    // copy its prune_hash. Best-effort and deterministic (adjacent pairing).
    if (!incomingPruneHash && role === 'user' && messages.length) {
      const prev = messages[messages.length - 1];
      const prevHash = prev?.meta?.prune_hash;
      if (prev && prev.role === 'assistant' && typeof prevHash === 'string' && prevHash) {
        incomingPruneHash = prevHash;
      }
    }

    if (incomingPruneHash && meta && typeof meta === 'object') {
      meta.prune_hash = incomingPruneHash;
      meta.prune_hash_keep = KEEP_N;
    }

    // Apply unified pruning BEFORE pushing the new message:
    // - entry point is toolCallKey (tool + arguments), ONLY for assistant tool calls
    // - then prune the identified group by prune_hash
    // - NO fallback if toolCallKey or prune_hash is empty
    if (isToolCallAssistant) {
      if (!incomingToolCallKey || !incomingPruneHash) {
        pruneLog('addMessage:toolCallKey:skip:missing_keys', {
          incomingRole: role,
          incomingLogicalActionType: logicalActionType,
          incomingToolCallKey: incomingToolCallKey || '',
          incomingPruneHash: incomingPruneHash || '',
          historyLen: messages.length,
        });
      } else {
        // A tool-call always starts a NEW occurrence.
        const incomingStartsNewGroup = true;
        pruneLog('addMessage:toolCallKey:before_prune', {
          incomingRole: role,
          incomingActionType: action_type,
          incomingLogicalActionType: logicalActionType,
          incomingToolCallKey,
          incomingPruneHash,
          incomingStartsNewGroup,
          historyLen: messages.length,
        });
        applyUnifiedPruneByToolCallKey(messages, incomingToolCallKey, KEEP_N, incomingStartsNewGroup);
        pruneLog('addMessage:toolCallKey:after_prune', {
          incomingToolCallKey,
          incomingPruneHash,
          historyLen: messages.length,
        });
      }
    }
	
    // 4th pruning routine (hard cap by total chars), applied AFTER unified pruning rules.
    // Must keep contiguous groups sharing the same prune_hash together.
    // Include incoming message chars in the budget calculation to keep the final prompt bounded.
    if (PRUNE_MAX_CHARS > 0) {
      const incomingCharCost = (() => {
        // Estimate cost similarly to stored messages.
        let n = 0;
        if (typeof content === 'string') n += content.length;
        if (typeof action_type === 'string') n += action_type.length;
        const am = meta?.action_memory;
        if (typeof am === 'string') n += am.length;
        return n;
      })();
      applyCharBudgetPruneKeepingPruneHashGroups(messages, PRUNE_MAX_CHARS, incomingCharCost);
    }

    // 3. add new message
    const { action = {}, status = 'success' } = meta;
    if (role === 'user' && memorized) {
      const full_memory_info = Object.assign(action, {
        status, result: content
      })
      meta.action_memory = meta.action_memory || json2xml(full_memory_info)
    }

    // For debugging/consistency: keep the caller-provided action_type,
    // but also ensure meta.action_type is populated with the normalized logical value.
    if (meta && typeof meta === 'object' && logicalActionType && !meta.action_type) {
      meta.action_type = logicalActionType;
    }

    messages.push({ role, content, action_type, memorized, meta });

    // If repeat detected, store a pending error that will REPLACE the next user
    // "Acknowledged." message. This avoids user/user sequences and keeps strict alternation.
    if (repeatDetected) {
      this._pendingRepeatError = {
        errText: buildRepeatErrorText(),
        repeat_hash: incomingRepeatHash || '',
        // Group with the repeated assistant message when possible so pruning stays coherent.
        prune_hash: (meta && typeof meta === 'object' && typeof meta.prune_hash === 'string') ? meta.prune_hash : '',
      };
    }
	
    // 4. save message list
    await this._saveMemory(messages);
  }

  async getMessages() {
    const messages = await this._loadMemory();
    return messages;
  }

  async clearMemory() {
    const filePath = this._getFilePath();
    try {
      await fs.unlinkSync(filePath);
      console.log(`Memory for task ${this.key} cleared successfully.`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        // file does not exist, be considered as cleared
        console.log(`No memory file found for task ${this.key} to clear.`);
      } else {
        console.error(`Error clearing memory file for ${this.key}:`, error);
        throw new Error(`Failed to clear memory for task ${this.key}`);
      }
    }
  }

  // get memorized content
  async getMemorizedContent() {
    // 1. load message list
    const messages = await this._loadMemory();
    // 2. extract content
    const list = [];
    for (const message of messages) {
      const { action_type = '', memorized, meta = {} } = message;
      if (!memorized) {
        continue; // skip non-memorized message
      }
      const action_memory = meta.action_memory || `${action_type.toUpperCase()}: ${message.content}`;
      list.push(sanitizeToolReturnForLLM(action_memory));
    }
    return list.join('\n');
  }
}

module.exports = LocalMemory;