// dump-game-scripts.mjs — saves the JavaScript the running Molili window has loaded.
// Read-only: it asks the game for its scripts and writes them to a folder. It does not change the game.
// Run it while the game is open (started with start-molili-local.bat, which opens the debugging port 9222).
//   node dump-game-scripts.mjs            -> writes ./game-scripts/
//   node dump-game-scripts.mjs 9222 out   -> port and output folder
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.argv[2] || '9222';
const OUT = path.resolve(process.argv[3] || 'game-scripts');

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json().catch(() => {
  console.error(`Could not reach the game's debugging port ${PORT}. Start the game with start-molili-local.bat first.`);
  process.exit(1);
});
const page = targets.find(t => t.type === 'page' && /tauri\.localhost|molili/i.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) { console.error('No game window found.'); process.exit(1); }
console.log('window:', page.url.slice(0, 80));

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id; pending.set(n, { resolve, reject }); ws.send(JSON.stringify({ id: n, method, params }));
});
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
};
await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = () => bad(new Error('websocket failed')); });

// The page's own resource list: every script, style and file the window loaded (read-only).
await send('Page.enable');
const { frameTree } = await send('Page.getResourceTree');
const resources = [];
const walk = f => {
  for (const r of f.resources || []) resources.push({ frameId: f.frame.id, url: r.url, type: r.type });
  for (const c of f.childFrames || []) walk(c);
};
walk(frameTree);

const isScript = r => /^https?:/.test(r.url) && (r.type === 'Script' || /\.(js|mjs|css|html|json)(\?|#|$)/i.test(r.url));
fs.mkdirSync(OUT, { recursive: true });
const index = [];
for (const r of resources.filter(isScript)) {
  try {
    const { content, base64Encoded } = await send('Page.getResourceContent', { frameId: r.frameId, url: r.url });
    const u = new URL(r.url);
    let rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const dest = path.join(OUT, rel.replace(/[<>:"|?*]/g, '_'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, base64Encoded ? Buffer.from(content, 'base64') : content);
    index.push({ file: path.relative(OUT, dest), url: r.url, type: r.type, bytes: (base64Encoded ? Buffer.from(content, 'base64') : Buffer.from(content)).length });
  } catch (e) { index.push({ url: r.url, error: e.message }); }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2));
ws.close();
const saved = index.filter(x => x.file).length;
console.log(`saved ${saved} file(s) to ${OUT}` + (saved < index.length ? ` (${index.length - saved} could not be read, see index.json)` : ''));
console.log(`search them with: grep -rl "suggest/latest\\|enableFollowUp" "${OUT}"`);
