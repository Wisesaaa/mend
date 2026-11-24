// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

// ---- file line handling (SPEC.md section 3) ----

interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    final = true;
    parts.pop();
  }
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- three-tier matching (SPEC.md section 5) ----

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  const trail = (s: string): string => s.replace(/[ \t]+$/, '');
  if (tier === 1) return trail(a) === trail(b);
  const both = (s: string): string => trail(s).replace(/^[ \t]+/, '');
  return both(a) === both(b);
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isBlankOnly(s: string): boolean {
  return s !== '' && /^[ \t]+$/.test(s);
}

function reindent(line: string, f: string, p: string): string {
  if (line === '' || isBlankOnly(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

interface BodyItem {
  kind: ' ' | '-' | '+';
  text: string;
}

/** Build the replacement segment for a hunk/chunk: context lines come from the file, '+' lines from the patch. */
function buildSeg(items: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const firstO = items.find((it) => it.kind === ' ' || it.kind === '-');
  const p = firstO ? leadWs(firstO.text) : '';
  const f = pos < fileLines.length ? leadWs(fileLines[pos]!) : '';
  const seg: string[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === ' ') {
      seg.push(fileLines[pos + oIdx]!);
      oIdx++;
    } else if (it.kind === '-') {
      oIdx++;
    } else {
      seg.push(tier === 2 ? reindent(it.text, f, p) : it.text);
    }
  }
  return seg;
}

function oLinesOf(items: BodyItem[]): string[] {
  return items.filter((it) => it.kind === ' ' || it.kind === '-').map((it) => it.text);
}

// ---- format detection (SPEC.md section 4) ----

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

// ---- JSON edits (SPEC.md section 9) ----

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

// ---- unified diffs (SPEC.md section 6) ----

interface UniHunk {
  a: number;
  items: BodyItem[];
  backslash: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UniHunk[];
}

function uniPath(s: string): string | null {
  const t = s.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

function classifyBody(l: string): BodyItem {
  if (l === '') return { kind: ' ', text: '' };
  const c = l[0]!;
  if (c === ' ') return { kind: ' ', text: l.slice(1) };
  if (c === '-') return { kind: '-', text: l.slice(1) };
  return { kind: '+', text: l.slice(1) };
}

function parseUnified(lines: string[]): UniSection[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let i = 0;
  const fresh = (): UniSection => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    hasPair: false,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0 && !cur.hasPair) {
        cur.oldPath = uniPath(line.slice(4));
        cur.newPath = uniPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
      } else {
        cur = fresh();
        cur.oldPath = uniPath(line.slice(4));
        cur.newPath = uniPath(lines[i + 1]!.slice(4));
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (!m || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          raw.push(b);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const items: BodyItem[] = [];
      for (let k = 0; k < raw.length; k++) {
        const b = raw[k]!;
        if (b.startsWith('\\')) continue;
        items.push(classifyBody(b));
      }
      // A backslash counts when it directly follows the hunk's last context or '+' line.
      let bs = false;
      for (let k = 0; k < raw.length; k++) {
        if (!raw[k]!.startsWith('\\')) continue;
        const prev = raw[k - 1]!;
        if (prev !== undefined && (prev.startsWith(' ') || prev.startsWith('+') || prev === '')) {
          let isLast = true;
          for (let q = k + 1; q < raw.length; q++) {
            if (!raw[q]!.startsWith('\\') && (raw[q]!.startsWith(' ') || raw[q]!.startsWith('+') || raw[q] === '')) {
              isLast = false;
              break;
            }
          }
          if (isLast) bs = true;
        }
      }
      cur.hunks.push({ a, items, backslash: bs });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.newPath = uniPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
    }
    i++;
  }
  return sections;
}

/** Apply one unified hunk to a file state; throws Fail on no-match. */
function applyUniHunk(f: FileState, h: UniHunk, a: number, d: number, strict: boolean, path: string): number {
  const o = oLinesOf(h.items);
  const nCount = h.items.filter((it) => it.kind === ' ' || it.kind === '+').length;
  if (o.length > 0) {
    const found = findTier(f.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    const target = a - 1 + d;
    let pos = found.pos[0]!;
    for (const p of found.pos) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const seg = buildSeg(h.items, f.lines, pos, found.tier);
    const atEnd = pos + o.length === f.lines.length;
    f.lines.splice(pos, o.length, ...seg);
    if (atEnd) f.final = !h.backslash;
    return nCount - o.length;
  }
  const at = Math.max(0, Math.min(a + d, f.lines.length));
  const seg = h.items.filter((it) => it.kind === '+').map((it) => it.text);
  f.lines.splice(at, 0, ...seg);
  if (at === f.lines.length && seg.length > 0) f.final = !h.backslash;
  return nCount;
}

function uniSectionEdit(s: UniSection, strict: boolean): Edit {
  const oldP = s.hasPair ? s.oldPath : s.renameFrom !== null ? s.renameFrom : s.diffOld;
  const newP = s.hasPair ? s.newPath : s.renameTo !== null ? s.renameTo : s.newPath !== null ? s.newPath : s.diffNew;
  const isCreate = s.newFile || oldP === null;
  const isDelete = !isCreate && (s.deletedFile || newP === null);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastBs = false;
      for (const h of s.hunks) {
        for (const it of h.items) if (it.kind === '+') plus.push(it.text);
        lastBs = h.backslash && h.items.some((it) => it.kind === '+');
      }
      // backslash after the very last '+' line overall
      let bs = false;
      outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.items.some((it) => it.kind === '+')) {
          bs = h.backslash;
          break outer;
        }
      }
      void lastBs;
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    const path = oldP!;
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (newP !== null && newP !== path && tree.get(newP) !== null) throw new Fail('exists', newP);
    const f = splitFile(cur);
    let d = 0;
    for (const h of s.hunks) {
      d += applyUniHunk(f, h, h.a, d, strict, path);
    }
    const out = joinFile(f);
    if (newP !== null && newP !== path) {
      tree.now.set(newP, out);
      tree.now.set(path, null);
      tree.moves.push([path, newP]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => uniSectionEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = splitFile(cur);
      const found = findTier(f.lines, oldLines, strict);
      if (!found) throw new Fail('no-match', p);
      if (found.pos.length > 1) throw new Fail('ambiguous', p);
      const pos = found.pos[0]!;
      const seg = newLines.map((l) => (found.tier === 2 ? reindent(l, leadWs(f.lines[pos]!), leadWs(oldLines[0]!)) : l));
      f.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(p, joinFile(f));
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

interface V4aChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  headerLine: number;
}

const V4A_HEAD = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function parseV4a(lines: string[], strict: boolean): Edit[] {
  void strict;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const m = V4A_HEAD.exec(lines[i]!);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update';
    const path = m[2]!.trim();
    const headerLine = i + 1;
    i++;
    const body: { text: string; num: number }[] = [];
    while (i < last) {
      if (V4A_HEAD.test(lines[i]!)) break;
      if (lines[i]!.trim() === '*** End Patch') break;
      body.push({ text: lines[i]!, num: i + 1 });
      i++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text === '') fileLines.push('');
        else if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else throw new Exit2(`error: parse ${b.num}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      for (const b of body) {
        if (!blank(b.text)) throw new Exit2(`error: parse ${b.num}`);
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let k = 0;
      if (body.length > 0) {
        const mm = /^\*\*\* Move to: (.*)$/.exec(body[0]!.text);
        if (mm) {
          moveTo = mm[1]!.trim();
          k = 1;
        }
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      for (; k < body.length; k++) {
        const b = body[k]!;
        const l = b.text;
        if (l.startsWith('@@')) {
          const a = l.slice(2).trim();
          cur = { anchor: a === '' ? null : a, items: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${b.num}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, items: [], eof: false };
              chunks.push(cur);
            } else throw new Exit2(`error: parse ${b.num}`);
          }
          cur.items.push(classifyBody(l));
          continue;
        }
        throw new Exit2(`error: parse ${b.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      const p = path;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const curText = tree.get(p);
        if (curText === null) throw new Fail('missing', p);
        if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
        const f = splitFile(curText);
        let cursor = 0;
        for (const ch of chs) {
          cursor = applyV4aChunk(f, ch, cursor, strict, p);
        }
        const out = joinFile(f);
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(p, null);
          tree.moves.push([p, mt]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
  return edits;
}

function applyV4aChunk(f: FileState, ch: V4aChunk, cursor: number, strict: boolean, path: string): number {
  let cur = cursor;
  if (ch.anchor !== null) {
    const anchor = ch.anchor;
    let foundIdx = -1;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      for (let k = cur; k < f.lines.length; k++) {
        if (tierEq(f.lines[k]!, anchor, t)) {
          foundIdx = k;
          break;
        }
      }
      if (foundIdx >= 0) break;
    }
    if (foundIdx < 0) throw new Fail('no-match', path);
    cur = foundIdx + 1;
  }
  const o = oLinesOf(ch.items);
  if (o.length === 0) {
    const seg = ch.items.filter((it) => it.kind === '+').map((it) => it.text);
    const at = ch.eof ? f.lines.length : cur;
    f.lines.splice(at, 0, ...seg);
    return at + seg.length;
  }
  let found: { tier: number; pos: number } | null = null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(f.lines, o, t).filter((p) => p >= cur);
    const use = ch.eof ? occ.filter((p) => p + o.length === f.lines.length) : occ;
    if (use.length > 0) {
      found = { tier: t, pos: use[0]! };
      break;
    }
  }
  if (!found) throw new Fail('no-match', path);
  const seg = buildSeg(ch.items, f.lines, found.pos, found.tier);
  f.lines.splice(found.pos, o.length, ...seg);
  return found.pos + seg.length;
}

// ---- run (SPEC.md sections 1, 2, 10) ----

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
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const entries: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      entries.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // a move's R row replaces its D/A pair; write the moved file too (not covered above when suppressed)
  for (const [oldP, newP] of tree.moves) {
    if (!suppressed.has(newP)) continue;
    if (check) continue;
    const nowNew = tree.now.get(newP);
    if (nowNew === null) rmSync(newP, { force: true });
    else {
      mkdirSync(dirname(newP), { recursive: true });
      writeFileSync(newP, nowNew);
    }
    rmSync(oldP, { force: true });
  }
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = entries.map((e) => e.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
