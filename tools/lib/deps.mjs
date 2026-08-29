/**
 * Dependency checks for the smoke test: import-map parsing, CDN
 * reachability, and reading the real export list out of the pinned
 * package so `THREE.Foo` typos are caught before they ship.
 *
 * Everything here degrades: if the CDN is unreachable (a locked-down
 * agent sandbox usually is) it falls back to the npm registry, which
 * serves the exact same bytes jsDelivr does for a pinned version.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const CACHE_DIR = '.cache/vendor';

export const parseImportMap = (html) => {
  const m = html.match(/<script[^>]*type\s*=\s*["']?importmap["']?[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!m) return null;
  return JSON.parse(m[1]);
};

/** jsDelivr and unpkg both address npm as /<pkg>@<version>/<file>. */
export const parseCdnUrl = (url) => {
  const m = url.match(/^https:\/\/(cdn\.jsdelivr\.net\/npm|unpkg\.com)\/((?:@[^/@]+\/)?[^/@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  return { host: m[1], pkg: m[2], version: m[3], file: m[4] };
};

export const isPinned = (version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);

const withTimeout = async (fn, ms) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
};

export const probeUrl = async (url, timeoutMs) => {
  try {
    const res = await withTimeout((signal) => fetch(url, { signal: signal, redirect: 'follow' }), timeoutMs || 15000);
    return { reachable: true, status: res.status, ok: res.status === 200 };
  } catch (err) {
    return { reachable: false, status: 0, ok: false, error: String(err && err.message ? err.message : err) };
  }
};

export const npmVersionExists = async (pkg, version, timeoutMs) => {
  const url = 'https://registry.npmjs.org/' + pkg.replace('/', '%2f') + '/' + version;
  try {
    const res = await withTimeout((signal) => fetch(url, { signal: signal }), timeoutMs || 15000);
    if (res.status !== 200) return { reachable: true, ok: false, status: res.status };
    const body = await res.json();
    return { reachable: true, ok: body.version === version, status: 200, tarball: body.dist && body.dist.tarball };
  } catch (err) {
    return { reachable: false, ok: false, status: 0, error: String(err && err.message ? err.message : err) };
  }
};

/* ---- minimal tar reader, so no npm install is ever needed ---- */
const readTar = (buf) => {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header[0] === 0) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeField = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8) || 0;
    const type = String.fromCharCode(header[156]);
    const start = offset + 512;
    if (type === '0' || type === '\0' || type === '') files.set(name, buf.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return files;
};

/**
 * Put `<prefix>` from pkg@version on disk under CACHE_DIR, preferring the
 * CDN URL itself and falling back to the npm tarball. Returns the local
 * directory, or null if neither source is reachable.
 */
export const vendorPackage = async (pkg, version, prefix, cacheRoot) => {
  const root = path.join(cacheRoot || CACHE_DIR, pkg.replace('/', '__') + '@' + version);
  const marker = path.join(root, '.complete');
  if (fs.existsSync(marker)) return root;

  const info = await npmVersionExists(pkg, version);
  if (!info.reachable || !info.tarball) return null;

  const res = await fetch(info.tarball);
  if (res.status !== 200) return null;
  const gz = Buffer.from(await res.arrayBuffer());
  const files = readTar(zlib.gunzipSync(gz));

  fs.mkdirSync(root, { recursive: true });
  let written = 0;
  for (const [name, data] of files) {
    const rel = name.replace(/^package\//, '');
    if (prefix && !rel.startsWith(prefix)) continue;
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written++;
  }
  if (written === 0) return null;
  fs.writeFileSync(marker, String(written));
  return root;
};

/** Names a module makes available to `import * as NS`. */
export const moduleExports = (source) => {
  const names = new Set();
  const braceRe = /export\s*\{([^}]*)\}/g;
  let m;
  while ((m = braceRe.exec(source))) {
    const parts = m[1].split(',');
    for (let i = 0; i < parts.length; i++) {
      const piece = parts[i].trim();
      if (!piece) continue;
      const asSplit = piece.split(/\s+as\s+/);
      names.add((asSplit[1] || asSplit[0]).trim());
    }
  }
  const declRe = /export\s+(?:default\s+)?(?:const|let|var|class|function\s*\*?)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;
  while ((m = declRe.exec(source))) names.add(m[1]);
  return names;
};

export const hasExportStar = (source) => /export\s*\*\s*from/.test(source);
