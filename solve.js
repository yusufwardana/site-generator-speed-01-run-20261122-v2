// A fresh, fast reimplementation of makefun-site 1.0.0's build, written from its
// README (front matter, template dialect, Markdown subset, slug rule, report).
// run(input) returns the output tree { path: text } for one case's input.
// Design: cursor-based block lexer (no token arrays), range-based inline renderer
// (no substring copies for nested markup), batched HTML escaping, per-case
// memoised slugs/dates, cards computed once per source and shared by value.

const byCU = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escReplacer = (c) => ESC[c];
const esc = (s) => s.replace(/[&<>"']/g, escReplacer);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- text helpers

function slugOf(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  // Pure ASCII is unchanged by NFKD, so skip the normalise + mark strip.
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = '';
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === '') { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  memo.set(text, out);
  return out;
}

function uniqSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

function longDateOf(date, memo) {
  const hit = memo.get(date);
  if (hit !== undefined) return hit;
  const s = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
  memo.set(date, s);
  return s;
}

function wordsOf(text) {
  // Count runs of non-whitespace (JS \s), scanning code units by hand: the
  // regex /\S+/g allocates a match object per word.
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11
      || c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028
      || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function dateOk(raw) {
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
  const mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
  const d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return dateOk(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !/^[^"[\]]+$/.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return /^[a-z0-9-]+$/.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// { data, body } or { error }.
function parseFM(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let p = text === '---' ? 3 : 4;
  let close = -1;
  let closeEnd = -1;
  while (p < text.length) {
    const e = text.indexOf('\n', p);
    const le = e === -1 ? text.length : e;
    if (le - p === 3 && text[p] === '-' && text[p + 1] === '-' && text[p + 2] === '-') { close = p; closeEnd = le; break; }
    if (e === -1) break;
    p = e + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  p = text === '---' ? 3 : 4;
  let lineNo = 2;
  while (p < close) {
    const e = text.indexOf('\n', p);
    const le = e === -1 ? text.length : e;
    const line = text.slice(p, le);
    if (!isBlankLine(line) && line[0] !== '#') {
      let j = 0;
      while (j < line.length && ((line[j] >= 'a' && line[j] <= 'z') || line[j] === '_')) j++;
      if (j === 0 || line[j] !== ':') return { error: `line ${lineNo} is not "key: value"` };
      const key = line.slice(0, j);
      let raw;
      if (j + 1 === line.length) raw = '';
      else if (line[j + 1] === ' ') raw = line.slice(j + 2);
      else return { error: `line ${lineNo} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = le + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown: inline

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS1 = /\s/;

// First index >= from where `what` occurs outside a backslash escape, within [from, end), or -1.
function findUnesc(s, what, from, end) {
  const last = end - what.length;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// First single `*` from `from` (one not beside another `*`), outside an escape, or -1.
function findStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Render s[a..b) inline into `out` (chunk array). `link(target)` resolves a link href.
function inl(s, a, b, link, out) {
  let i = a;
  let plain = a;
  const flush = (to) => {
    if (to > plain) { out.push(esc(s.slice(plain, to))); plain = to; }
  };
  while (i < b) {
    const c = s[i];
    if (c === '\\' && i + 1 < b && ESCAPABLE.has(s[i + 1])) {
      flush(i);
      out.push(esc(s[i + 1]));
      i += 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        flush(i);
        out.push('<code>');
        out.push(esc(s.slice(i + 1, j)));
        out.push('</code>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnesc(s, '**', i + 2, b);
        if (j !== -1 && j > i + 2) {
          flush(i);
          out.push('<strong>');
          inl(s, i + 2, j, link, out);
          out.push('</strong>');
          i = j + 2;
          plain = i;
        } else i += 2;
        continue;
      }
      const j = findStar(s, i + 1, b);
      if (j !== -1 && j > i + 1) {
        flush(i);
        out.push('<em>');
        inl(s, i + 1, j, link, out);
        out.push('</em>');
        i = j + 1;
        plain = i;
      } else i++;
      continue;
    }
    if (c === '[') {
      const k = findUnesc(s, ']', i + 1, b);
      const m = k !== -1 && k + 1 < b && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      if (k !== -1 && m !== -1 && m < b) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS1.test(target)) {
          flush(i);
          out.push('<a href="');
          out.push(esc(link(target)));
          out.push('">');
          inl(s, i + 1, k, link, out);
          out.push('</a>');
          i = m + 1;
          plain = i;
          continue;
        }
      }
      i++;
      continue;
    }
    i++;
  }
  flush(b);
}

// ---------------------------------------------------------------- Markdown: blocks

function isBlank(src, p, le) {
  for (let i = p; i < le; i++) {
    const c = src[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function trimBounds(src, p, le) {
  let a = p;
  let b = le;
  while (a < b && (src[a] === ' ' || src[a] === '\t')) a++;
  while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--;
  return [a, b];
}

function fenceLang(src, p, le) {
  if (le - p < 3 || src[p] !== '`' || src[p + 1] !== '`' || src[p + 2] !== '`') return null;
  let i = p + 3;
  while (i < le) {
    const c = src[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') i++;
    else break;
  }
  const lang = src.slice(p + 3, i);
  while (i < le && (src[i] === ' ' || src[i] === '\t')) i++;
  return i === le ? lang : null;
}

function fenceClose(src, p, le) {
  if (le - p < 3 || src[p] !== '`' || src[p + 1] !== '`' || src[p + 2] !== '`') return false;
  for (let i = p + 3; i < le; i++) {
    const c = src[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function headingAt(src, p, le) {
  let i = p;
  let n = 0;
  while (i < le && src[i] === '#') { i++; n++; }
  if (n === 0 || n > 6) return null;
  if (i >= le || (src[i] !== ' ' && src[i] !== '\t')) return null;
  while (i < le && (src[i] === ' ' || src[i] === '\t')) i++;
  let e = le;
  while (e > i && (src[e - 1] === ' ' || src[e - 1] === '\t')) e--;
  if (e === i) return null;
  return { depth: n, a: i, b: e };
}

function isHR(src, p, le) {
  if (le - p < 3) return false;
  const c = src[p];
  if (c !== '-' && c !== '*') return false;
  if (src[p + 1] !== c || src[p + 2] !== c) return false;
  for (let i = p + 3; i < le; i++) {
    const ch = src[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function bulletAt(src, p, le) {
  if (p + 1 < le && (src[p] === '-' || src[p] === '*') && src[p + 1] === ' ') return p + 2;
  return -1;
}

function orderedAt(src, p, le) {
  let i = p;
  while (i < le && src[i] >= '0' && src[i] <= '9') i++;
  const n = i - p;
  if (n < 1 || n > 9) return null;
  if (i + 1 >= le || src[i] !== '.' || src[i + 1] !== ' ') return null;
  return { d0: p, d1: i, text: i + 2 };
}

function isContinued(src, p, le) {
  let i = p;
  while (i < le && src[i] === ' ') i++;
  if (i - p < 2) return false;
  return i < le && !WS1.test(src[i]);
}

function listBlock(src, pos, len, ordered, link, out, tmp) {
  const items = [];
  let p = pos;
  let start = 1;
  while (p < len) {
    const e2 = src.indexOf('\n', p);
    const le2 = e2 === -1 ? len : e2;
    let text = -1;
    if (ordered) {
      const o = orderedAt(src, p, le2);
      if (o !== null) {
        if (items.length === 0) start = Number(src.slice(o.d0, o.d1));
        text = o.text;
      }
    } else {
      text = bulletAt(src, p, le2);
    }
    if (text !== -1) {
      const t = trimBounds(src, text, le2);
      items.push([src.slice(t[0], t[1])]);
      p = e2 === -1 ? len : e2 + 1;
      continue;
    }
    if (items.length > 0 && isContinued(src, p, le2)) {
      const t = trimBounds(src, p, le2);
      items[items.length - 1].push(src.slice(t[0], t[1]));
      p = e2 === -1 ? len : e2 + 1;
      continue;
    }
    break;
  }
  const tag = ordered ? 'ol' : 'ul';
  out.push(ordered && start !== 1 ? '<ol start="' + start + '">\n' : '<' + tag + '>\n');
  for (const parts of items) {
    const joined = parts.join('\n');
    out.push('<li>');
    inl(joined, 0, joined.length, link, out);
    out.push('</li>\n');
  }
  out.push('</' + tag + '>\n');
  return p;
}

function quoteBlock(src, pos, len, link, out, tmp) {
  const parts = [];
  let p = pos;
  while (p < len) {
    const e2 = src.indexOf('\n', p);
    const le2 = e2 === -1 ? len : e2;
    if (src[p] !== '>') break;
    let s = p + 1;
    if (s < le2 && src[s] === ' ') s++;
    const t = trimBounds(src, s, le2);
    if (t[1] > t[0]) parts.push(src.slice(t[0], t[1]));
    p = e2 === -1 ? len : e2 + 1;
  }
  if (parts.length === 0) out.push('<blockquote>\n</blockquote>\n');
  else {
    const joined = parts.join('\n');
    out.push('<blockquote>\n<p>');
    inl(joined, 0, joined.length, link, out);
    out.push('</p>\n</blockquote>\n');
  }
  return p;
}

function paraBlock(src, pos, len, link, out, tmp, wantHtml) {
  const parts = [];
  let p = pos;
  let le = src.indexOf('\n', p);
  if (le === -1) le = len;
  const t0 = trimBounds(src, p, le);
  parts.push(src.slice(t0[0], t0[1]));
  p = le < len ? le + 1 : len;
  while (p < len) {
    const e2 = src.indexOf('\n', p);
    const le2 = e2 === -1 ? len : e2;
    if (isBlank(src, p, le2) || fenceLang(src, p, le2) !== null || headingAt(src, p, le2) !== null || isHR(src, p, le2)) break;
    const t = trimBounds(src, p, le2);
    parts.push(src.slice(t[0], t[1]));
    p = e2 === -1 ? len : e2 + 1;
  }
  const joined = parts.join('\n');
  if (wantHtml) {
    tmp.length = 0;
    inl(joined, 0, joined.length, link, tmp);
    const html = tmp.join('');
    out.push('<p>' + html + '</p>\n');
    return { pos: p, html };
  }
  out.push('<p>');
  inl(joined, 0, joined.length, link, out);
  out.push('</p>\n');
  return { pos: p, html: null };
}

function renderMD(src, link, slugMemo) {
  const ids = new Set();
  const out = [];
  const toc = [];
  const tmp = [];
  let excerpt = null;
  let pos = 0;
  const len = src.length;
  while (pos < len) {
    let le = src.indexOf('\n', pos);
    if (le === -1) le = len;
    const next = le < len ? le + 1 : len;
    if (isBlank(src, pos, le)) { pos = next; continue; }
    const c0 = src[pos];
    if (c0 === '`') {
      const lang = fenceLang(src, pos, le);
      if (lang !== null) {
        out.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>');
        let p = next;
        while (p < len) {
          const e2 = src.indexOf('\n', p);
          const le2 = e2 === -1 ? len : e2;
          if (fenceClose(src, p, le2)) { p = e2 === -1 ? len : e2 + 1; break; }
          out.push(esc(src.slice(p, le2)));
          out.push('\n');
          p = e2 === -1 ? len : e2 + 1;
        }
        pos = p;
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === '#') {
      const h = headingAt(src, pos, le);
      if (h !== null) {
        const id = uniqSlug(slugOf(src.slice(h.a, h.b), slugMemo), ids);
        if (h.depth === 2 || h.depth === 3) {
          tmp.length = 0;
          inl(src, h.a, h.b, link, tmp);
          const html = tmp.join('');
          out.push('<h' + h.depth + ' id="' + id + '">' + html + '</h' + h.depth + '>\n');
          toc.push({ level: h.depth, id, html });
        } else {
          out.push('<h' + h.depth + ' id="' + id + '">');
          inl(src, h.a, h.b, link, out);
          out.push('</h' + h.depth + '>\n');
        }
        pos = next;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHR(src, pos, le)) { out.push('<hr>\n'); pos = next; continue; }
      if (bulletAt(src, pos, le) !== -1) { pos = listBlock(src, pos, len, false, link, out, tmp); continue; }
    } else if (c0 === '>') {
      pos = quoteBlock(src, pos, len, link, out, tmp);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      if (orderedAt(src, pos, le) !== null) { pos = listBlock(src, pos, len, true, link, out, tmp); continue; }
    }
    const r = paraBlock(src, pos, len, link, out, tmp, excerpt === null);
    pos = r.pos;
    if (excerpt === null) excerpt = r.html;
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

// Node kinds: 0 text [0, str], 1 var [1, path], 2 raw [2, path],
// 3 if [3, path, not, then, else|null], 4 for [4, name, path, body], 5 include [5, name].
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function parseTemplate(name, src) {
  const root = [];
  const stack = [root];
  let body = root;
  let i = 0;
  let textStart = 0;
  const pushText = (a, b) => {
    if (b > a) body.push([0, src.slice(a, b)]);
  };
  const bodyOf = (node) => {
    if (node === root) return root;
    if (node[0] === 4) return node[3];
    return node[4] !== null ? node[4] : node[3];
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) break;
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') { i = open + 1; continue; }
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText(textStart, open);
      body.push([raw ? 2 : 1, pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim())]);
      i = close + (raw ? 3 : 2);
      textStart = i;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) pushText(textStart, lineStart);
    else pushText(textStart, open);
    const tag = src.slice(open + 2, close).trim();
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = [4, m[1], pathOf(name, m[2]), []];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = [3, pathOf(name, m[2]), m[1] !== undefined, [], null];
      body.push(node);
      stack.push(node);
      body = node[3];
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top === root || top[0] !== 3 || top[4] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top[4] = [];
      body = top[4];
    } else if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top === root || top[0] !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      body = bodyOf(stack[stack.length - 1]);
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push([5, m[1]]);
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
    textStart = i;
  }
  pushText(textStart, src.length);
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    throw new TemplateError(`template "${name}": a ${top[0] === 4 ? 'for' : 'if'} is not closed`);
  }
  return root;
}

function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const nd = nodes[n];
    const kind = nd[0];
    if (kind === 0) { out.push(nd[1]); continue; }
    if (kind === 1 || kind === 2) {
      const v = lookup(scope, nd[1]);
      if (v === undefined || v === null) continue;
      if (typeof v === 'string') { out.push(kind === 1 ? esc(v) : v); continue; }
      if (typeof v === 'number') { out.push(String(v)); continue; }
      if (typeof v === 'boolean') { out.push(v ? 'true' : 'false'); continue; }
      if (Array.isArray(v)) {
        const t = textOf(v);
        if (t !== '') out.push(kind === 1 ? esc(t) : t);
      }
      continue;
    }
    if (kind === 3) {
      const v = truthy(lookup(scope, nd[1]));
      const br = v !== nd[2] ? nd[3] : nd[4];
      if (br !== null) renderNodes(br, scope, ctx, depth, out);
      continue;
    }
    if (kind === 4) {
      const xs = lookup(scope, nd[2]);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = { [nd[1]]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
        renderNodes(nd[3], { vars, parent: scope }, ctx, depth, out);
      }
      continue;
    }
    const t = ctx.templates.get(nd[1]);
    if (t !== undefined && depth < 8) renderNodes(t, scope, ctx, depth + 1, out);
  }
}

// ---------------------------------------------------------------- Build

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function run(input) {
  const slugMemo = new Map();
  const dateMemo = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCU)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const files = [...input.files].sort((x, y) => byCU(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    s.slug = uniqSlug(s.data.slug ?? slugOf(s.data.title, slugMemo), set);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return bySource.get(path).url + frag;
      if (path !== null && staticPaths.has(path)) return base + '/' + path + frag;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMD(s.body, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCU(y.data.date, x.data.date) || byCU(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugOf(name, slugMemo);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCU(x.slug, y.slug));
  const linkOf = (t) => (t === null ? null : {
    title: t.data.title,
    url: t.url,
    date: t.data.date ?? '',
    date_long: t.data.date === undefined ? '' : longDateOf(t.data.date, dateMemo),
  });
  for (const p of posts) {
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  }
  const cards = new Map();
  for (const p of posts) {
    p.tagLinks = p.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    p.dateLong = p.data.date === undefined ? '' : longDateOf(p.data.date, dateMemo);
    p.reading = Math.max(1, Math.ceil(wordsOf(p.body) / 200));
    cards.set(p, {
      title: p.data.title, url: p.url, date: p.data.date ?? '', date_long: p.dateLong,
      summary: p.data.summary ?? '', excerpt: p.excerpt, reading_minutes: p.reading, tags: p.tagLinks,
    });
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagLinks = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    s.dateLong = s.data.date === undefined ? '' : longDateOf(s.data.date, dateMemo);
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }
  const pageObj = (s) => ({
    title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.dateLong,
    summary: s.data.summary ?? '', excerpt: s.excerpt, reading_minutes: s.reading, tags: s.tagLinks,
    slug: s.slug, content: s.html, toc: s.toc,
    newer: s.post ? s.newerLink : null, older: s.post ? s.olderLink : null, is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const tout = [];
  const render = (name, extra) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const vars = { site, tags: allTags, recent };
    if (extra !== undefined) {
      for (const k in extra) vars[k] = extra[k];
    }
    tout.length = 0;
    renderNodes(nodes, { vars, parent: null }, ctx, 0, tout);
    return tout.join('');
  };
  const output = {};
  for (const s of kept) output[s.outDir + '/index.html'] = render(s.layout, { page: pageObj(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', undefined);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCU);
  lines.push(`built ${kept.filter((s) => !s.post).length} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
