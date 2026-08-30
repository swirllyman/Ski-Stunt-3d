/**
 * Source scanning helpers for the headless smoke test.
 *
 * These are deliberately dependency-free: the pipeline has no build step
 * and no npm install, so the smoke test cannot lean on a real parser.
 * The scanner over-collects declarations on purpose — it is tuned to
 * catch the failure it exists for (a reference to a name that is never
 * defined anywhere) without inventing false alarms.
 *
 * index.html is written to stay inside what this can read reliably:
 * no `class` bodies and no object-literal method shorthand.
 */

const RESERVED = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let',
  'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw',
  'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'as', 'from',
  'get', 'set', 'async',
]);

export const GLOBALS = new Set([
  'globalThis', 'undefined', 'NaN', 'Infinity', 'arguments',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'Function',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask',
  'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array',
  'Float64Array', 'BigInt64Array', 'BigUint64Array', 'Intl', 'AbortController',
  'window', 'document', 'navigator', 'location', 'history', 'screen', 'self',
  'top', 'parent', 'frames', 'console', 'performance', 'crypto', 'localStorage',
  'sessionStorage', 'alert', 'confirm', 'prompt', 'matchMedia', 'getComputedStyle',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback',
  'fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FormData', 'XMLHttpRequest', 'WebSocket',
  'Worker', 'Image', 'Audio', 'Event', 'CustomEvent', 'EventTarget',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'DOMParser',
  'HTMLElement', 'Element', 'Node', 'CanvasRenderingContext2D',
  'WebGLRenderingContext', 'WebGL2RenderingContext', 'TextEncoder', 'TextDecoder',
  'atob', 'btoa', 'devicePixelRatio', 'innerWidth', 'innerHeight',
]);

/** Extract every <script> block from an HTML document. */
export const extractScripts = (html) => {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    const typeMatch = attrs.match(/type\s*=\s*["']?([^"'\s>]+)/i);
    out.push({
      type: typeMatch ? typeMatch[1].toLowerCase() : 'text/javascript',
      code: m[2],
      start: m.index + m[0].indexOf(m[2]),
      line: html.slice(0, m.index).split('\n').length,
    });
  }
  return out;
};

/**
 * Blank out comments, string literals, template literals and regex
 * literals, replacing them with spaces so every offset stays valid.
 */
export const stripLiterals = (src) => {
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i];

  const blank = (from, to) => {
    for (let i = from; i < to && i < src.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };

  const prevSignificant = (i) => {
    for (let k = i - 1; k >= 0; k--) {
      const c = out[k];
      if (c === ' ' || c === '\n' || c === '\t' || c === '\r') continue;
      return c;
    }
    return '';
  };

  let i = 0;
  const templateStack = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i;
      while (j < src.length && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, src.length));
      i = j + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || src[j] === '\n') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') {
          blank(i + 1, j);
          templateStack.push(true);
          i = j + 2;
          break;
        }
        j++;
      }
      if (templateStack.length && i < j) continue;
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '}' && templateStack.length) {
      templateStack.pop();
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '/') {
      const p = prevSignificant(i);
      const divisionContext = p !== '' && (/[A-Za-z0-9_$)\]]/.test(p));
      if (!divisionContext) {
        let j = i + 1;
        let inClass = false;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '/' && !inClass) break;
          else if (src[j] === '\n') break;
          j++;
        }
        /* ...and the flags. Leaving them behind makes the `g` of a
         * /.../g read as a bare identifier, which the reference scan
         * then reports as undefined. */
        let flags = j + 1;
        while (flags < src.length && /[a-z]/.test(src[flags])) flags++;
        blank(i + 1, j);
        blank(j + 1, flags);
        i = flags;
        continue;
      }
    }
    i++;
  }
  return out.join('');
};

const identsIn = (text, into) => {
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > 0 && /[0-9]/.test(text[m.index - 1])) continue;
    if (!RESERVED.has(m[0])) into.add(m[0]);
  }
};

/** Every name that is bound somewhere in this source. Over-collects. */
export const collectDeclarations = (code) => {
  const declared = new Set();

  const importRe = /import\s+([\s\S]*?)\s+from\s/g;
  let m;
  while ((m = importRe.exec(code))) identsIn(m[1], declared);

  const declRe = /\b(?:const|let|var)\s+/g;
  while ((m = declRe.exec(code))) {
    let i = m.index + m[0].length;
    let depth = 0;
    const start = i;
    while (i < code.length) {
      const c = code[i];
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (depth === 0 && (c === '=' || c === ';' || c === '\n')) break;
      i++;
    }
    identsIn(code.slice(start, i), declared);
  }

  const fnRe = /\bfunction\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)?\s*\(/g;
  while ((m = fnRe.exec(code))) {
    if (m[1]) declared.add(m[1]);
    identsIn(paramsAt(code, fnRe.lastIndex - 1), declared);
  }

  const catchRe = /\bcatch\s*\(([^)]*)\)/g;
  while ((m = catchRe.exec(code))) identsIn(m[1], declared);

  /* arrow parameter lists: `(a, b) =>` and `a =>` */
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] !== '=' || code[i + 1] !== '>') continue;
    let k = i - 1;
    while (k >= 0 && /\s/.test(code[k])) k--;
    if (k < 0) continue;
    if (code[k] === ')') {
      const open = matchBackwards(code, k);
      if (open >= 0) identsIn(code.slice(open + 1, k), declared);
    } else {
      let s = k;
      while (s >= 0 && /[A-Za-z0-9_$]/.test(code[s])) s--;
      identsIn(code.slice(s + 1, k + 1), declared);
    }
  }

  return declared;
};

const paramsAt = (code, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    if (code[i] === '(') depth++;
    else if (code[i] === ')') {
      depth--;
      if (depth === 0) return code.slice(openIndex + 1, i);
    }
  }
  return '';
};

const matchBackwards = (code, closeIndex) => {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    if (code[i] === ')') depth++;
    else if (code[i] === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Free identifier references, ignoring property names and object keys. */
export const collectReferences = (code) => {
  const refs = new Map();
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m;
  while ((m = re.exec(code))) {
    const name = m[0];
    if (RESERVED.has(name)) continue;
    /* tail of a numeric literal: 0xff8c42, 1e8, 1_000n */
    if (m.index > 0 && /[0-9]/.test(code[m.index - 1])) continue;

    let before = m.index - 1;
    while (before >= 0 && /[ \t]/.test(code[before])) before--;
    if (before >= 0 && (code[before] === '.' || code[before] === '#')) continue;

    let after = re.lastIndex;
    while (after < code.length && /[ \t]/.test(code[after])) after++;
    if (code[after] === ':' && code[after + 1] !== ':') {
      let p = m.index - 1;
      while (p >= 0 && /\s/.test(code[p])) p--;
      if (p < 0 || code[p] === '{' || code[p] === ',') continue;
    }

    if (!refs.has(name)) refs.set(name, code.slice(0, m.index).split('\n').length);
  }
  return refs;
};

/** Member names read off a namespace import, e.g. every `THREE.Foo`. */
export const collectMemberUse = (code, namespace) => {
  const found = new Map();
  const re = new RegExp('(^|[^A-Za-z0-9_$.])' + namespace + '\\.([A-Za-z_$][A-Za-z0-9_$]*)', 'g');
  let m;
  while ((m = re.exec(code))) {
    if (!found.has(m[2])) found.set(m[2], code.slice(0, m.index).split('\n').length);
  }
  return found;
};

/** Slice out a top-level literal, e.g. `const CONFIG = { ... };`. */
export const extractLiteral = (code, declaration, open, close) => {
  const at = code.indexOf(declaration);
  if (at < 0) return null;
  const start = code.indexOf(open, at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    if (code[i] === open) depth++;
    else if (code[i] === close) {
      depth--;
      if (depth === 0) return { text: code.slice(start, i + 1), start: start, end: i + 1 };
    }
  }
  return null;
};

/** Flatten a nested plain object into dotted leaf paths. */
export const flatten = (obj, prefix, into) => {
  const out = into || new Map();
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = obj[key];
    const path = prefix ? prefix + '.' + key : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out.set(path, value);
  }
  return out;
};
