// mend: a patch tool that applies AI-written edits to a tree of text files.
//
// Implements SPEC.md version 1: unified diffs (with wrong line numbers),
// SEARCH/REPLACE blocks, V4A patches and JSON tool-call edits, with
// three-tier line matching, CRLF/LF preservation, path safety and
// all-or-nothing writes. Node 22, standard library only.
// Run: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/* ------------------------------------------------------------------ */
/* Files as lines (SPEC section 3)                                     */
/* ------------------------------------------------------------------ */

interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

/** Split a file's text at its own line break; the last empty piece after a final break is not a line. */
function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Matching lines (SPEC section 5)                                     */
/* ------------------------------------------------------------------ */

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0];
const isOnlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** 0-based positions where O occurs in lines at the tier, searching from `from`; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

const tiersFor = (strict: boolean): number[] => (strict ? [0] : [0, 1, 2]);

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NPart {
  text: string;
  ctx: number | null;
}

/**
 * Build the lines that replace O at position `pos`. Context lines are written as the file's own
 * matched lines; at tier 2 every other non-blank line starting with O's first line indent P
 * has that P replaced by the file's first matched line indent F.
 */
function buildReplacement(fileLines: string[], o: string[], n: NPart[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const pLead = o.length > 0 ? leadingWs(o[0]!) : '';
  const fLead = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  for (const part of n) {
    if (part.ctx !== null) {
      out.push(fileLines[pos + part.ctx]!);
      continue;
    }
    let t = part.text;
    if (tier === 2 && t !== '' && !isOnlyWs(t) && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
    out.push(t);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC section 4)                                   */
/* ------------------------------------------------------------------ */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC section 9)                                         */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC section 6)                                      */
/* ------------------------------------------------------------------ */

interface UBodyLine {
  kind: ' ' | '-' | '+' | '\\' | '';
  text: string;
}

interface Hunk {
  a: number;
  o: string[];
  n: NPart[];
  /** a `\` line follows the hunk's last context or `+` line */
  noBreak: boolean;
  /** a `\` line follows the hunk's last `+` line (for created files) */
  lastPlusNoBreak: boolean;
  hasPlus: boolean;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  slashOld: string | null;
  slashNew: string | null;
  /** a ---/+++ pair was present and named /dev/null on that side (null that must not fall through) */
  slashOldNull: boolean;
  slashNewNull: boolean;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
  /** a `\` line follows the section's last `+` line */
  createNoBreak: boolean;
}

/** Path after `--- ` / `+++ `: text after four chars, up to the first tab, trimmed, a/ or b/ removed; /dev/null is null. */
function diffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const fresh = (): USection => ({
    diffOld: null,
    diffNew: null,
    slashOld: null,
    slashNew: null,
    slashOldNull: false,
    slashNewNull: false,
    renOld: null,
    renNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
    createNoBreak: false,
  });
  const finish = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
    inHeader = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = diffPath(line);
      const newP = diffPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.slashOld = oldP;
        cur.slashNew = newP;
        cur.slashOldNull = oldP === null;
        cur.slashNewNull = newP === null;
      } else {
        finish();
        cur = fresh();
        cur.slashOld = oldP;
        cur.slashNew = newP;
        cur.slashOldNull = oldP === null;
        cur.slashNewNull = newP === null;
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: |$)/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: UBodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: '', text: '' });
          i++;
        } else if (bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          body.push({ kind: bl[0] as UBodyLine['kind'], text: bl.slice(1) });
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1]!.kind === '') body.pop();
      const o: string[] = [];
      const n: NPart[] = [];
      for (const b of body) {
        if (b.kind === ' ' || b.kind === '') {
          o.push(b.text);
          n.push({ text: b.text, ctx: o.length - 1 });
        } else if (b.kind === '-') o.push(b.text);
        else if (b.kind === '+') n.push({ text: b.text, ctx: null });
      }
      let noBreak = false;
      for (let k = body.length - 1; k >= 0; k--) {
        const b = body[k]!;
        if (b.kind === ' ' || b.kind === '' || b.kind === '+') {
          noBreak = k + 1 < body.length && body[k + 1]!.kind === '\\';
          break;
        }
      }
      let lastPlusNoBreak = false;
      let hasPlus = false;
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k]!.kind === '+') {
          hasPlus = true;
          lastPlusNoBreak = k + 1 < body.length && body[k + 1]!.kind === '\\';
          break;
        }
      }
      cur.hunks.push({ a, o, n, noBreak, lastPlusNoBreak, hasPlus });
      if (hasPlus) cur.createNoBreak = lastPlusNoBreak;
      inHeader = false;
      continue;
    }
    if (line.startsWith('rename from ')) {
      if (cur !== null && inHeader) cur.renOld = line.slice(12).trim();
      i++;
      continue;
    }
    if (line.startsWith('rename to ')) {
      if (cur !== null && inHeader) cur.renNew = line.slice(10).trim();
      i++;
      continue;
    }
    if (line.startsWith('new file mode')) {
      if (cur !== null && inHeader) cur.newFile = true;
      i++;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (cur !== null && inHeader) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  finish();
  return sections;
}

/** Apply one hunk to the model; d is the net line growth of this section's earlier hunks. */
function applyHunk(model: FileModel, h: Hunk, d: number, strict: boolean, path: string): FileModel {
  if (h.o.length > 0) {
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiersFor(strict)) {
      const found = occurrences(model.lines, h.o, t);
      if (found.length > 0) {
        tier = t;
        occ = found;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = occ[0]!;
    let best = Math.abs(pos - target);
    for (const p of occ) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const rep = buildReplacement(model.lines, h.o, h.n, pos, tier);
    const endsAtEnd = pos + h.o.length === model.lines.length;
    return {
      lines: [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + h.o.length)],
      br: model.br,
      final: endsAtEnd ? !h.noBreak : model.final,
    };
  }
  const at = Math.max(0, Math.min(h.a + d, model.lines.length));
  const rep = h.n.map((p) => p.text);
  return {
    lines: [...model.lines.slice(0, at), ...rep, ...model.lines.slice(at)],
    br: model.br,
    final: at === model.lines.length ? !h.noBreak : model.final,
  };
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let cur = model;
  let d = 0;
  for (const h of hunks) {
    cur = applyHunk(cur, h, d, strict, path);
    d += h.n.length - h.o.length;
  }
  return cur;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => {
    // A ---/+++ pair naming /dev/null on a side means "no file" on that side:
    // it must not fall through to the rename / diff --git paths (SPEC §6).
    const oldPath = s.slashOld ?? (s.slashOldNull ? null : (s.renOld ?? s.diffOld ?? null));
    const newPath = s.slashNew ?? (s.slashNewNull ? null : (s.renNew ?? s.diffNew ?? null));
    if (oldPath === null && newPath === null) return () => {};
    const isCreate = oldPath === null || s.newFile;
    const isDelete = !isCreate && (newPath === null || s.deletedFile);
    const plusLines: string[] = [];
    for (const h of s.hunks) for (const p of h.n) if (p.ctx === null) plusLines.push(p.text);
    return (tree) => {
      if (oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (isCreate) {
        if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
        tree.now.set(newPath!, plusLines.length === 0 ? '' : plusLines.join('\n') + (s.createNoBreak ? '' : '\n'));
        return;
      }
      if (isDelete) {
        if (tree.get(oldPath!) === null) throw new Fail('missing', oldPath!);
        tree.now.set(oldPath!, null);
        return;
      }
      if (oldPath !== newPath) {
        const cur = tree.get(oldPath!);
        if (cur === null) throw new Fail('missing', oldPath!);
        if (tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
        const model = applyHunks(splitFile(cur), s.hunks, strict, oldPath!);
        tree.now.set(oldPath!, null);
        tree.now.set(newPath!, joinFile(model));
        tree.moves.push([oldPath!, newPath!]);
        return;
      }
      const cur = tree.get(oldPath!);
      if (cur === null) throw new Fail('missing', oldPath!);
      tree.now.set(oldPath!, joinFile(applyHunks(splitFile(cur), s.hunks, strict, oldPath!)));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC section 7)                              */
/* ------------------------------------------------------------------ */

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const model = splitFile(cur);
    let tier = -1;
    let occ: number[] = [];
    for (const t of tiersFor(strict)) {
      const found = occurrences(model.lines, oldLines, t);
      if (found.length > 0) {
        tier = t;
        occ = found;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    if (occ.length > 1) throw new Fail('ambiguous', path);
    const pos = occ[0]!;
    const rep = buildReplacement(
      model.lines,
      oldLines,
      newLines.map((text) => ({ text, ctx: null })),
      pos,
      tier,
    );
    tree.now.set(path, joinFile({
      lines: [...model.lines.slice(0, pos), ...rep, ...model.lines.slice(pos + oldLines.length)],
      br: model.br,
      final: model.final,
    }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let blockEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= blockEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let k = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      // ======= must come before this block's >>>>>>> REPLACE and before the
      // next block's SEARCH (SPEC §7: SEARCH with no ======= then >>>>>>> is a parse error).
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      if (t === '=======') {
        k = j;
        break;
      }
    }
    if (k < 0) throw new Exit2(`error: parse ${searchLine}`);
    let m = -1;
    for (let j = k + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchLine}`);
      if (t === '>>>>>>> REPLACE') {
        m = j;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(makeSearchReplaceEdit(path, lines.slice(i + 1, k), lines.slice(k + 1, m), strict));
    prevPath = path;
    blockEnd = m + 1;
    i = m + 1;
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC section 8)                                        */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NPart[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function makeAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** Parse one Update File section's lines (raw[j] is patch line updLine + 1 + j) into its edit. */
function makeUpdateEdit(path: string, raw: string[], updLine: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let idx = 0;
  if (raw.length > 0 && raw[0]!.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.slice(13).trim();
    idx = 1;
  }
  let cur: VChunk | null = null;
  const push = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const l = raw[idx]!;
    const lineNo = updLine + 1 + idx;
    if (l.startsWith('@@')) {
      push();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
      continue;
    }
    // SPEC §8 writes the line as `*** End of File` with no whitespace tolerance
    // (unlike Begin/End Patch and the SEARCH/REPLACE markers, which the spec
    // explicitly tolerates whitespace on): match it exactly.
    if (l === '*** End of File') {
      // `*** End of File` ends a chunk; with no open chunk it creates none.
      // If a chunk already ended, this is a stray line: parse error at this
      // line. If no chunk has been seen yet, the section stays chunkless and
      // the section-level rule below reports `error: parse <Update File line>`.
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        continue;
      }
      cur.eof = true;
      push();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
        cur = { anchor: null, eof: false, o: [], n: [] };
      }
      const kind = l === '' ? ' ' : l[0]!;
      const text = l === '' ? '' : l.slice(1);
      if (kind === ' ') {
        cur.o.push(text);
        cur.n.push({ text, ctx: cur.o.length - 1 });
      } else if (kind === '-') cur.o.push(text);
      else cur.n.push({ text, ctx: null });
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  push();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(curText);
    let lines = model.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiersFor(strict)) {
          const occ = occurrences(lines, [ch.anchor], t, cursor);
          if (occ.length > 0) {
            found = occ[0]!;
            break;
          }
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (ch.o.length > 0) {
        let tier = -1;
        let pos = -1;
        for (const t of tiersFor(strict)) {
          const occ = occurrences(lines, ch.o, t, cursor).filter((p) => !ch.eof || p + ch.o.length === lines.length);
          if (occ.length > 0) {
            tier = t;
            pos = occ[0]!;
            break;
          }
        }
        if (tier < 0) throw new Fail('no-match', path);
        const rep = buildReplacement(lines, ch.o, ch.n, pos, tier);
        lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + ch.o.length)];
        cursor = pos + ch.n.length;
      } else {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...ch.n.map((p) => p.text), ...lines.slice(at)];
        cursor = at + ch.n.length;
      }
    }
    const out = joinFile({ lines, br: model.br, final: model.final });
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const start = i;
      i++;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const fileLines: string[] = [];
      for (let j = 0; j < raw.length; j++) {
        const rl = raw[j]!;
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (rl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${start + 2 + j}`);
      }
      edits.push(makeAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      const start = i;
      i++;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      for (let j = 0; j < raw.length; j++) throw new Exit2(`error: parse ${start + 2 + j}`);
      edits.push(makeDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const updLine = i + 1;
      i++;
      const raw: string[] = [];
      while (i < last && !isV4aSectionStart(lines[i]!)) {
        raw.push(lines[i]!);
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      edits.push(makeUpdateEdit(path, raw, updLine, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC sections 1, 2 and 10)                         */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort(byteOrder)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (suppressed.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of changed) if (tree.now.get(p) === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
