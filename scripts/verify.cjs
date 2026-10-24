'use strict';
// Fast static checks for Voxa. Run with: npm run verify
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', '.venv', 'reference', '.claude']);
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full); else files.push(full);
  }
})(root);

const rel = (f) => path.relative(root, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');
const js = files.filter((f) => /\.(cjs|js|mjs)$/.test(f));
const isRenderer = (f) => rel(f).startsWith('renderer/');
const problems = [];
const warnings = [];

// 1. Syntax of every JS file
for (const f of js) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`syntax: ${rel(f)}\n${(r.stderr || '').trim()}`);
}

// 2. IPC: every channel the renderer calls must have a handler in main
const grab = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const mainFiles = js.filter((f) => !isRenderer(f) && rel(f) !== 'preload.cjs' && !rel(f).startsWith('scripts/') && !/selftest/.test(rel(f)));
const clientFiles = js.filter((f) => isRenderer(f) || rel(f) === 'preload.cjs');
const handled = new Set(), sent = new Set(), invoked = new Set(), listened = new Set();
for (const f of mainFiles) {
  const t = read(f);
  grab(t, /ipcMain\.(?:handle|on|once)\(\s*['"`]([^'"`]+)['"`]/g).forEach((c) => handled.add(c));
  grab(t, /webContents\.send\(\s*['"`]([^'"`]+)['"`]/g).forEach((c) => sent.add(c));
}
for (const f of clientFiles) {
  const t = read(f);
  grab(t, /ipcRenderer\.(?:invoke|send|sendSync)\(\s*['"`]([^'"`]+)['"`]/g).forEach((c) => invoked.add(c));
  grab(t, /ipcRenderer\.(?:on|once)\(\s*['"`]([^'"`]+)['"`]/g).forEach((c) => listened.add(c));
}
for (const c of invoked) if (!handled.has(c)) problems.push(`IPC: preload/renderer calls "${c}" but main has no handler`);
for (const c of listened) if (!sent.has(c)) warnings.push(`IPC: renderer listens to "${c}" but main never sends it (or sends it via a variable)`);
for (const c of sent) if (!listened.has(c)) warnings.push(`IPC: main sends "${c}" but nothing listens`);
for (const c of handled) if (!invoked.has(c)) warnings.push(`IPC: main handles "${c}" but nothing calls it`);

// 3. Top-level renderer names that shadow browser globals (caused the history.replaceState crash)
const BAD = 'history|location|screen|event|status|name|top|parent|self';
for (const f of js.filter(isRenderer)) {
  const t = read(f);
  for (const m of t.matchAll(new RegExp('^(?:const|let|var|function)\\s+(' + BAD + ')\\b', 'gm'))) {
    problems.push(`globals: ${rel(f)} declares top-level "${m[1]}", which shadows a browser global`);
  }
  const n = (t.match(/\.innerHTML\s*=/g) || []).length;
  if (n) warnings.push(`html: ${rel(f)} assigns innerHTML ${n}x (escape user text; never use it on animated elements)`);
}

// 4. Possible leaked keys anywhere in the repo
const SECRET = /(sk-[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,}|freellmapi-[0-9a-f]{20,})/;
for (const f of files.filter((x) => /\.(cjs|js|mjs|json|md|html|css|py|txt|ya?ml)$/.test(x) && !/package-lock/.test(x))) {
  const m = read(f).match(SECRET);
  if (m) problems.push(`secrets: possible key in ${rel(f)} (${m[0].slice(0, 6)}...)`);
}

// 5. Electron security settings
for (const f of mainFiles) {
  const t = read(f);
  if (/nodeIntegration\s*:\s*true/.test(t)) problems.push(`electron: nodeIntegration is true in ${rel(f)}`);
  if (/contextIsolation\s*:\s*false/.test(t)) problems.push(`electron: contextIsolation is false in ${rel(f)}`);
  if (/webSecurity\s*:\s*false/.test(t)) problems.push(`electron: webSecurity is false in ${rel(f)}`);
}

// 6. Overlay rules: never take focus, never resize per state
for (const f of js.filter((x) => /overlay/.test(rel(x)))) {
  const t = read(f);
  if (/\.focus\(\s*\)/.test(t)) warnings.push(`overlay: ${rel(f)} calls focus(); the island must never take focus`);
  if (/\.(setBounds|setSize)\(/.test(t)) warnings.push(`overlay: ${rel(f)} moves/resizes the window; fine for repositioning, not for state changes`);
}

// 7. Python server syntax
const venvPy = path.join(root, 'whisper-server', '.venv', 'Scripts', 'python.exe');
const py = fs.existsSync(venvPy) ? venvPy : 'python';
const pr = spawnSync(py, ['-m', 'py_compile', path.join(root, 'whisper-server', 'server.py')], { encoding: 'utf8' });
if (pr.error) warnings.push('python: not found, skipped server.py check');
else if (pr.status !== 0) problems.push(`python: server.py\n${(pr.stderr || '').trim()}`);

// 8. Verify services exports
const servicesContent = read(path.join(root, 'lib', 'services.cjs'));
const exportedServices = new Set(grab(servicesContent, /^\s*(\w+),?\s*$/gm));
for (const f of mainFiles) {
  const t = read(f);
  for (const m of t.matchAll(/services\.(\w+)/g)) {
    if (!exportedServices.has(m[1])) {
      warnings.push(`services: ${rel(f)} calls services.${m[1]} which is not exported from lib/services.cjs`);
    }
  }
}

// 9. Project self-test, static part only (bounded)
const st = spawnSync('npm', ['run', 'selftest', '--', '--static-only'], { cwd: root, encoding: 'utf8', shell: true, timeout: 120000 });
if (st.error || st.status !== 0) {
  problems.push('selftest (static-only) failed or timed out\n' + ((st.stdout || '') + (st.stderr || '')).split('\n').slice(-15).join('\n'));
}

console.log(`\nChecked ${js.length} JS files.`);
warnings.forEach((w) => console.log('WARN  ' + w));
problems.forEach((p) => console.log('FAIL  ' + p));
console.log(problems.length ? `\n${problems.length} problem(s) found.` : '\nAll static checks passed (this does not replace a manual test).');
process.exit(problems.length ? 1 : 0);