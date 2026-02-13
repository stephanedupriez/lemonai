const { restrictFilepath } = require('../runtime.util');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const write_file = async (filepath, content) => {
  // Ensure the directory exists
  const dir = path.dirname(filepath);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EXIST') {
      throw err;
    }
  }
  return fs.writeFile(filepath, content);
}

// Hex probe for write_code / replace_code_block.
// Default OFF to avoid polluting logs.
// (Toggle manually in code when you need deep diagnostics.)
const PROBE_HEX_DUMP = false;

const isNonEmptyLine = (s) => typeof s === 'string' && s.trim().length > 0;

const findLineBoundsContainingIndex = (text, idx) => {
  // Returns [lineStart, lineEndExclusive]
  const start = text.lastIndexOf('\n', idx - 1) + 1; // -1 => 0
  const endNl = text.indexOf('\n', idx);
  const end = endNl === -1 ? text.length : endNl + 1;
  return [start, end];
};

// Normalize a snippet for comparisons / no-op detection:
// - unify line endings
// - drop leading/trailing blank lines
// - ensure exactly one trailing newline
const normalizeSnippet = (s) => {
  const t = String(s ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
  return t.length ? (t + '\n') : '';
};


// -----------------------------
// Unified diff generation (pure JS, line-based)
// -----------------------------
const normalizeToLF = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const splitLinesPreserveEmptyLast = (textLF) => {
  // Keep behavior stable for files ending with '\n' (split produces trailing "").
  return String(textLF ?? '').split('\n');
};

const myersDiffOps = (aLines, bLines) => {
  // Myers diff (O((N+M)D)) producing ops in forward order:
  // { t: '=', line }, { t: '-', line }, { t: '+', line }
  const a = aLines ?? [];
  const b = bLines ?? [];
  const N = a.length;
  const M = b.length;

  // Edge cases
  if (N === 0 && M === 0) return [];
  if (N === 0) return b.map((line) => ({ t: '+', line }));
  if (M === 0) return a.map((line) => ({ t: '-', line }));

  const max = N + M;
  const offset = max;
  const v = new Array(2 * max + 1).fill(0);
  const trace = [];

  for (let d = 0; d <= max; d++) {
    // Save snapshot for backtracking
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + offset;
      let x;
      if (k === -d || (k !== d && v[kIdx - 1] < v[kIdx + 1])) {
        // down: insertion in a (advance in b)
        x = v[kIdx + 1];
      } else {
        // right: deletion from a (advance in a)
        x = v[kIdx - 1] + 1;
      }
      let y = x - k;
      // follow diagonal (equal lines)
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[kIdx] = x;
      if (x >= N && y >= M) {
        // Found solution; backtrack
        const opsRev = [];
        let bx = N;
        let by = M;
        for (let bd = d; bd > 0; bd--) {
          const vv = trace[bd];
          const kk = bx - by;
          const kkIdx = kk + offset;
          let prevK;
          if (kk === -bd || (kk !== bd && vv[kkIdx - 1] < vv[kkIdx + 1])) {
            prevK = kk + 1; // came from down (insertion)
          } else {
            prevK = kk - 1; // came from right (deletion)
          }
          const prevX = vv[prevK + offset];
          const prevY = prevX - prevK;

          // Diagonal (equals)
          while (bx > prevX && by > prevY) {
            opsRev.push({ t: '=', line: a[bx - 1] });
            bx--;
            by--;
          }

          // Edit step
          if (bx === prevX) {
            // insertion (from b)
            opsRev.push({ t: '+', line: b[by - 1] });
            by--;
          } else {
            // deletion (from a)
            opsRev.push({ t: '-', line: a[bx - 1] });
            bx--;
          }
        }
        // Remaining diagonal
        while (bx > 0 && by > 0) {
          opsRev.push({ t: '=', line: a[bx - 1] });
          bx--;
          by--;
        }
        // Remaining edges
        while (bx > 0) {
          opsRev.push({ t: '-', line: a[bx - 1] });
          bx--;
        }
        while (by > 0) {
          opsRev.push({ t: '+', line: b[by - 1] });
          by--;
        }
        opsRev.reverse();
        return opsRev;
      }
    }
  }
  // Fallback (should not happen)
  const ops = [];
  for (const line of a) ops.push({ t: '-', line });
  for (const line of b) ops.push({ t: '+', line });
  return ops;
};

const buildUnifiedDiffFromOps = (filepath, ops, contextLines = 3) => {
  // Returns "" if no changes.
  if (!Array.isArray(ops) || ops.length === 0) return '';
  const hasChange = ops.some((op) => op.t === '+' || op.t === '-');
  if (!hasChange) return '';

  const ctx = Math.max(0, Number(contextLines) || 0);
  const lines = [];
  lines.push(`--- ${filepath}`);
  lines.push(`+++ ${filepath}`);

  // Track positions in old/new files (1-based for diff headers).
  let oldLineNo = 1;
  let newLineNo = 1;

  // Helper to flush a hunk
  const flushHunk = (hunk) => {
    if (!hunk) return;
    const { oldStart, newStart, oldCount, newCount, body } = hunk;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const l of body) lines.push(l);
  };

  // Build hunks with context
  let i = 0;
  let pendingEquals = []; // recent '=' lines for pre-context
  let hunk = null;
  let postContextRemaining = 0;

  const startHunkIfNeeded = () => {
    if (hunk) return;
    // Pre-context: last ctx equals lines
    const pre = pendingEquals.slice(Math.max(0, pendingEquals.length - ctx));
    // oldStart/newStart are current positions minus pre length
    const oldStart = oldLineNo - pre.length;
    const newStart = newLineNo - pre.length;
    hunk = {
      oldStart,
      newStart,
      oldCount: 0,
      newCount: 0,
      body: [],
    };
    // Emit pre-context into hunk
    for (const pline of pre) {
      hunk.body.push(` ${pline}`);
      hunk.oldCount++;
      hunk.newCount++;
    }
    postContextRemaining = 0;
  };

  const endHunkIfPossible = () => {
    if (!hunk) return;
    if (postContextRemaining > 0) return; // still collecting trailing context
    flushHunk(hunk);
    hunk = null;
  };

  while (i < ops.length) {
    const op = ops[i];
    if (op.t === '=') {
      if (hunk) {
        if (postContextRemaining > 0) {
          // still within forced post-context window
          hunk.body.push(` ${op.line}`);
          hunk.oldCount++;
          hunk.newCount++;
          postContextRemaining--;
          if (postContextRemaining === 0) {
            // we can end hunk now, but may extend if upcoming ops are changes
            // defer: if next ops are '=', we’ll end now; if change, we keep.
            // Here we just allow end; next iteration may restart with pre-context.
          }
        } else {
          // Not in post-context: buffer equals as potential context
          pendingEquals.push(op.line);
          // Keep pendingEquals bounded to ctx
          if (pendingEquals.length > ctx) pendingEquals.shift();
        }
      } else {
        pendingEquals.push(op.line);
        if (pendingEquals.length > ctx) pendingEquals.shift();
      }
      oldLineNo++;
      newLineNo++;
      // If we have a hunk and we just finished post-context, finalize it
      if (hunk && postContextRemaining === 0) {
        // Peek next op: if next is change, we should keep going and include buffered equals as context
        const next = ops[i + 1];
        if (!next || next.t === '=') {
          endHunkIfPossible();
          // Any pendingEquals should already be correct; if we ended, it stays.
        }
      }
      i++;
      continue;
    }

    // Change op
    startHunkIfNeeded();

    // If we had pendingEquals that weren't emitted (because hunk existed but not in post-context),
    // we need to append them as context before the change (they represent skipped '=' lines).
    if (pendingEquals.length) {
      for (const pline of pendingEquals) {
        hunk.body.push(` ${pline}`);
        hunk.oldCount++;
        hunk.newCount++;
      }
      pendingEquals = [];
    }

    if (op.t === '-') {
      hunk.body.push(`-${op.line}`);
      hunk.oldCount++;
      oldLineNo++;
      // set/refresh post-context window
      postContextRemaining = ctx;
    } else if (op.t === '+') {
      hunk.body.push(`+${op.line}`);
      hunk.newCount++;
      newLineNo++;
      postContextRemaining = ctx;
    }
    i++;
  }

  // If hunk still open, we may need to append any remaining buffered equals as post-context
  if (hunk) {
    // Emit up to ctx lines from pendingEquals as trailing context
    if (pendingEquals.length) {
      const take = pendingEquals.slice(0, ctx);
      for (const pline of take) {
        hunk.body.push(` ${pline}`);
        hunk.oldCount++;
        hunk.newCount++;
      }
      pendingEquals = [];
    }
    flushHunk(hunk);
  }

  return lines.join('\n');
};

const generateUnifiedDiff = (filepath, oldText, newText, contextLines = 3) => {
  const oldLF = normalizeToLF(oldText);
  const newLF = normalizeToLF(newText);
  if (oldLF === newLF) return '';

  const aLines = splitLinesPreserveEmptyLast(oldLF);
  const bLines = splitLinesPreserveEmptyLast(newLF);
  const ops = myersDiffOps(aLines, bLines);
  return buildUnifiedDiffFromOps(filepath, ops, contextLines);
};



const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return '"[unserializable]"';
  }
};

const sha256TextHex = (text) => {
  try {
    return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
  } catch (_) {
    return undefined;
  }
};

const safeLen = (text) => {
  try {
    return Buffer.byteLength(String(text ?? ''), 'utf8');
  } catch (_) {
    return undefined;
  }
};


const sha256Hex = (buf) => {
  try {
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) {
    return undefined;
  }
};

const hasCRLF = (buf) => {
  if (!buf || buf.length < 2) return false;
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return true;
  }
  return false;
};

const escapeForLog = (s) => {
  // Make control chars visible and keep logs single-line for grep.
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/"/g, '\\"');
};

const bytesToHex = (buf) => Buffer.from(buf).toString('hex');

const splitBufferByNewlineKeepingDelim = (buf) => {
  // Split by LF (0x0a) and KEEP the LF in each chunk. CR (0x0d) remains if present.
  const out = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < buf.length) out.push(buf.slice(start));
  if (buf.length === 0) out.push(Buffer.alloc(0));
  return out;
};

const logProbeSummary = (kind, filepath, buf, extra) => {
  const payload = {
    probe: true,
    kind,
    filepath,
    bytes: buf?.length,
    sha256: sha256Hex(buf),
    has_crlf: hasCRLF(buf),
    ...(extra && typeof extra === 'object' ? extra : {}),
  };
  console.log(`PROBE_JSON ${safeStringify(payload)}`);
};

const logProbeWholeBufferAsLines = (kind, filepath, buf) => {
  const lines = splitBufferByNewlineKeepingDelim(buf);
  for (let i = 0; i < lines.length; i++) {
    const lineBuf = lines[i];
    const text = lineBuf.toString('utf8'); // best effort; hex is source of truth
    const escaped = escapeForLog(text);
    console.log(`PROBE kind=${kind} file=${filepath} line=${i + 1}: "${escaped}"`);
    console.log(`PROBE kind=${kind} file=${filepath} line=${i + 1} hex: ${bytesToHex(lineBuf)}`);
  }
};

// Remove (neutralize) Python comments and string literals before running
// interactive-input guardrails, to avoid false positives like "input()" inside
// docstrings/comments.
//
// Strategy:
// - Replace any character that is part of a comment or string with a space.
// - Preserve '\n' so regexes using /m still behave correctly and line numbers
//   remain aligned for debugging.
//
// This is a lightweight lexer, not a full Python parser, but it correctly
// handles:
// - single quotes: '...'
// - double quotes: "..."
// - triple quotes: '''...''' and """..."""
// - escapes inside non-triple strings
// - "#" comments (outside strings)
const neutralizePythonCommentsAndStrings = (text) => {
  const s = String(text ?? '');
  if (!s) return '';

  // State machine.
  const ST = {
    CODE: 0,
    COMMENT: 1,
    SQ: 2,       // '...'
    DQ: 3,       // "..."
    TSQ: 4,      // '''...'''
    TDQ: 5,      // """..."""
  };

  let st = ST.CODE;
  let out = '';
  let i = 0;
  let escape = false; // only for SQ/DQ (non-triple) strings

  const chAt = (idx) => (idx >= 0 && idx < s.length ? s[idx] : '');

  while (i < s.length) {
    const ch = s[i];

    // Always preserve newlines verbatim (even inside strings/comments).
    if (ch === '\n') {
      out += '\n';
      if (st === ST.COMMENT) st = ST.CODE;
      if (st === ST.SQ || st === ST.DQ) {
        // In Python, a literal newline ends a single-quoted string unless escaped,
        // but we don't need full correctness here; just keep state conservative.
        // If the LLM emitted an invalid unterminated string, staying "in string"
        // is safer (prevents false positives).
      }
      i++;
      escape = false;
      continue;
    }

    if (st === ST.CODE) {
      if (ch === '#') {
        st = ST.COMMENT;
        out += ' ';
        i++;
        continue;
      }

      // Triple quotes first
      if (ch === "'" && chAt(i + 1) === "'" && chAt(i + 2) === "'") {
        st = ST.TSQ;
        out += '   ';
        i += 3;
        continue;
      }
      if (ch === '"' && chAt(i + 1) === '"' && chAt(i + 2) === '"') {
        st = ST.TDQ;
        out += '   ';
        i += 3;
        continue;
      }

      if (ch === "'") {
        st = ST.SQ;
        out += ' ';
        i++;
        escape = false;
        continue;
      }
      if (ch === '"') {
        st = ST.DQ;
        out += ' ';
        i++;
        escape = false;
        continue;
      }

      // Normal code char
      out += ch;
      i++;
      continue;
    }

    if (st === ST.COMMENT) {
      // Neutralize comment chars (until newline handled above)
      out += ' ';
      i++;
      continue;
    }

    if (st === ST.SQ) {
      // Neutralize string chars
      out += ' ';
      if (escape) {
        escape = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        i++;
        continue;
      }
      if (ch === "'") {
        st = ST.CODE;
      }
      i++;
      continue;
    }

    if (st === ST.DQ) {
      out += ' ';
      if (escape) {
        escape = false;
        i++;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        i++;
        continue;
      }
      if (ch === '"') {
        st = ST.CODE;
      }
      i++;
      continue;
    }

    if (st === ST.TSQ) {
      // Triple-quoted strings: no escape handling needed for our purpose.
      // Close on the next ''' sequence.
      if (ch === "'" && chAt(i + 1) === "'" && chAt(i + 2) === "'") {
        out += '   ';
        i += 3;
        st = ST.CODE;
        continue;
      }
      out += ' ';
      i++;
      continue;
    }

    if (st === ST.TDQ) {
      if (ch === '"' && chAt(i + 1) === '"' && chAt(i + 2) === '"') {
        out += '   ';
        i += 3;
        st = ST.CODE;
        continue;
      }
      out += ' ';
      i++;
      continue;
    }

    // Fallback (should not happen)
    out += ' ';
    i++;
  }

  return out;
};



const detectForbiddenInteractivePython = (content) => {
  const text = String(content ?? '');
  // Avoid false positives in comments/docstrings: scan a neutralized view.
  const scanText = neutralizePythonCommentsAndStrings(text);
  const rules = [
    // Match builtin-like calls (avoid false positives such as "def test_valid_input():")
    // - (^|[^\w]) ensures "input" is not preceded by an identifier char (letters/digits/_)
    // - /m lets ^ match after newlines (start of line)
    { name: 'input()', regex: /(^|[^\w])input\s*\(/m },
    { name: 'sys.stdin', regex: /\bsys\.stdin\b/ },
    // Same rationale as input(): avoid matching identifiers ending with "readline"
    { name: 'readline()', regex: /(^|[^\w])readline\s*\(/m },
    { name: '.readline()', regex: /\.readline\s*\(/ },
  ];

  for (const rule of rules) {
    if (rule.regex.test(scanText)) return rule.name;
  }
  return null;
};


// Apply a unified diff to a text content.
// Supports typical "diff -u" output with one file and line-based hunks.
// Throws an Error with a diagnostic message if the patch cannot be applied.
const applyUnifiedDiff = (originalText, unifiedDiff) => {
  const diffText = String(unifiedDiff ?? '');
  const original = String(originalText ?? '');


  // Fuzzy patching parameters:
  // - First try to apply a hunk at the declared oldStart.
  // - If context/deletion lines mismatch, search for a unique match of the hunk's
  //   original-side lines (context + deletions) near the declared location, then globally.
  const FUZZY_WINDOW = 200; // lines around declared oldStart to search

  // Normalize original into lines (preserve whether it ended with \n)
  const originalEndsWithNewline = original.endsWith('\n');
  const originalLines = original.replace(/\r\n/g, '\n').split('\n');
  if (originalEndsWithNewline) {
    // split leaves a trailing "" after final newline; keep it (represents the newline)
  } else {
    // no trailing newline -> split returns last line without "", that's fine
  }

  const diffLines = diffText.replace(/\r\n/g, '\n').split('\n');

  // Basic validation: must contain at least one hunk header
  const hasHunk = diffLines.some(l => l.startsWith('@@ '));
  if (!hasHunk) {
    throw new Error('Invalid unified diff: no hunks found (missing "@@ ... @@").');
  }

  // Skip any leading headers (---/+++/index/etc.) until first hunk
  let i = 0;
  while (i < diffLines.length && !diffLines[i].startsWith('@@ ')) i++;

  const out = [];
  let srcIndex = 0; // 0-based index in originalLines

  const parseHunkHeader = (line) => {
    // @@ -l,s +l,s @@ optional
    const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!m) throw new Error(`Invalid hunk header: "${line}"`);
    const oldStart = parseInt(m[1], 10);
    const oldCount = m[2] ? parseInt(m[2], 10) : 1;
    const newStart = parseInt(m[3], 10);
    const newCount = m[4] ? parseInt(m[4], 10) : 1;
    return { oldStart, oldCount, newStart, newCount };
  };

  const safeLine = (l) => String(l ?? '');


  const buildHunkNeedle = (hunkLines) => {
    // Build the "original-side" sequence: context lines and deletion lines.
    // (Additions are not present in the original; ignore them for anchoring.)
    const needle = [];
    for (const line of hunkLines) {
      if (!line) continue;
      if (line === '\\ No newline at end of file') continue;
      const prefix = line[0];
      const payload = safeLine(line.slice(1));
      if (prefix === ' ' || prefix === '-') {
        needle.push(payload);
      }
    }
    return needle;
  };

  const findAllMatches = (haystackLines, needleLines, startIdx, endIdx) => {
    if (!needleLines.length) return [];
    const start = Math.max(0, startIdx);
    const end = Math.min(haystackLines.length, endIdx);
    const matches = [];
    for (let pos = start; pos + needleLines.length <= end; pos++) {
      let ok = true;
      for (let k = 0; k < needleLines.length; k++) {
        if (safeLine(haystackLines[pos + k]) !== needleLines[k]) {
          ok = false;
          break;
        }
      }
      if (ok) matches.push(pos);
    }
    return matches;
  };

  const formatCandidates = (cands) => cands.slice(0, 5).map((p) => p + 1).join(', ') + (cands.length > 5 ? ', ...' : '');

  const chooseFuzzyAnchor = (declaredIndex0, hunkLines) => {
    const needle = buildHunkNeedle(hunkLines);
    // If the needle is too short, fuzzy matching becomes unsafe/ambiguous.
    // Require at least 2 lines to avoid matching a very common single line like "def main():".
    if (needle.length < 2) return { ok: false, reason: `Insufficient hunk context for fuzzy matching (needle lines=${needle.length}).` };

    // 1) Search near the declared index
    const nearStart = declaredIndex0 - FUZZY_WINDOW;
    const nearEnd = declaredIndex0 + FUZZY_WINDOW + needle.length;
    const near = findAllMatches(originalLines, needle, nearStart, nearEnd);
    if (near.length === 1) return { ok: true, index: near[0], mode: 'near' };
    if (near.length > 1) {
      return { ok: false, reason: `Ambiguous fuzzy match near declared position. Candidates (1-based lines): ${formatCandidates(near)}.` };
    }

    // 2) Global search for a unique match
    const all = findAllMatches(originalLines, needle, 0, originalLines.length);
    if (all.length === 1) return { ok: true, index: all[0], mode: 'global' };
    if (all.length > 1) {
      return { ok: false, reason: `Ambiguous fuzzy match in file. Candidates (1-based lines): ${formatCandidates(all)}.` };
    }
    return { ok: false, reason: `No fuzzy match found for hunk context.` };
  };

  while (i < diffLines.length) {
    if (!diffLines[i].startsWith('@@ ')) {
      i++;
      continue;
    }

    const { oldStart } = parseHunkHeader(diffLines[i]);
    i++;

    // Gather hunk lines to support fuzzy anchoring if needed
    const hunkStartIdx = i;
    while (i < diffLines.length && !diffLines[i].startsWith('@@ ')) i++;
    const hunkLines = diffLines.slice(hunkStartIdx, i);

    // Copy unchanged lines up to hunk start (oldStart is 1-based).
    // First attempt: declared position. If it doesn't match, try fuzzy anchor.
    const declaredSrcIndex = Math.max(0, oldStart - 1);
    let targetSrcIndex = declaredSrcIndex;

    // If we've already consumed past the declared start due to earlier hunks,
    // treat the current srcIndex as the best approximation for "near" matching.
    const approxIndex = Math.max(srcIndex, declaredSrcIndex);

    // Quick strict check: compare first original-side line (if any) at declared position.
    const needlePreview = buildHunkNeedle(hunkLines);
    const strictOk =
      needlePreview.length === 0 ||
      safeLine(originalLines[declaredSrcIndex]) === needlePreview[0];

    if (!strictOk) {
      const chosen = chooseFuzzyAnchor(approxIndex, hunkLines);
      if (!chosen.ok) {
        throw new Error(
          `Patch context mismatch at source line ${declaredSrcIndex + 1}: expected "${needlePreview[0]}", got "${safeLine(originalLines[declaredSrcIndex])}". ` +
          `Fuzzy fallback failed: ${chosen.reason}`
        );
      }
      targetSrcIndex = chosen.index;
    }

    while (srcIndex < targetSrcIndex && srcIndex < originalLines.length) {
      out.push(originalLines[srcIndex]);
      srcIndex++;
    }

    // Apply hunk lines (captured in hunkLines) using strict line-by-line rules.
    // Note: At this point srcIndex is positioned at the chosen hunk anchor.
    for (let hi = 0; hi < hunkLines.length; hi++) {
      const line = hunkLines[hi];

      // Ignore "No newline" markers
      if (line === '\\ No newline at end of file') {
        continue;
      }

      const prefix = line[0];
      const payload = safeLine(line.slice(1));

      if (prefix === ' ') {
        // context: must match
        const srcLine = safeLine(originalLines[srcIndex]);
        if (srcLine !== payload) {
          throw new Error(
            `Patch context mismatch at source line ${srcIndex + 1}: expected "${payload}", got "${srcLine}".`
          );
        }
        out.push(srcLine);
        srcIndex++;
      } else if (prefix === '-') {
        // deletion: must match, but not output
        const srcLine = safeLine(originalLines[srcIndex]);
        if (srcLine !== payload) {
          throw new Error(
            `Patch deletion mismatch at source line ${srcIndex + 1}: expected "${payload}", got "${srcLine}".`
          );
        }
        srcIndex++;
      } else if (prefix === '+') {
        // addition
        out.push(payload);
      } else if (prefix === '' && line === '') {
        // diff trailing empty line (split artifact)
        out.push('');
      } else if (prefix === 'd' && line.startsWith('diff ')) {
        // tolerate accidental multi-file header
      } else if (prefix === '-' && line.startsWith('---')) {
        // header inside diff block (tolerate)
      } else if (prefix === '+' && line.startsWith('+++')) {
        // header inside diff block (tolerate)
      } else {
        // Unexpected line (could be "index ..." etc.) — ignore if outside hunks,
        // but here we're inside; fail loudly.
        throw new Error(`Unexpected diff line inside hunk: "${line}"`);
      }
    }
  }

  // Copy remaining source lines
  while (srcIndex < originalLines.length) {
    out.push(originalLines[srcIndex]);
    srcIndex++;
  }

  // Rebuild text. If original had trailing newline, preserve it.
  // (Note: out includes the trailing "" line if original ended with newline.)
  let patched = out.join('\n');
  return patched;
};

// Build line index helpers for reliable anchor matching (line-based, progressive disambiguation).
const normalizeTextToLF = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const buildLineStartOffsets = (textLF) => {
  // Returns array of char offsets where each line starts (0-based).
  // For N lines, offsets length is N.
  const starts = [0];
  for (let i = 0; i < textLF.length; i++) {
    if (textLF[i] === '\n') starts.push(i + 1);
  }
  // If text ends with '\n', last offset points to text.length (empty last line). Keep it.
  return starts;
};

const splitLinesNoDelim = (textLF) => textLF.split('\n');

const findAllSequenceMatches = (hayLines, needleLines, startLineInclusive, endLineExclusive) => {
  if (!Array.isArray(needleLines) || needleLines.length === 0) return [];
  const start = Math.max(0, startLineInclusive ?? 0);
  const end = Math.min(hayLines.length, endLineExclusive ?? hayLines.length);
  const out = [];
  for (let i = start; i + needleLines.length <= end; i++) {
    let ok = true;
    for (let k = 0; k < needleLines.length; k++) {
      if (String(hayLines[i + k] ?? '') !== String(needleLines[k] ?? '')) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
};

const progressiveUniqueMatchFromStart = (fileLines, codeLines, codeNonEmptyIdxs, fileStartLine) => {
  // Implements:
  // - Take 1st non-empty line; search.
  // - If multiple, take +2nd, +3rd, ... until unique or exhaustion.
  const idx0 = codeNonEmptyIdxs[0];
  let take = 1;
  while (take <= codeNonEmptyIdxs.length) {
    const needle = [];
    for (let t = 0; t < take; t++) needle.push(codeLines[codeNonEmptyIdxs[t]]);
    const matches = findAllSequenceMatches(fileLines, needle, fileStartLine, fileLines.length);
    if (matches.length === 1) return { ok: true, startLine: matches[0], needleLines: needle };
    if (matches.length === 0) return { ok: false, reason: 'start_not_found', needleLines: needle };
    take++;
  }
  return { ok: false, reason: 'start_ambiguous', needleLines: [codeLines[idx0]] };
};

const progressiveUniqueMatchFromEnd = (fileLines, codeLines, codeNonEmptyIdxs, fileStartLine) => {
  // Implements:
  // - Take last non-empty line; search after start.
  // - If multiple, take (prev + last), then (prev2 + prev + last), ... until unique.
  const idxLast = codeNonEmptyIdxs[codeNonEmptyIdxs.length - 1];
  let take = 1;
  while (take <= codeNonEmptyIdxs.length) {
    const needle = [];
    for (let t = take; t >= 1; t--) {
      needle.push(codeLines[codeNonEmptyIdxs[codeNonEmptyIdxs.length - t]]);
    }
    const matches = findAllSequenceMatches(fileLines, needle, fileStartLine, fileLines.length);
    if (matches.length === 1) return { ok: true, startLine: matches[0], needleLines: needle };
    if (matches.length === 0) return { ok: false, reason: 'end_not_found', needleLines: needle };
    take++;
  }
  return { ok: false, reason: 'end_ambiguous', needleLines: [codeLines[idxLast]] };
};

const write_code = async (action, uuid, user_id) => {
  let { path: filepath, content } = action.params;
  filepath = await restrictFilepath(filepath, user_id);

  // PROBE (optional): dump payload + on-disk bytes line-by-line with hex
  // Enable with: LEMON_PROBE_HEX_DUMP=1
  if (PROBE_HEX_DUMP) {
    try {
      const payloadBuf = Buffer.from(String(content ?? ''), 'utf8');
      logProbeSummary('write_code_payload', filepath, payloadBuf, { uuid });
      logProbeWholeBufferAsLines('write_code_payload', filepath, payloadBuf);
    } catch (err) {
      console.log(`PROBE kind=write_code_payload file=${filepath} error: "${escapeForLog(err?.message || String(err))}"`);
    }
  }

  // Guardrail: reject writing Python files that contain interactive stdin usage.
  if (typeof filepath === 'string' && filepath.toLowerCase().endsWith('.py')) {
    const matched = detectForbiddenInteractivePython(content);
    if (matched) {
      return {
        uuid,
        status: 'failure',
        content: '',
        error: `Refused to write Python file ${filepath}: interactive input is forbidden (matched: ${matched}).`,
        meta: {
          action_type: action.type,
          filepath
        }
      };
    }
  }
  
  // Log unified diff (stdout) if the file already exists on disk.
  // This is intended for docker logs only; it must not affect the action result payload.
  try {
    let oldText = null;
    try {
      oldText = await fs.readFile(filepath, 'utf-8');
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      oldText = null;
    }

    if (oldText != null) {
      const diffText = generateUnifiedDiff(filepath, oldText, content, 3);
      if (diffText) {
		// NOTE: stdout logs (docker logs)
        // Keep it greppable and clearly delimited in docker logs.
		console.log('');
        console.log(`WRITE_CODE_DIFF_BEGIN file=${filepath}`);
        console.log(diffText);
        console.log(`WRITE_CODE_DIFF_END file=${filepath}`);
      } else {
        // File existed but no textual diff detected after normalization: log diagnostics to confirm.
        const oldLF = normalizeToLF(oldText);
        const newLF = normalizeToLF(content);
		console.log('');
        console.log(
          `WRITE_CODE_NO_DIFF file=${filepath}` +
          ` old_bytes=${safeLen(oldText)} new_bytes=${safeLen(content)}` +
          ` old_sha256=${sha256TextHex(oldText)} new_sha256=${sha256TextHex(content)}` +
          ` oldLF_sha256=${sha256TextHex(oldLF)} newLF_sha256=${sha256TextHex(newLF)}`
        );
      }
    }
  } catch (err) {
    // Never block the write due to diff logging issues.
    console.log(`WRITE_CODE_DIFF_ERROR file=${filepath} error="${escapeForLog(err?.message || String(err))}"`);
  }


  // If file exists, log a unified diff between on-disk content and incoming content (stdout only).
  await write_file(filepath, content);
 
  if (PROBE_HEX_DUMP) {
    try {
      const fileBuf = await fs.readFile(filepath); // binary
      logProbeSummary('write_code_file_after', filepath, fileBuf, { uuid });
      logProbeWholeBufferAsLines('write_code_file_after', filepath, fileBuf);
    } catch (err) {
      console.log(`PROBE kind=write_code_file_after file=${filepath} error: "${escapeForLog(err?.message || String(err))}"`);
    }
  }
  
  // const result = await executeCode(filepath);
  // return result;
  return {
    uuid,
    status: 'success',
    content: `File ${filepath} written successfully.`,
    meta: {
      action_type: action.type,
      filepath
    }
  };
}

const patch_code = async (action, uuid, user_id) => {
  let { path: filepath, diff } = action.params;
  filepath = await restrictFilepath(filepath, user_id);

  let current;
  try {
    current = await fs.readFile(filepath, 'utf-8');
  } catch (err) {
    return {
      uuid,
      status: 'failure',
      content: '',
      error: `Cannot patch file ${filepath}: read failed (${err?.code || err?.message || err}).`,
      meta: {
        action_type: action.type,
        filepath,
        diff
      }
    };
  }

  let patched;
  try {
    patched = applyUnifiedDiff(current, diff);
  } catch (err) {
    return {
      uuid,
      status: 'failure',
      content: '',
      error: `Patch failed for ${filepath}: ${err?.message || String(err)}`,
      meta: {
        action_type: action.type,
        filepath,
        diff,
        // Provide current content to help the model recover (read_file retry logic).
        content: current
      }
    };
  }

  // Guardrail: reject writing Python files that contain interactive stdin usage.
  if (typeof filepath === 'string' && filepath.toLowerCase().endsWith('.py')) {
    const matched = detectForbiddenInteractivePython(patched);
    if (matched) {
      return {
        uuid,
        status: 'failure',
        content: '',
        error: `Refused to patch Python file ${filepath}: interactive input is forbidden (matched: ${matched}).`,
        meta: {
          action_type: action.type,
          filepath,
          diff,
          content: current
        }
      };
    }
  }

  await write_file(filepath, patched);

  return {
    uuid,
    status: 'success',
    content: `Patch applied successfully to ${filepath}.`,
    meta: {
      action_type: action.type,
      filepath,
      diff,
      content: patched
    }
  };
};

const replace_code_block = async (action, uuid, user_id) => {
  let { path: filepath, code_block } = action.params;
  filepath = await restrictFilepath(filepath, user_id);

  if (typeof code_block !== 'string' || code_block.trim().length === 0) {
    return {
      uuid,
      status: 'failure',
      content: '',
      error: `Cannot edit file ${filepath}: missing or empty code_block.`,
      meta: {
        action_type: action.type,
        filepath
      }
    };
  }

  // Probe: dump the payload code_block bytes exactly as received.
  if (PROBE_HEX_DUMP) {
    try {
      const payloadBuf = Buffer.from(String(code_block), 'utf8');
      logProbeSummary('replace_code_block_payload', filepath, payloadBuf, { uuid });
      logProbeWholeBufferAsLines('replace_code_block_payload', filepath, payloadBuf);
    } catch (err) {
      console.log(`PROBE kind=replace_code_block_payload file=${filepath} error: "${escapeForLog(err?.message || String(err))}"`);
    }
  }

  // Read current file content
  let fileText;
  try {
    fileText = await fs.readFile(filepath, 'utf-8');
  } catch (err) {
    return {
      uuid,
      status: 'failure',
      content: '',
      error: `Cannot edit file ${filepath}: read failed (${err?.code || err?.message || err}).`,
      meta: {
        action_type: action.type,
        filepath
      }
    };
  }

  // Probe: dump the exact bytes of the file as seen on disk at patch time.
  if (PROBE_HEX_DUMP) {
    try {
      const fileBuf = await fs.readFile(filepath);
      logProbeSummary('replace_code_block_file_before', filepath, fileBuf, { uuid });
      logProbeWholeBufferAsLines('replace_code_block_file_before', filepath, fileBuf);
    } catch (err) {
      console.log(`PROBE kind=replace_code_block_file_before file=${filepath} error: "${escapeForLog(err?.message || String(err))}"`);
    }
  }

  const blockLines = normalizeTextToLF(code_block).split('\n');

  // Collect indices of non-empty lines once (used for progressive disambiguation).
  const nonEmptyIdxs = [];
  for (let i = 0; i < blockLines.length; i++) {
    if (isNonEmptyLine(blockLines[i])) nonEmptyIdxs.push(i);
  }
  const firstIdx = nonEmptyIdxs.length ? nonEmptyIdxs[0] : -1;
  const lastIdx = nonEmptyIdxs.length ? nonEmptyIdxs[nonEmptyIdxs.length - 1] : -1;

  if (firstIdx === -1 || lastIdx === -1) {
    return {
      uuid,
      status: 'failure',
      content: '',
      error: `Cannot edit file ${filepath}: code_block is empty/blank.`,
      meta: {
        action_type: action.type,
        filepath
      }
    };
  }

  // Preserve leading indentation in anchors; only remove trailing spaces/tabs.
  const rstrip = (s) => String(s).replace(/[\t ]+$/g, '');
  for (let i = 0; i < nonEmptyIdxs.length; i++) blockLines[nonEmptyIdxs[i]] = rstrip(blockLines[nonEmptyIdxs[i]]);

  // Line-based progressive anchor resolution (prevents end-anchor picking the "first" occurrence).
  const fileLF = normalizeTextToLF(fileText);
  const fileLines = splitLinesNoDelim(fileLF);
  const lineStarts = buildLineStartOffsets(fileLF);

  // START anchor: progressively disambiguate using first non-empty lines from code_block.
  const startMatch = progressiveUniqueMatchFromStart(fileLines, blockLines, nonEmptyIdxs, 0);
  if (!startMatch.ok) {
    const anchorStartPreview = startMatch.needleLines?.[0] ?? '';
    const why =
      startMatch.reason === 'start_not_found'
        ? 'start anchor not found'
        : 'start anchor ambiguous (appears multiple times)';
    const msg =
      `Error: the patch could not be applied because the snippet does not match the current file content (${why}).\n` +
      `Fix: re-emit <replace_code_block> so that <code_block> starts with enough exact, unchanged lines copied from the current file to uniquely identify the location.\n\n` +
      `Here is the current source file (use it to build exact anchors):\n\n` +
      `${fileText}`;
    return {
      uuid,
      status: 'failure',
      content: msg,
      error: msg,
      meta: {
        action_type: action.type,
        filepath,
        anchorStart: anchorStartPreview,
        keyid: 'replace_code_block_anchor_not_found',
        anchor_kind: 'start',
        anchor_mode: startMatch.reason
      }
    };
  }

  const startLine = startMatch.startLine;
  const replaceStart = lineStarts[startLine] ?? 0;

  // END anchor: progressively disambiguate using last non-empty lines from code_block,
  // searching only after the resolved start anchor line.
  const endMatch = progressiveUniqueMatchFromEnd(fileLines, blockLines, nonEmptyIdxs, startLine);
  if (!endMatch.ok) {
    const anchorEndPreview = endMatch.needleLines?.[endMatch.needleLines.length - 1] ?? '';
    const why =
      endMatch.reason === 'end_not_found'
        ? 'end anchor not found after the start anchor'
        : 'end anchor ambiguous (appears multiple times after start anchor)';
    const msg =
      `Error: the patch could not be applied because the snippet does not match the current file content (${why}).\n` +
      `Fix: re-emit <replace_code_block> with enough exact unchanged lines at the END of <code_block> to uniquely identify the end location.\n\n` +
      `Here is the current source file (use it to build exact anchors):\n\n` +
      `${fileText}`;
    return {
      uuid,
      status: 'failure',
      content: msg,
      error: msg,
      meta: {
        action_type: action.type,
        filepath,
        anchorStart: startMatch.needleLines?.[0] ?? '',
        anchorEnd: anchorEndPreview,
        keyid: 'replace_code_block_anchor_not_found',
        anchor_kind: 'end',
        anchor_mode: endMatch.reason
      }
    };
  }
  
  // Keep legacy variable names used by existing meta/error paths.
  // (Some branches below still reference anchorStart/anchorEnd; without these,
  // a no-op path can throw ReferenceError.)
  const anchorStart = startMatch.needleLines?.[0] ?? '';
  const anchorEnd = endMatch.needleLines?.[endMatch.needleLines.length - 1] ?? '';

  const endStartLine = endMatch.startLine; // start line of the end-needle
  const endNeedleLen = endMatch.needleLines.length;
  const endLastLine = endStartLine + endNeedleLen - 1;
  const replaceEnd = (lineStarts[endLastLine + 1] != null) ? lineStarts[endLastLine + 1] : fileLF.length;


  const normalizedBlock = normalizeSnippet(code_block);
  // Note: replaceStart/replaceEnd are computed on LF-normalized file; slice original fileText
  // can diverge in indices if it contains CRLF. Use fileLF for snippet extraction to keep
  // indices consistent, then compare normalized snippets.
  const currentSnippet = normalizeSnippet(fileLF.slice(replaceStart, replaceEnd));

  // No-op detection:
  // If the proposed code_block does not introduce any change, treat it as a FAILURE.
  // This prevents the model from believing a fix was applied when nothing changed.
  if (normalizedBlock === currentSnippet) {
    const msg =
      `Error: the update could not be applied because it introduces no changes compared to the current file content.\n\n` +
      `Here is the current source file, which was not modified:\n\n` +
      `${fileText}`;
    return {
      uuid,
      status: 'failure',
      content: msg,
      // Keep error for downstream logging/debug, but content is what the LLM should see.
      error: msg,
      meta: {
        action_type: action.type,
        filepath,
        no_op: true,
        keyid: 'replace_code_block_noop',
        anchorStart,
        anchorEnd
      }
    };
  }

  // Apply patch on LF-normalized content. If the original file had CRLF, we keep writing LF
  // (the rest of this tool already normalizes; probes make this visible). This avoids index drift.
  const patchedLF = fileLF.slice(0, replaceStart) + normalizedBlock + fileLF.slice(replaceEnd);
  const patched = patchedLF;

  // Guardrail: reject writing Python files that contain interactive stdin usage.
  if (typeof filepath === 'string' && filepath.toLowerCase().endsWith('.py')) {
    const matched = detectForbiddenInteractivePython(patched);
    if (matched) {
      return {
        uuid,
        status: 'failure',
        content: '',
        error: `Refused to edit Python file ${filepath}: interactive input is forbidden (matched: ${matched}).`,
        meta: {
          action_type: action.type,
          filepath,
          content: fileText
        }
      };
    }
  }

  await write_file(filepath, patched);

  // Probe: dump file after write to confirm exact bytes.
  if (PROBE_HEX_DUMP) {
    try {
      const fileBufAfter = await fs.readFile(filepath);
      logProbeSummary('replace_code_block_file_after', filepath, fileBufAfter, { uuid });
      logProbeWholeBufferAsLines('replace_code_block_file_after', filepath, fileBufAfter);
    } catch (err) {
      console.log(`PROBE kind=replace_code_block_file_after file=${filepath} error: "${escapeForLog(err?.message || String(err))}"`);
    }
  }

  return {
    uuid,
    status: 'success',
    content: `Code block replaced successfully in ${filepath}.`,
    meta: {
      action_type: action.type,
      filepath,
      code_block: normalizedBlock,
      anchorStart,
      anchorEnd,
      anchor_start_lines: startMatch.needleLines?.length,
      anchor_end_lines: endMatch.needleLines?.length,
      anchor_start_line_in_file: startLine + 1,
      anchor_end_line_in_file: (endLastLine + 1)
    }
  };
};


module.exports = {
  write_code,
  patch_code,
  replace_code_block
};