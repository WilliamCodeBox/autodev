// yaml-lite.mjs — minimal YAML subset for autodev state files.
//
// Supports: nested mappings (2-space indent), block sequences, inline flow
// sequences [a, b], scalars with type inference, "double"/'single' quotes, and
// # comments. NOT a full YAML implementation — sufficient for the
// machine-generated / machine-parsed autodev state files (autodev.yaml +
// slices/<id>.yaml). Kept dependency-free so the omp tool loads with no npm
// install (bare tools/ dirs are not auto-dependency-resolved by omp).

function stripComment(line) {
  let inS = false, inD = false;
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inS) { inD = !inD; out += c; }
    else if (c === "'" && !inD) { inS = !inS; out += c; }
    else if (c === '#' && !inS && !inD) {
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') break;
      out += c;
    } else out += c;
  }
  return out;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    // 双引号标量：处理转义 \" 与 \\（否则含内嵌双引号的值保存后无法无损往返）。
    const inner = s.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const n = inner[i + 1];
        if (n === '"' || n === '\\') { out += n; i++; continue; }
      }
      out += inner[i];
    }
    return out;
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// 在括号/引号深度 0 处按 sep 切分（这样 ["a,b","c"] 不会被拆成 ["a","b","c"]）。
function splitTopLevel(s, sep = ',') {
  const parts = [];
  let cur = '';
  let inS = false, inD = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inS) { inD = !inD; cur += c; }
    else if (c === "'" && !inD) { inS = !inS; cur += c; }
    else if (!inS && !inD && (c === '[' || c === '{')) depth++;
    else if (!inS && !inD && (c === ']' || c === '}')) depth--;
    else if (c === sep && !inS && !inD && depth === 0) { parts.push(cur); cur = ''; }
    else cur += c;
  }
  parts.push(cur);
  return parts;
}

function parseInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  return splitTopLevel(inner).map((x) => parseScalar(x.trim()));
}

// 解析内联 map，如 {a: 1, b: "x,y"}。顶层逗号切分后按首个冒号拆 key/value。
export function parseInlineMap(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return {};
  const out = {};
  for (const part of splitTopLevel(inner)) {
    const c = part.trim();
    if (!c) continue;
    const ci = c.indexOf(':');
    if (ci < 0) continue;
    const k = c.slice(0, ci).trim();
    const v = c.slice(ci + 1).trim();
    out[k] = parseScalar(v);
  }
  return out;
}

export function parse(text) {
  const rawLines = String(text).split(/\r?\n/);
  const lines = [];
  for (const rl of rawLines) {
    const noComment = stripComment(rl);
    if (noComment.trim() === '') continue;
    const indent = noComment.length - noComment.trimStart().length;
    lines.push({ indent, text: noComment.trim() });
  }
  let idx = 0;
  function parseNode(minIndent) {
    if (idx >= lines.length) return undefined;
    const first = lines[idx];
    if (first.indent < minIndent) return undefined;
    if (first.text === '-' || first.text.startsWith('- ')) return parseSeq(first.indent);
    return parseMap(first.indent);
  }
  function parseMap(minIndent) {
    const obj = {};
    while (idx < lines.length) {
      const ln = lines[idx];
      if (ln.indent < minIndent) break;
      if (ln.indent > minIndent) break;
      const m = ln.text.match(/^([^:]+):(.*)$/);
      if (!m) break;
      const key = m[1].trim();
      const rest = m[2];
      idx++;
      const restTrim = rest.trim();
      if (restTrim === '') {
        const child = parseNode(minIndent + 1);
        obj[key] = child === undefined ? null : child;
      } else if (restTrim.startsWith('[')) {
        obj[key] = parseInlineList(restTrim);
      } else if (restTrim.startsWith('{')) {
        obj[key] = parseInlineMap(restTrim);
      } else {
        obj[key] = parseScalar(restTrim);
      }
    }
    return obj;
  }
  function parseSeq(minIndent) {
    const arr = [];
    while (idx < lines.length) {
      const ln = lines[idx];
      if (ln.indent < minIndent) break;
      if (ln.indent > minIndent) break;
      if (!(ln.text === '-' || ln.text.startsWith('- '))) break;
      const content = ln.text === '-' ? '' : ln.text.slice(2);
      idx++;
      const c = content.trim();
      if (c === '') {
        const child = parseNode(minIndent + 1);
        arr.push(child === undefined ? null : child);
      } else if (c.startsWith('[')) {
        arr.push(parseInlineList(c));
      } else if (c.startsWith('{')) {
        arr.push(parseInlineMap(c));
      } else if (c.includes(':') && !c.startsWith('"') && !c.startsWith("'")) {
        // inline map start: "- key: value" -> treat rest as a map at minIndent+2
        lines.splice(idx, 0, { indent: minIndent + 2, text: c });
        const child = parseNode(minIndent + 2);
        arr.push(child);
      } else {
        arr.push(parseScalar(c));
      }
    }
    return arr;
  }
  const result = parseNode(0);
  return result === undefined ? {} : result;
}

function scalarStr(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (s === '') return '""';
  if (/[:#\[\]\{\},&*!|>'"%@`]/.test(s) ||
      /^[\s-]/.test(s) ||
      s !== s.trim() ||
      /^-?\d+(\.\d+)?$/.test(s) ||
      s === 'true' || s === 'false' || s === 'null' || s === '~') {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function dumpSeqItem(item, seqIndent, itemIndent) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const sub = dumpMap(item, 0).split('\n');
    return sub.map((sl, i) => {
      if (i === 0) return `${' '.repeat(seqIndent)}- ${sl}`;
      return `${' '.repeat(itemIndent)}${sl}`;
    }).join('\n');
  }
  return `${' '.repeat(seqIndent)}- ${scalarStr(item)}`;
}

function dumpMap(obj, indent) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) {
      lines.push(`${pad}${k}:`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${k}: []`); continue; }
      lines.push(`${pad}${k}:`);
      for (const item of v) lines.push(dumpSeqItem(item, indent + 2, indent + 4));
    } else if (typeof v === 'object') {
      if (Object.keys(v).length === 0) {
        lines.push(`${pad}${k}: {}`);
      } else {
        lines.push(`${pad}${k}:`);
        lines.push(dumpMap(v, indent + 2));
      }
    } else {
      lines.push(`${pad}${k}: ${scalarStr(v)}`);
    }
  }
  return lines.join('\n');
}

export function stringify(obj) {
  if (Array.isArray(obj)) return obj.map((it) => dumpSeqItem(it, 0, 2)).join('\n');
  return dumpMap(obj, 0);
}
