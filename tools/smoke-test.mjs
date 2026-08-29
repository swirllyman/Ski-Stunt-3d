#!/usr/bin/env node
/**
 * Ski Stunt 3D — headless smoke test.
 *
 *   node tools/smoke-test.mjs [--file index.html] [--base <git-ref>]
 *                             [--no-boot] [--quiet]
 *
 * Mandatory before every push (SKI_STUNT_3D_PIPELINE.md section 8).
 * Claude Code cannot see the game, so this answers the only question it
 * can answer without eyes: will the page load at all, and does the
 * CONFIG/debug-panel contract still hold.
 *
 * Exits non-zero if any check fails. Prints a markdown block at the end
 * that goes straight into the PR description.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import vm from 'node:vm';

import {
  GLOBALS, extractScripts, stripLiterals, collectDeclarations, collectReferences,
  collectMemberUse, extractLiteral, flatten,
} from './lib/scan.mjs';
import {
  CACHE_DIR, parseImportMap, parseCdnUrl, isPinned, probeUrl, npmVersionExists,
  vendorPackage, moduleExports,
} from './lib/deps.mjs';
import { bootCheck, findChromium } from './lib/boot.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const FILE = argValue('--file', 'index.html');
const BASE = argValue('--base', null);
const MARKDOWN = argValue('--markdown', null);
const SKIP_BOOT = argv.includes('--no-boot');
const QUIET = argv.includes('--quiet');

const results = [];
const record = (id, name, status, detail, lines) => {
  results.push({ id: id, name: name, status: status, detail: detail, lines: lines || [] });
};

const say = (text) => { if (!QUIET) console.log(text); };

/* ------------------------------------------------------------------ */
const html = fs.readFileSync(FILE, 'utf8');
const scripts = extractScripts(html);
const moduleScript = scripts.find((s) => s.type === 'module');
const classicScripts = scripts.filter((s) => s.type !== 'module' && s.type !== 'importmap');

if (!moduleScript) {
  console.error('FATAL: ' + FILE + ' has no <script type="module"> block.');
  process.exit(1);
}
const src = moduleScript.code;
const stripped = stripLiterals(src);

/* ------------------------------------------------------------------ *
 * 1. Parse check
 * ------------------------------------------------------------------ */
const parseCheck = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ski-parse-'));
  const problems = [];
  const checkOne = (code, file, label) => {
    const full = path.join(tmp, file);
    fs.writeFileSync(full, code);
    try {
      execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
    } catch (err) {
      const text = (err.stderr ? err.stderr.toString() : String(err)).trim();
      problems.push(label + ': ' + text.split('\n').filter((l) => l.includes('Error') || l.includes('^')).slice(0, 2).join(' | '));
    }
  };
  checkOne(src, 'module.mjs', 'module script');
  classicScripts.forEach((s, i) => checkOne(s.code, 'classic' + i + '.cjs', 'classic script #' + (i + 1)));

  const mapScript = scripts.find((s) => s.type === 'importmap');
  if (!mapScript) problems.push('no <script type="importmap"> block');
  else {
    try { JSON.parse(mapScript.code); } catch (err) { problems.push('import map is not valid JSON: ' + err.message); }
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  if (problems.length) record(1, 'Parse', 'FAIL', problems.length + ' script(s) failed to parse', problems);
  else record(1, 'Parse', 'PASS', (scripts.length - 1) + ' script block(s) + import map parse clean');
};

/* ------------------------------------------------------------------ *
 * 2. Import resolution
 * ------------------------------------------------------------------ */
const importMap = parseImportMap(html) || { imports: {} };
const entries = Object.entries(importMap.imports || {});
const resolvedModules = new Map();
const vendored = new Map();

const importCheck = async () => {
  const problems = [];
  const lines = [];
  if (entries.length === 0) problems.push('the import map declares no imports');

  for (const [specifier, url] of entries) {
    if (specifier.endsWith('/')) {
      problems.push(specifier + ' is a prefix mapping — the smoke test cannot verify it; map exact files only');
      continue;
    }
    const parsed = parseCdnUrl(url);
    if (!parsed) {
      problems.push(specifier + ' -> ' + url + ' is not a recognised pinned npm CDN URL');
      continue;
    }
    if (!isPinned(parsed.version)) {
      problems.push(specifier + ' is pinned to "' + parsed.version + '" — exact versions only, never a range or a tag');
      continue;
    }

    const direct = await probeUrl(url);
    if (direct.ok) {
      lines.push(specifier + ' -> 200 (' + parsed.pkg + '@' + parsed.version + ')');
      resolvedModules.set(specifier, { parsed: parsed, url: url, via: 'cdn' });
      continue;
    }
    if (direct.reachable && direct.status === 404) {
      problems.push(specifier + ' -> HTTP 404 at ' + url + ' (wrong package, version or file path)');
      continue;
    }

    /* Anything else — a sandbox egress denial (403/407), a gateway error,
       a dead socket — is about this machine, not about the pin. jsDelivr
       serves the npm tarball verbatim, so check the pin there instead and
       confirm the exact file exists inside the published package. */
    const why = direct.reachable ? 'HTTP ' + direct.status : (direct.error || 'no route');
    const prefix = parsed.file.split('/')[0] + '/';
    const root = await vendorPackage(parsed.pkg, parsed.version, prefix, CACHE_DIR);
    if (!root) {
      const npm = await npmVersionExists(parsed.pkg, parsed.version);
      if (npm.reachable && !npm.ok) problems.push(specifier + ' -> ' + parsed.pkg + '@' + parsed.version + ' does not exist on npm');
      else problems.push(specifier + ' -> unverifiable (' + why + ' from the CDN, and the npm registry is unreachable too)');
      continue;
    }
    if (!fs.existsSync(path.join(root, parsed.file))) {
      problems.push(specifier + ' -> ' + parsed.pkg + '@' + parsed.version + ' does not contain ' + parsed.file);
      continue;
    }
    vendored.set(specifier, { root: root, file: parsed.file, pkg: parsed.pkg, version: parsed.version });
    lines.push(specifier + ' -> CDN blocked here (' + why + '); ' + parsed.pkg + '@' + parsed.version + '/' + parsed.file + ' confirmed in the published npm package');
    resolvedModules.set(specifier, { parsed: parsed, url: url, via: 'npm' });
  }

  if (problems.length) record(2, 'Import resolution', 'FAIL', problems.length + ' import(s) unresolved', problems.concat(lines));
  else if (Array.from(resolvedModules.values()).some((m) => m.via === 'npm')) {
    record(2, 'Import resolution', 'WARN', 'pins verified against npm (CDN blocked from this sandbox)', lines);
  } else record(2, 'Import resolution', 'PASS', entries.length + ' pinned import(s) return 200', lines);
};

/* ------------------------------------------------------------------ *
 * 3. Symbol check
 * ------------------------------------------------------------------ */
const loadModuleSource = async (specifier) => {
  const entry = resolvedModules.get(specifier);
  if (!entry) return null;
  const cached = vendored.get(specifier);
  if (cached) {
    const hit = path.join(cached.root, cached.file);
    if (fs.existsSync(hit)) return { text: fs.readFileSync(hit, 'utf8'), root: cached.root, file: cached.file };
  }
  if (entry.via === 'cdn') {
    const res = await fetch(entry.url);
    if (res.status === 200) return { text: await res.text(), root: null, file: entry.parsed.file };
  }
  const prefix = entry.parsed.file.split('/')[0] + '/';
  const root = await vendorPackage(entry.parsed.pkg, entry.parsed.version, prefix, CACHE_DIR);
  if (!root) return null;
  vendored.set(specifier, { root: root, file: entry.parsed.file, pkg: entry.parsed.pkg, version: entry.parsed.version });
  const full = path.join(root, entry.parsed.file);
  if (!fs.existsSync(full)) return null;
  return { text: fs.readFileSync(full, 'utf8'), root: root, file: entry.parsed.file };
};

const symbolCheck = async () => {
  const problems = [];
  const lines = [];

  /* 3a. free identifiers that are never bound anywhere */
  const declared = collectDeclarations(stripped);
  const refs = collectReferences(stripped);
  const unknown = [];
  for (const [name, line] of refs) {
    if (declared.has(name) || GLOBALS.has(name)) continue;
    unknown.push(name + ' (module script line ' + line + ')');
  }
  for (const script of classicScripts) {
    const cs = stripLiterals(script.code);
    const csDeclared = collectDeclarations(cs);
    for (const [name, line] of collectReferences(cs)) {
      if (csDeclared.has(name) || GLOBALS.has(name)) continue;
      unknown.push(name + ' (classic script, line ' + (script.line + line) + ')');
    }
  }
  if (unknown.length) problems.push('undefined reference(s): ' + unknown.join(', '));
  else lines.push(declared.size + ' bindings cover every free identifier');

  /* 3b. namespace members that the pinned module does not export */
  const nsRe = /import\s*\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*['"]([^'"]+)['"]/g;
  let m;
  const namespaces = [];
  while ((m = nsRe.exec(src))) namespaces.push({ alias: m[1], specifier: m[2] });

  const namedRe = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  const named = [];
  while ((m = namedRe.exec(src))) {
    named.push({ names: m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean), specifier: m[2] });
  }

  for (const ns of namespaces) {
    const mod = await loadModuleSource(ns.specifier);
    if (!mod) {
      lines.push(ns.alias + ': export list unavailable (module source not reachable) — member use unverified');
      continue;
    }
    const exported = moduleExports(mod.text);
    const used = collectMemberUse(stripped, ns.alias);
    const missing = [];
    for (const [name, line] of used) if (!exported.has(name)) missing.push(name + ' (line ' + line + ')');
    if (missing.length) problems.push(ns.alias + ' has no export named: ' + missing.join(', '));
    else lines.push(ns.alias + ': ' + used.size + '/' + exported.size + ' exports used, all present');
  }

  for (const group of named) {
    const mod = await loadModuleSource(group.specifier);
    if (!mod) continue;
    const exported = moduleExports(mod.text);
    const missing = group.names.filter((n) => !exported.has(n));
    if (missing.length) problems.push(group.specifier + ' has no export named: ' + missing.join(', '));
  }

  if (problems.length) record(3, 'Symbols', 'FAIL', problems.length + ' problem(s)', problems.concat(lines));
  else record(3, 'Symbols', 'PASS', 'no undefined references, no missing module exports', lines);
};

/* ------------------------------------------------------------------ *
 * 4. CONFIG integrity
 * ------------------------------------------------------------------ */
let configLeaves = new Map();

const configCheck = () => {
  const problems = [];
  const lines = [];

  const configLit = extractLiteral(src, 'const CONFIG =', '{', '}');
  const panelLit = extractLiteral(src, 'const PANEL_SPEC =', '[', ']');
  if (!configLit) { record(4, 'CONFIG integrity', 'FAIL', 'no `const CONFIG = { ... }` found'); return; }
  if (!panelLit) { record(4, 'CONFIG integrity', 'FAIL', 'no `const PANEL_SPEC = [ ... ]` found'); return; }

  let config;
  try {
    config = vm.runInNewContext('(' + configLit.text + ')', Object.create(null), { timeout: 1000 });
  } catch (err) {
    record(4, 'CONFIG integrity', 'FAIL', 'CONFIG is not a plain evaluable literal: ' + err.message);
    return;
  }
  configLeaves = flatten(config, '');

  /* every panel path must resolve to a CONFIG leaf */
  const paramRe = /\{\s*path:\s*'([^']+)'([^}]*)\}/g;
  const panelPaths = new Map();
  let m;
  while ((m = paramRe.exec(panelLit.text))) {
    const p = m[1];
    if (panelPaths.has(p)) problems.push('panel lists ' + p + ' twice');
    const opts = m[2];
    const num = (key) => {
      const hit = opts.match(new RegExp(key + ':\\s*(-?[0-9.eE+-]+)'));
      return hit ? Number(hit[1]) : null;
    };
    panelPaths.set(p, { min: num('min'), max: num('max'), step: num('step') });
  }
  if (panelPaths.size === 0) problems.push('PANEL_SPEC declares no parameters');

  for (const [p, range] of panelPaths) {
    if (!configLeaves.has(p)) { problems.push('panel references CONFIG.' + p + ', which does not exist'); continue; }
    const value = configLeaves.get(p);
    if (typeof value !== 'number') { problems.push('CONFIG.' + p + ' is not a number, so it cannot be a slider'); continue; }
    if (range.min === null || range.max === null || range.step === null) { problems.push(p + ' is missing min/max/step'); continue; }
    if (range.min >= range.max) problems.push(p + ' has min >= max');
    if (range.step <= 0) problems.push(p + ' has a non-positive step');
    if (value < range.min || value > range.max) problems.push('committed CONFIG.' + p + ' = ' + value + ' sits outside the slider range [' + range.min + ', ' + range.max + ']');
  }

  /* every CONFIG leaf must be read by the game, not just declared */
  const outside = stripped.slice(0, configLit.start) + ' '.repeat(configLit.text.length) +
    stripped.slice(configLit.end, panelLit.start) + ' '.repeat(panelLit.text.length) +
    stripped.slice(panelLit.end);
  const unread = [];
  for (const p of configLeaves.keys()) {
    if (!outside.includes('CONFIG.' + p)) unread.push(p);
  }
  if (unread.length) problems.push('CONFIG key(s) never read as CONFIG.<path>: ' + unread.join(', '));

  const orphanPanel = Array.from(configLeaves.keys()).filter((p) => !panelPaths.has(p));
  lines.push(configLeaves.size + ' CONFIG leaves, ' + panelPaths.size + ' on the panel');
  if (orphanPanel.length) lines.push('not exposed on the panel (fine, but note it): ' + orphanPanel.join(', '));

  if (problems.length) record(4, 'CONFIG integrity', 'FAIL', problems.length + ' contract violation(s)', problems.concat(lines));
  else record(4, 'CONFIG integrity', 'PASS', 'panel and CONFIG agree in both directions', lines);
};

/* ------------------------------------------------------------------ *
 * 5. Structural check
 * ------------------------------------------------------------------ */
const structuralCheck = () => {
  const problems = [];
  const lines = [];

  const canvases = html.match(/<canvas\b/gi) || [];
  if (canvases.length !== 1) problems.push('expected exactly 1 <canvas>, found ' + canvases.length);
  else lines.push('one canvas element');

  if (!/^\s*<!doctype html>/i.test(html)) problems.push('missing <!doctype html>');

  if (!/\bboot\(\);/.test(stripped)) problems.push('the entry point boot() is never invoked');
  else lines.push('entry point boot() is invoked at top level');

  const gate = /const\s+DEBUG\s*=\s*new\s+URLSearchParams\(location\.search\)\.get\(\s*['"]debug['"]\s*\)\s*===\s*['"]1['"]/;
  if (!gate.test(src)) problems.push('DEBUG is not derived from ?debug=1 in the expected form');

  const panelCalls = (stripped.match(/\bcreateDebugPanel\(\)/g) || []).length;
  if (panelCalls !== 1) problems.push('createDebugPanel() should be called exactly once, found ' + panelCalls);
  else if (!/if\s*\(\s*DEBUG\s*\)\s*createDebugPanel\(\);/.test(stripped)) {
    problems.push('createDebugPanel() is called outside an `if (DEBUG)` gate');
  } else lines.push('debug panel is gated behind ?debug=1');

  if (/id="debug"/.test(html.slice(0, moduleScript.start))) {
    problems.push('the debug panel exists in static markup, so it would ship visible');
  }

  if (!/window\.__ski\s*=/.test(src)) problems.push('window.__ski liveness probe is missing (the boot check needs it)');

  if (problems.length) record(5, 'Structure', 'FAIL', problems.length + ' problem(s)', problems.concat(lines));
  else record(5, 'Structure', 'PASS', 'canvas, entry point and debug gate all as specified', lines);
};

/* ------------------------------------------------------------------ *
 * 6. Diff sanity
 * ------------------------------------------------------------------ */
const EXPECTED = [/^index\.html$/, /^[A-Z0-9_]+\.md$/, /^README\.md$/, /^tools\//, /^\.github\//, /^\.gitignore$/];

const diffCheck = () => {
  /* Note the .replace and not .trim(): `git status --porcelain` puts the
   * status in the first two columns, so an unstaged change starts with a
   * space. Trimming the whole blob ate that space on the first line only,
   * and every path it reported was missing its first character. */
  const git = (args) => {
    try { return execSync('git ' + args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().replace(/\n+$/, ''); }
    catch (err) { return null; }
  };
  const porcelainPaths = (text) =>
    (text || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const rest = line.slice(3);
        const renamed = rest.split(' -> ');
        return renamed[renamed.length - 1];
      });
  let base = BASE;
  if (!base) {
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      if (git('rev-parse --verify --quiet ' + candidate)) { base = candidate; break; }
    }
  }
  let files = [];
  let how = '';
  if (base) {
    const committed = (git('diff --name-only ' + base + '...HEAD') || '').split('\n');
    files = committed.concat(porcelainPaths(git('status --porcelain')));
    how = 'vs ' + base + ' plus working tree';
  } else {
    files = porcelainPaths(git('status --porcelain'));
    how = 'no base branch yet — listing the working tree';
  }
  files = Array.from(new Set(files.map((f) => f.trim()).filter(Boolean)));

  const unexpected = files.filter((f) => !EXPECTED.some((re) => re.test(f)));
  const lines = [how, files.length ? 'touched: ' + files.join(', ') : 'nothing touched'];
  if (unexpected.length) record(6, 'Diff sanity', 'WARN', 'files outside the usual set: ' + unexpected.join(', '), lines);
  else record(6, 'Diff sanity', 'PASS', files.length + ' file(s), all in the expected set', lines);
};

/* ------------------------------------------------------------------ *
 * 7. Boot check (best effort)
 * ------------------------------------------------------------------ */
const runBootCheck = async () => {
  if (SKIP_BOOT) { record(7, 'Boot (headless)', 'SKIP', '--no-boot'); return; }
  if (!findChromium()) { record(7, 'Boot (headless)', 'SKIP', 'no Chromium available in this environment'); return; }

  let localHtml = html;
  const missing = [];
  for (const [specifier, url] of entries) {
    const entry = resolvedModules.get(specifier);
    if (!entry) { missing.push(specifier); continue; }
    let info = vendored.get(specifier);
    if (!info) {
      const prefix = entry.parsed.file.split('/')[0] + '/';
      const root = await vendorPackage(entry.parsed.pkg, entry.parsed.version, prefix, CACHE_DIR);
      if (!root) { missing.push(specifier); continue; }
      info = { root: root, file: entry.parsed.file };
      vendored.set(specifier, info);
    }
    const rel = path.relative(path.resolve(CACHE_DIR), path.resolve(info.root));
    localHtml = localHtml.split('"' + url + '"').join('"/vendor/' + rel + '/' + entry.parsed.file + '"');
  }
  if (missing.length) {
    record(7, 'Boot (headless)', 'SKIP', 'could not vendor ' + missing.join(', ') + ' for local serving');
    return;
  }

  const plain = await bootCheck(localHtml, CACHE_DIR, { debug: false });
  if (plain.skipped) { record(7, 'Boot (headless)', 'SKIP', plain.reason); return; }
  const debug = await bootCheck(localHtml, CACHE_DIR, { debug: true });

  const notes = plain.notes.concat(debug.notes.map((n) => '?debug=1: ' + n));
  const errors = plain.errors.concat(debug.errors.map((e) => '?debug=1: ' + e));
  if (errors.length) record(7, 'Boot (headless)', 'FAIL', errors.length + ' runtime problem(s)', errors.concat(notes));
  else record(7, 'Boot (headless)', 'PASS', 'page boots and keeps rendering in headless Chromium', notes);
};

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */
const MARK = { PASS: 'ok  ', FAIL: 'FAIL', WARN: 'warn', SKIP: 'skip' };

const report = () => {
  say('');
  say('Ski Stunt 3D — smoke test (' + FILE + ')');
  say('-'.repeat(64));
  for (const r of results) {
    say('[' + MARK[r.status] + '] ' + r.id + '. ' + r.name + ' — ' + r.detail);
    for (const line of r.lines) say('        ' + line);
  }
  say('-'.repeat(64));

  const failed = results.filter((r) => r.status === 'FAIL');
  say(failed.length ? failed.length + ' CHECK(S) FAILED — do not push' : 'all checks green');
  const table = ['| # | Check | Result |', '|---|---|---|'];
  for (const r of results) {
    const icon = r.status === 'PASS' ? 'pass' : r.status === 'FAIL' ? '**fail**' : r.status.toLowerCase();
    table.push('| ' + r.id + ' | ' + r.name + ' | ' + icon + ' — ' + r.detail.replace(/\|/g, '/') + ' |');
  }

  say('');
  say('--- paste into the PR description ---');
  for (const line of table) say(line);
  say('');

  /* CI writes this straight into the job summary, which is the one build
   * signal that is legible on the GitHub mobile app. */
  if (MARKDOWN) {
    const detail = results
      .filter((r) => r.lines.length)
      .map((r) => '**' + r.id + '. ' + r.name + '**\n' + r.lines.map((l) => '- ' + l).join('\n'))
      .join('\n\n');
    fs.writeFileSync(
      MARKDOWN,
      '### Smoke test — ' + (failed.length ? failed.length + ' check(s) failed' : 'all checks green') + '\n\n' +
        table.join('\n') + '\n\n<details><summary>Detail</summary>\n\n' + detail + '\n\n</details>\n'
    );
  }
  return failed.length === 0;
};

const main = async () => {
  parseCheck();
  await importCheck();
  await symbolCheck();
  configCheck();
  structuralCheck();
  diffCheck();
  await runBootCheck();
  process.exit(report() ? 0 : 1);
};

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
