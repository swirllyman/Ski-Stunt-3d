/**
 * Optional boot check: serve the page with locally vendored copies of
 * the pinned CDN modules, open it in headless Chromium over the DevTools
 * protocol, and assert that it actually starts and keeps rendering.
 *
 * The pipeline doc assumes Claude Code has no browser. Where one happens
 * to be installed this closes the last gap in "does it load" — and where
 * one is not, the check reports SKIP and the mandatory checks stand alone.
 *
 * No dependencies: Node 22 ships a WebSocket client, which is all CDP needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';

export const findChromium = () => {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const roots = ['/opt/pw-browsers', path.join(os.homedir(), '.cache/ms-playwright')];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root)) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const candidate = path.join(root, entry, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const candidate of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

const serve = (html, vendorRoot) =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      if (url === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url === '/' || url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
        return;
      }
      if (url.startsWith('/vendor/')) {
        const target = path.join(vendorRoot, url.slice('/vendor/'.length));
        if (target.startsWith(path.resolve(vendorRoot)) && fs.existsSync(target) && fs.statSync(target).isFile()) {
          res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
          res.end(fs.readFileSync(target));
          return;
        }
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server: server, port: server.address().port }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const connectCdp = async (wsUrl) => {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });
  const send = (method, params, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: resolve, reject: reject });
      socket.send(JSON.stringify({ id: id, method: method, params: params || {}, sessionId: sessionId }));
    });
  return { send: send, on: (fn) => listeners.push(fn), close: () => socket.close() };
};

const launch = async (binary, port, profileDir) => {
  const child = spawn(binary, [
    '--headless=new',
    '--no-sandbox',
    '--no-proxy-server',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=900,700',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + port,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(250);
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/version');
      if (res.status === 200) {
        const body = await res.json();
        if (body.webSocketDebuggerUrl) return { child: child, wsUrl: body.webSocketDebuggerUrl };
      }
    } catch (err) { /* not up yet */ }
    if (child.exitCode !== null) break;
  }
  child.kill('SIGKILL');
  throw new Error('Chromium did not expose a DevTools endpoint. ' + stderr.split('\n').slice(-4).join(' '));
};

/**
 * Serve `html`, open it in headless Chromium and hand the caller a
 * live page. Everything above is plumbing; this is the useful surface.
 *
 * The callback receives { evaluate, sleep, errors, url }. Console errors
 * and uncaught exceptions accumulate in `errors` for the duration.
 */
export const withPage = async (html, vendorRoot, options, fn) => {
  const opts = options || {};
  const binary = findChromium();
  if (!binary) return { skipped: true, reason: 'no Chromium binary found', errors: [] };

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ski-boot-'));
  const { server, port } = await serve(html, path.resolve(vendorRoot));
  const debugPort = 9000 + Math.floor(Math.random() * 4000);
  let browser = null;
  const errors = [];

  try {
    browser = await launch(binary, debugPort, profileDir);
    const cdp = await connectCdp(browser.wsUrl);
    const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const session = attached.sessionId;

    cdp.on((msg) => {
      if (msg.sessionId !== session) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push('uncaught: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push('console.error: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        errors.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
      }
    });

    await cdp.send('Runtime.enable', {}, session);
    await cdp.send('Log.enable', {}, session);
    await cdp.send('Page.enable', {}, session);

    const evaluate = async (expression) => {
      const res = await cdp.send('Runtime.evaluate', { expression: expression, returnByValue: true, awaitPromise: false }, session);
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
      return res.result ? res.result.value : undefined;
    };

    const url = 'http://127.0.0.1:' + port + '/' + (opts.debug ? '?debug=1' : '');
    await cdp.send('Page.navigate', { url: url }, session);

    const value = await fn({ evaluate: evaluate, sleep: sleep, errors: errors, url: url });
    return { skipped: false, errors: errors, value: value };
  } catch (err) {
    return { skipped: false, errors: errors.concat([String(err && err.message ? err.message : err)]), value: null };
  } finally {
    if (browser && browser.child) browser.child.kill('SIGKILL');
    server.close();
    /* Chromium can still be flushing its profile as it dies, so a plain
     * rmSync races it and throws ENOTEMPTY. The temp dir is disposable. */
    await sleep(150);
    try {
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) { /* the OS will reap it */ }
  }
};

/**
 * @returns {Promise<{ok: boolean, notes: string[], errors: string[]}>}
 */
export const bootCheck = async (html, vendorRoot, options) => {
  const opts = options || {};
  const notes = [];

  const outcome = await withPage(html, vendorRoot, opts, async (page) => {
    let probe = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.sleep(250);
      const raw = await page.evaluate('JSON.stringify(window.__ski ? { booted: window.__ski.booted, frames: window.__ski.frames, gl: window.__ski.gl, error: window.__ski.error } : null)');
      probe = raw ? JSON.parse(raw) : null;
      if (probe && probe.booted) break;
    }
    if (!probe || !probe.booted) {
      page.errors.push('window.__ski.booted never became true — the page did not start');
      return null;
    }

    notes.push('booted, WebGL context ' + (probe.gl ? 'acquired' : 'MISSING'));
    if (!probe.gl) page.errors.push('renderer has no WebGL context');

    const framesAtStart = probe.frames;
    await page.sleep(2500);
    const after = JSON.parse(await page.evaluate('JSON.stringify({ frames: window.__ski.frames, error: window.__ski.error })'));
    notes.push('rendered ' + (after.frames - framesAtStart) + ' frames in 2.5s');
    if (after.frames - framesAtStart < 20) page.errors.push('render loop stalled (' + (after.frames - framesAtStart) + ' frames in 2.5s)');
    if (after.error) page.errors.push('page reported a fatal error: ' + String(after.error).split('\n')[0]);

    if (await page.evaluate("document.getElementById('boot-error').style.display === 'block'")) {
      page.errors.push('the in-page boot-error panel is visible');
    }

    const panelPresent = await page.evaluate("!!document.getElementById('debug')");
    if (opts.debug && !panelPresent) page.errors.push('?debug=1 did not create the debug panel');
    if (!opts.debug && panelPresent) page.errors.push('the debug panel rendered without ?debug=1');
    notes.push(opts.debug ? 'debug panel present under ?debug=1' : 'debug panel absent without ?debug=1');

    if (opts.debug) {
      const sliders = await page.evaluate("document.querySelectorAll('#debug input[type=range]').length");
      notes.push(sliders + ' sliders wired');
      if (!sliders) page.errors.push('the debug panel rendered no sliders');
    }
    return true;
  });

  if (outcome.skipped) return { skipped: true, reason: outcome.reason, notes: [], errors: [] };
  return { skipped: false, ok: outcome.errors.length === 0, notes: notes, errors: outcome.errors };
};
