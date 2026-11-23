// mend — one patch tool for every AI edit format.
//
// Models write the same edit four different ways: a unified diff (often with wrong line numbers), a
// SEARCH/REPLACE block, a V4A patch, or a JSON list of text-editor tool calls. mend reads any of them,
// finds the lines each edit names — exactly, or with drifted trailing whitespace, or with drifted
// indentation — and applies every edit or none of them, printing what changed or why each edit failed.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// PATCH is a file in the working directory, or standard input when it is absent or "-". The working
// directory is the root of the tree being patched; every path in a patch is relative to it. --check
// reports without writing; --strict turns off the two forgiving matching tiers. SPEC.md is the contract
// this file implements, section by section.
//
// In a trial the grader runs this file with MAKEFUN_ENV_URL set; the last lines then hand over to
// runner.ts, which drives this same CLI over the trial's checks. Node 22, standard library only.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** A problem with the invocation or the patch itself: exit 2, this one line on stdout. */
class Fatal extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** A single edit failed: a failure code and the path the failure concerns. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

function fail(code: string, path: string): never {
  throw new EditFail(code, path);
}

/* ------------------------------------------------------------------ */
/* Text and files (SPEC section 3)                                     */
/* ------------------------------------------------------------------ */

const isBlank = (s: string): boolean => s.trim() === '';

/** The patch as lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

/** A path is safe when it is relative, uses '/' only, and no segment is empty, '.' or '..'. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!isSafePath(p)) fail('unsafe', p);
}

/**
 * A text file as mend works on it: its lines, the line break it uses, and whether it ends with one.
 * The break is CRLF when the file's first line feed follows a carriage return, LF otherwise.
 */
interface TextFile {
  lines: string[];
  brk: '\n' | '\r\n';
  tail: boolean;
}

function parseText(text: string): TextFile {
  if (text === '') return { lines: [], brk: '\n', tail: false };
  const firstFeed = text.indexOf('\n');
  const brk: '\n' | '\r\n' = firstFeed > 0 && text[firstFeed - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let tail = false;
  if (text.endsWith(brk)) {
    tail = true;
    parts.pop();
  }
  return { lines: parts, brk, tail };
}

function emitText(file: TextFile): string {
  if (file.lines.length === 0) return '';
  return file.lines.join(file.brk) + (file.tail ? file.brk : '');
}

/* ------------------------------------------------------------------ */
/* The staged tree                                                     */
/* ------------------------------------------------------------------ */

/**
 * The tree as the edits leave it. Original contents are read from disk on first use; an edit stages
 * its result (a string, or null for a deleted file) and later edits see the staged state. Because a
 * failed edit must change nothing, the caller snapshots `staged` before each edit and restores it
 * when the edit throws.
 */
class Tree {
  private base = new Map<string, string | null>();
  staged = new Map<string, string | null>();

  /** The file's content before the patch, or null when it does not exist. */
  before(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p) ?? null;
  }

  /** The file's content as earlier edits left it. */
  now(p: string): string | null {
    return this.staged.has(p) ? (this.staged.get(p) ?? null) : this.before(p);
  }

  set(p: string, v: string | null): void {
    this.staged.set(p, v);
  }
}

/** What an edit runs with: the strict flag, and where successful moves are recorded for the report. */
interface EditCtx {
  strict: boolean;
  moves: Array<[string, string]>;
}

type Edit = (tree: Tree, ctx: EditCtx) => void;

/* ------------------------------------------------------------------ */
/* Matching lines at three tiers (SPEC section 5)                      */
/* ------------------------------------------------------------------ */

type Tier = 0 | 1 | 2;
const ALL_TIERS: Tier[] = [0, 1, 2];

/** A line as a tier sees it: exact, minus trailing blanks, or minus blanks at both ends. */
function tierView(s: string, tier: Tier): string {
  if (tier === 0) return s;
  const noTail = s.replace(/[ \t]+$/, '');
  return tier === 1 ? noTail : noTail.replace(/^[ \t]+/, '');
}

interface Occurrence {
  tier: Tier;
  at: number[];
}

/**
 * Every position at or after `from` where `old` matches `lines`, at the first tier that has any.
 * Positions may overlap. With `mustEnd`, only positions whose match ends on the last line count.
 * Returns null when no tier matches anywhere.
 */
function findOccurrences(
  lines: string[],
  old: string[],
  strict: boolean,
  from: number,
  mustEnd = false,
): Occurrence | null {
  for (const tier of strict ? [0 as Tier] : ALL_TIERS) {
    const want = old.map((l) => tierView(l, tier));
    const at: number[] = [];
    for (let i = from; i + old.length <= lines.length; i++) {
      if (mustEnd && i + old.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < old.length; j++) {
        if (tierView(lines[i + j], tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

const leadingBlanks = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/**
 * The lines that replace a match for a plain old-to-new replacement (SEARCH/REPLACE blocks): at
 * tier 2 each new line that starts with the old text's indentation gets the file's own instead.
 */
function reindent(newLines: string[], fileFirst: string, oldFirst: string, tier: Tier): string[] {
  if (tier !== 2) return [...newLines];
  const f = leadingBlanks(fileFirst);
  const p = leadingBlanks(oldFirst);
  return newLines.map((t) => {
    if (/^[ \t]*$/.test(t) || !t.startsWith(p)) return t;
    return f + t.slice(p.length);
  });
}

/**
 * One line of a hunk or chunk body: context (in both the old and the new text), a removed line, an
 * added line, or a "\" marker about the line before it. `raw` is the patch line it came from, so a
 * context line made from a truly empty patch line can be told from one made from a single space.
 */
interface Piece {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  raw: string;
}

const pieceOldLines = (pieces: Piece[]): string[] =>
  pieces.filter((p) => p.kind === 'ctx' || p.kind === 'del').map((p) => p.text);

/**
 * Build the replacement for a matched hunk or chunk: context lines come out as the file's own
 * matched lines, removed lines vanish, added lines are written as they are — re-indented at tier 2.
 */
function buildReplacement(lines: string[], pos: number, pieces: Piece[], tier: Tier, oldFirst: string): string[] {
  const out: string[] = [];
  const adds = pieces.filter((p) => p.kind === 'add').map((p) => p.text);
  const fixed = tier === 2 ? reindent(adds, lines[pos], oldFirst, tier) : adds;
  let oi = 0;
  let ai = 0;
  for (const p of pieces) {
    if (p.kind === 'ctx') {
      out.push(lines[pos + oi]);
      oi += 1;
    } else if (p.kind === 'del') {
      oi += 1;
    } else if (p.kind === 'add') {
      out.push(fixed[ai]);
      ai += 1;
    }
  }
  return out;
}

/** Whether a "\" line follows the hunk's last context or added line (the no-final-break marker). */
function backslashAfterLastWrite(pieces: Piece[]): boolean {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const k = pieces[i].kind;
    if (k === 'ctx' || k === 'add') {
      return i + 1 < pieces.length && pieces[i + 1].kind === 'bs';
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object as an Edit, or null when it is not a valid one. */
function jsonEditOf(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.now(p) !== null) fail('exists', p);
      tree.set(p, text); // a create writes file_text byte for byte
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      needSafe(p);
      const before = tree.now(p);
      if (before === null) fail('missing', p);
      // In a CRLF file the text and both strings are read with \n line feeds and written back with \r\n.
      const feed = before.indexOf('\n');
      const crlf = feed > 0 && before[feed - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = norm(before);
      const needle = norm(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count += 1;
      if (count === 0) fail('no-match', p);
      if (count > 1) fail('ambiguous', p);
      const at = text.indexOf(needle);
      const out = text.slice(0, at) + norm(newStr) + text.slice(at + needle.length);
      tree.set(p, crlf ? out.split('\n').join('\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const added = patchLines(o.new_str);
    return (tree) => {
      needSafe(p);
      const before = tree.now(p);
      if (before === null) fail('missing', p);
      const file = parseText(before);
      if (line < 0 || line > file.lines.length) fail('no-match', p);
      file.lines.splice(line, 0, ...added);
      tree.set(p, emitText(file)); // the file's break and final break stay as they were
    };
  }

  return null;
}

/** The JSON reader: one array of edit objects, or JSON Lines with one object a line. */
function readJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Fatal('error: parse 1');
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Fatal(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Fatal(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const item of v) {
      const e = jsonEditOf(item);
      if (e === null) throw new Fatal(`error: parse ${first + 1}`); // in array form every fault is at the array's line
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEditOf(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Fatal(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface Hunk {
  start: number; // the A of @@ -A[,B] +C[,D] @@
  pieces: Piece[];
}

interface Section {
  fromDiff: [string, string] | null;
  headOld: string | null | undefined; // undefined: unnamed; null: /dev/null
  headNew: string | null | undefined;
  renFrom: string | undefined;
  renTo: string | undefined;
  makeNew: boolean;
  makeDel: boolean;
  hunks: Hunk[];
}

/** The path a --- or +++ line names: after the four characters, up to a tab, trimmed; /dev/null is null. */
function headerPath(raw: string): string | null {
  let t = raw.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Apply a section's hunks, in order, to a parsed file. Throws EditFail when a hunk finds no match. */
function applyHunks(file: TextFile, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0; // the running line drift from this section's earlier hunks
  for (const h of hunks) {
    const old = pieceOldLines(h.pieces);
    const newCount = h.pieces.filter((p) => p.kind === 'ctx' || p.kind === 'add').length;
    if (old.length === 0) {
      const at = Math.max(0, Math.min(h.start + d, file.lines.length));
      const atEnd = at === file.lines.length;
      const texts = h.pieces.filter((p) => p.kind === 'add').map((p) => p.text);
      file.lines.splice(at, 0, ...texts);
      if (atEnd) file.tail = !backslashAfterLastWrite(h.pieces);
    } else {
      const occ = findOccurrences(file.lines, old, strict, 0);
      if (occ === null) fail('no-match', path);
      const target = h.start - 1 + d;
      let pos = occ.at[0];
      let best = Math.abs(pos - target);
      for (const cand of occ.at) {
        const dist = Math.abs(cand - target);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const toEnd = pos + old.length === file.lines.length;
      const repl = buildReplacement(file.lines, pos, h.pieces, occ.tier, old[0]);
      file.lines.splice(pos, old.length, ...repl);
      if (toEnd) file.tail = !backslashAfterLastWrite(h.pieces);
    }
    d += newCount - old.length;
  }
}

/** Turn one parsed section into the edit it describes: a creation, a deletion, a move or a change. */
function sectionEdit(sec: Section): Edit {
  const oldPath =
    sec.headOld !== undefined ? sec.headOld : sec.renFrom !== undefined ? sec.renFrom : sec.fromDiff !== null ? sec.fromDiff[0] : '';
  const newPath =
    sec.headNew !== undefined ? sec.headNew : sec.renTo !== undefined ? sec.renTo : sec.fromDiff !== null ? sec.fromDiff[1] : '';
  return (tree, ctx) => {
    if (oldPath === null || sec.makeNew) {
      const p = newPath ?? '';
      needSafe(p);
      if (tree.now(p) !== null) fail('exists', p);
      const all = sec.hunks.flatMap((h) => h.pieces);
      const added: string[] = [];
      let lastAdd = -1;
      all.forEach((pc, ix) => {
        if (pc.kind === 'add') {
          lastAdd = ix;
          added.push(pc.text);
        }
      });
      const noBreak = lastAdd >= 0 && lastAdd + 1 < all.length && all[lastAdd + 1].kind === 'bs';
      tree.set(p, emitText({ lines: added, brk: '\n', tail: !noBreak }));
      return;
    }
    if (newPath === null || sec.makeDel) {
      const p = oldPath ?? '';
      needSafe(p);
      if (tree.now(p) === null) fail('missing', p);
      tree.set(p, null);
      return;
    }
    const from = oldPath ?? '';
    const to = newPath ?? '';
    needSafe(from);
    needSafe(to);
    const before = tree.now(from);
    if (before === null) fail('missing', from);
    if (to !== from && tree.now(to) !== null) fail('exists', to);
    const file = parseText(before);
    applyHunks(file, sec.hunks, from, ctx.strict);
    if (to !== from) {
      tree.set(to, emitText(file));
      tree.set(from, null);
      ctx.moves.push([from, to]);
    } else {
      tree.set(from, emitText(file));
    }
  };
}

/** Read a unified diff: sections of headers and hunks, with prose and fences around them ignored. */
function readUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;

  const endHunk = (): void => {
    if (hunk === null || sec === null) return;
    // Empty lines at the end of a body are not part of it: a context line whose text is empty,
    // whether the patch line was empty or a single space.
    while (hunk.pieces.length > 0) {
      const last = hunk.pieces[hunk.pieces.length - 1];
      if (last.kind === 'ctx' && last.text === '') hunk.pieces.pop();
      else break;
    }
    sec.hunks.push(hunk);
    hunk = null;
  };

  const newSection = (): void => {
    endHunk();
    sec = {
      fromDiff: null,
      headOld: undefined,
      headNew: undefined,
      renFrom: undefined,
      renTo: undefined,
      makeNew: false,
      makeDel: false,
      hunks: [],
    };
    sections.push(sec);
    inHeader = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const num = i + 1;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Fatal(`error: parse ${num}`);
      newSection();
      sec!.fromDiff = [m[1], m[2]];
      continue;
    }

    const pairStart = line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
    if (pairStart) {
      // A ---/+++ pair opens a new section, unless it is the header pair of the section just opened.
      if (hunk !== null || sec === null || !inHeader || sec.headOld !== undefined) newSection();
      sec!.headOld = headerPath(line);
      sec!.headNew = headerPath(lines[i + 1]);
      i += 1; // the +++ line is consumed with it
      continue;
    }

    if (hunk !== null) {
      const c = line[0];
      if (line === '') {
        hunk.pieces.push({ kind: 'ctx', text: '', raw: '' });
        continue;
      }
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        const kind = c === ' ' ? 'ctx' : c === '-' ? 'del' : c === '+' ? 'add' : 'bs';
        hunk.pieces.push({ kind, text: kind === 'bs' ? '' : line.slice(1), raw: line });
        continue;
      }
      endHunk(); // the line ends the body and is read again below
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new Fatal(`error: parse ${num}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: .*)?$/.exec(line);
      if (m === null) throw new Fatal(`error: parse ${num}`);
      hunk = { start: parseInt(m[1], 10), pieces: [] };
      inHeader = false;
      continue;
    }

    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Fatal(`error: parse ${num + 1}`); // a --- with no +++ after it
      if (line.startsWith('+++ ')) {
        sec.headNew = headerPath(line);
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renFrom = line.slice('rename from '.length).trim();
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renTo = line.slice('rename to '.length).trim();
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.makeNew = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.makeDel = true;
        continue;
      }
      continue; // index, mode and every other header line are ignored
    }
    // Anything else is prose around the patch and is ignored.
  }
  endHunk();
  if (sections.length === 0) throw new Fatal('error: parse 1');
  return sections.map(sectionEdit);
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Read SEARCH/REPLACE blocks; each block's path is the nearest plain line before its SEARCH marker. */
function readSearchReplace(lines: string[]): Edit[] {
  const blocks: Block[] = [];
  let prevEnd = 0; // the line after the previous block's REPLACE marker
  let lastPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNum = i + 1;
    let path: string | undefined;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === undefined) path = lastPath;
    if (path === undefined) throw new Fatal(`error: parse ${searchNum}`);

    let k = i + 1;
    const oldLines: string[] = [];
    while (k < lines.length && lines[k].trimEnd() !== '=======') {
      oldLines.push(lines[k]);
      k += 1;
    }
    if (k >= lines.length) throw new Fatal(`error: parse ${searchNum}`);
    k += 1;
    const newLines: string[] = [];
    while (k < lines.length && lines[k].trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]);
      k += 1;
    }
    if (k >= lines.length) throw new Fatal(`error: parse ${searchNum}`);

    blocks.push({ path, oldLines, newLines });
    lastPath = path;
    prevEnd = k + 1;
    i = k + 1;
  }
  if (blocks.length === 0) throw new Fatal('error: parse 1');
  return blocks.map((b) => (tree, ctx) => {
    needSafe(b.path);
    const cur = tree.now(b.path);
    if (b.oldLines.length === 0) {
      // An empty old text creates the file with the new lines.
      if (cur !== null) fail('exists', b.path);
      tree.set(b.path, emitText({ lines: [...b.newLines], brk: '\n', tail: true }));
      return;
    }
    if (cur === null) fail('missing', b.path);
    const file = parseText(cur);
    const occ = findOccurrences(file.lines, b.oldLines, ctx.strict, 0);
    if (occ === null) fail('no-match', b.path);
    if (occ.at.length > 1) fail('ambiguous', b.path);
    const pos = occ.at[0];
    const repl = reindent(b.newLines, file.lines[pos], b.oldLines[0], occ.tier);
    file.lines.splice(pos, b.oldLines.length, ...repl);
    tree.set(b.path, emitText(file));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface RawSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  headNum: number;
  body: Array<{ line: string; num: number }>;
}

interface Chunk {
  anchor: string | null;
  eof: boolean;
  pieces: Piece[];
}

/** Turn one raw V4A section into its edit, parsing its body on the way. */
function v4aEdit(rs: RawSection): Edit {
  // Blank lines at the end of a section are not part of it (a blank line is empty or only whitespace).
  const body = [...rs.body];
  while (body.length > 0 && body[body.length - 1].line.trim() === '') body.pop();

  if (rs.kind === 'add') {
    const content: string[] = [];
    for (const { line, num } of body) {
      if (line.startsWith('+')) content.push(line.slice(1));
      else if (line === '') content.push('');
      else throw new Fatal(`error: parse ${num}`);
    }
    return (tree) => {
      needSafe(rs.path);
      if (tree.now(rs.path) !== null) fail('exists', rs.path);
      tree.set(rs.path, emitText({ lines: content, brk: '\n', tail: true }));
    };
  }

  if (rs.kind === 'del') {
    if (body.length > 0) throw new Fatal(`error: parse ${body[0].num}`);
    return (tree) => {
      needSafe(rs.path);
      if (tree.now(rs.path) === null) fail('missing', rs.path);
      tree.set(rs.path, null);
    };
  }

  // An Update File section: an optional Move to as its first line, then chunks.
  let moveTo: string | undefined;
  let rest = body;
  const firstReal = body.findIndex((e) => e.line !== '');
  if (firstReal >= 0 && body[firstReal].line.startsWith('*** Move to:')) {
    moveTo = body[firstReal].line.slice('*** Move to:'.length).trim();
    rest = body.slice(firstReal + 1);
  }
  const chunks: Chunk[] = [];
  let chunk: Chunk | null = null;
  let afterEof = false;
  for (const { line, num } of rest) {
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, pieces: [] };
      chunks.push(chunk);
      afterEof = false;
      continue;
    }
    if (!line.startsWith(' ') && line.trimEnd() === '*** End of File') {
      if (chunk === null) {
        chunk = { anchor: null, eof: true, pieces: [] };
        chunks.push(chunk);
      } else {
        chunk.eof = true;
      }
      chunk = null;
      afterEof = true;
      continue;
    }
    if (line.startsWith('*** Move to:')) throw new Fatal(`error: parse ${num}`);
    const c = line[0];
    if (line === '' || c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        // Only the first chunk of a section may start at a body line.
        if (chunks.length > 0 || afterEof) throw new Fatal(`error: parse ${num}`);
        chunk = { anchor: null, eof: false, pieces: [] };
        chunks.push(chunk);
      }
      if (line === '') chunk.pieces.push({ kind: 'ctx', text: '', raw: '' });
      else if (c === ' ') chunk.pieces.push({ kind: 'ctx', text: line.slice(1), raw: line });
      else if (c === '-') chunk.pieces.push({ kind: 'del', text: line.slice(1), raw: line });
      else chunk.pieces.push({ kind: 'add', text: line.slice(1), raw: line });
      continue;
    }
    throw new Fatal(`error: parse ${num}`);
  }
  if (chunks.length === 0 && moveTo === undefined) throw new Fatal(`error: parse ${rs.headNum}`);

  return (tree, ctx) => {
    needSafe(rs.path);
    if (moveTo !== undefined) needSafe(moveTo);
    const cur = tree.now(rs.path);
    if (cur === null) fail('missing', rs.path);
    if (moveTo !== undefined && tree.now(moveTo) !== null) fail('exists', moveTo);
    const file = parseText(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // The anchor is found at or after the cursor, at the first tier where a line equals it.
        let found = -1;
        for (const tier of ctx.strict ? [0 as Tier] : ALL_TIERS) {
          for (let i = cursor; i < file.lines.length; i++) {
            if (tierView(file.lines[i], tier) === tierView(ch.anchor, tier)) {
              found = i;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) fail('no-match', rs.path);
        cursor = found + 1;
      }
      const old = pieceOldLines(ch.pieces);
      if (old.length === 0) {
        const at = ch.eof ? file.lines.length : Math.min(cursor, file.lines.length);
        const texts = ch.pieces.filter((p) => p.kind === 'add').map((p) => p.text);
        file.lines.splice(at, 0, ...texts);
        cursor = at + texts.length;
      } else {
        const occ = findOccurrences(file.lines, old, ctx.strict, cursor, ch.eof);
        if (occ === null) fail('no-match', rs.path);
        const pos = occ.at[0];
        const repl = buildReplacement(file.lines, pos, ch.pieces, occ.tier, old[0]);
        file.lines.splice(pos, old.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    if (moveTo !== undefined) {
      tree.set(moveTo, emitText(file));
      tree.set(rs.path, null);
      ctx.moves.push([rs.path, moveTo]);
    } else {
      tree.set(rs.path, emitText(file));
    }
  };
}

/** Read a V4A patch: its sections between the Begin and End markers. */
function readV4a(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Fatal('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Fatal(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Fatal(`error: parse ${lines.length + 1}`);

  const starts: Array<[string, RawSection['kind']]> = [
    ['*** Add File:', 'add'],
    ['*** Delete File:', 'del'],
    ['*** Update File:', 'upd'],
  ];
  const rawSecs: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i];
    let started = false;
    for (const [prefix, kind] of starts) {
      if (line.startsWith(prefix)) {
        cur = { kind, path: line.slice(prefix.length).trim(), headNum: i + 1, body: [] };
        rawSecs.push(cur);
        started = true;
        break;
      }
    }
    if (started) continue;
    if (cur === null) {
      if (isBlank(line)) continue; // blank lines between sections are ignored
      throw new Fatal(`error: parse ${i + 1}`);
    }
    cur.body.push({ line, num: i + 1 });
  }
  if (rawSecs.length === 0) throw new Fatal('error: parse 1');
  return rawSecs.map(v4aEdit);
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The command line (SPEC sections 1, 2 and 10)                        */
/* ------------------------------------------------------------------ */

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let pastDashDash = false;
  for (const a of args) {
    if (!pastDashDash && a === '--') {
      pastDashDash = true;
      continue;
    }
    if (!pastDashDash && a.length > 1 && a.startsWith('-')) {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
        continue;
      }
      if (a === '--check' && !checkOnly) {
        checkOnly = true;
        continue;
      }
      if (a === '--strict' && !strict) {
        strict = true;
        continue;
      }
      return { code: 2, out: ['error: usage'] };
    }
    positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };

  const patchArg = positional.length === 0 ? null : positional[0];
  let text: string;
  if (patchArg === null || patchArg === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    edits =
      kind === 'unified'
        ? readUnified(lines)
        : kind === 'search-replace'
          ? readSearchReplace(lines)
          : kind === 'v4a'
            ? readV4a(lines)
            : readJsonEdits(text, lines);
  } catch (e) {
    if (e instanceof Fatal) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };

  // Edits apply in the patch's order, each to the tree as the earlier ones left it; a failed edit
  // changes nothing and the ones after it still run, so every failure is reported.
  const tree = new Tree();
  const ctx: EditCtx = { strict, moves: [] };
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.staged);
    const moveCount = ctx.moves.length;
    try {
      edit(tree, ctx);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.staged = snapshot;
      ctx.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  // What changed, in byte order of the paths; a successful move is one R line in place of its D and A.
  const rows: Array<{ key: string; text: string }> = [];
  const used = new Set<string>();
  for (const [from, to] of ctx.moves) {
    if (used.has(from) || used.has(to)) continue;
    if (tree.before(from) !== null && tree.now(from) === null && tree.before(to) === null && tree.now(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      used.add(from);
      used.add(to);
    }
  }
  for (const p of tree.staged.keys()) {
    if (used.has(p)) continue;
    const was = tree.before(p);
    const is = tree.now(p);
    if (was === is) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : is === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  if (!checkOnly) {
    for (const p of tree.staged.keys()) {
      const was = tree.before(p);
      const is = tree.now(p);
      if (was === is) continue;
      if (is === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, is);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

/* ------------------------------------------------------------------ */
/* Entry: a trial hands over to the runner; anything else is the CLI.  */
/* ------------------------------------------------------------------ */

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
