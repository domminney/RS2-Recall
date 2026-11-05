const http = require('http');
const fs = require('fs');
const path = require('path');

const { Engine, listDevices } = require('./audio');
const engine = new Engine();
process.on('SIGINT', async () => { await engine.stop(); process.exit(0); });
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const SESSIONS = path.join(__dirname, 'sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const safeName = (n) => String(n).replace(/[^\w\- ]/g, '').trim().slice(0, 80);
const sessionFile = (n) => path.join(SESSIONS, safeName(n) + '.json');

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20e6) { reject(new Error('too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/devices' && req.method === 'GET') return send(res, 200, listDevices());
    if (url.pathname === '/api/live' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const write = (m) => res.write(`data: ${JSON.stringify(m)}\n\n`);
      write({ type: 'status', ...engine.status });
      engine.listeners.add(write);
      req.on('close', () => engine.listeners.delete(write));
      return;
    }
    if (url.pathname === '/api/start' && req.method === 'POST') {
      await engine.start(JSON.parse(await readBody(req)));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/comp/run' && req.method === 'POST') {
      await engine.runComp(JSON.parse(await readBody(req)));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/config' && req.method === 'POST') {
      engine.configure(JSON.parse(await readBody(req)));
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      await engine.stop();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/rename' && req.method === 'POST') {
      const { from, to } = JSON.parse(await readBody(req));
      const src = sessionFile(from), dst = sessionFile(to), name = safeName(to);
      if (!name) return send(res, 400, { error: 'name required' });
      if (!fs.existsSync(src)) return send(res, 404, { error: 'not found' });
      if (src !== dst && fs.existsSync(dst)) return send(res, 409, { error: 'A session with that name already exists.' });
      const data = JSON.parse(fs.readFileSync(src));
      data.name = name;
      const tmp = dst + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, dst);
      if (src !== dst) fs.unlinkSync(src);
      return send(res, 200, { name });
    }
    const m = url.pathname.match(/^\/api\/sessions(?:\/([^/]+))?$/);
    if (m) {
      const name = m[1] && safeName(decodeURIComponent(m[1]));
      if (!name && req.method === 'GET') {
        const list = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'))
          .map((f) => ({ name: f.slice(0, -5), mtime: fs.statSync(path.join(SESSIONS, f)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime).map((s) => s.name);
        return send(res, 200, list);
      }
      if (!name) return send(res, 400, { error: 'name required' });
      if (req.method === 'GET') {
        if (!fs.existsSync(sessionFile(name))) return send(res, 404, { error: 'not found' });
        return send(res, 200, fs.readFileSync(sessionFile(name)));
      }
      if (req.method === 'PUT') {
        const body = await readBody(req);
        JSON.parse(body);
        const tmp = sessionFile(name) + '.tmp';
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, sessionFile(name));
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, 404, 'Not found', 'text/plain');
    }
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Recall running at http://localhost:${PORT}`));
