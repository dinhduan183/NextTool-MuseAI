const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const os = require('os');
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const { MuseSession, parseCookies, shutdown, loginInteractive } = require('./muse');

const PORT = process.env.PORT || 3456;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUT = path.join(ROOT, 'output');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(OUTPUT, { recursive: true });

const ACC_FILE = path.join(DATA, 'accounts.json');
const JOB_FILE = path.join(DATA, 'jobs.json');
const SET_FILE = path.join(DATA, 'settings.json');
const load = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; }
};
const save = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

const USAGE_TTL = 30 * 60 * 1000; // kiểm tra lại hạn mức nếu số liệu cũ hơn 30 phút
const EXHAUSTED_RECHECK = 6 * 60 * 60 * 1000; // tài khoản hết hạn mức: 6 tiếng thử lại 1 lần
const MAX_ATTEMPTS = 3;

let accounts = load(ACC_FILE, []);
let jobs = load(JOB_FILE, []);
let settings = Object.assign({ headless: true, timeoutMin: 10, wrapPrompt: true, notify: true }, load(SET_FILE, {}));
const HIST_FILE = path.join(DATA, 'history.json');
let history = Object.assign({ video: [], image: [] }, load(HIST_FILE, {}));
// Job đang chạy dở khi tắt tool → đưa về hàng chờ.
jobs.forEach((j) => {
  if (!j.kind) j.kind = 'video';
  if (!j.batch) j.batch = `old-${j.kind}-${Math.floor(j.createdAt / 60000)}`;
  if (j.status === 'running') j.status = 'queued';
  (j.images || []).forEach((i) => { if (!i.file && i.path) i.file = path.basename(i.path); });
});
accounts.forEach((a) => { if (a.status === 'checking') a.status = a.usage ? 'ok' : 'new'; });

// Dự án: mỗi dự án có danh sách video và thư mục output riêng.
const PROJ_FILE = path.join(DATA, 'projects.json');
let projects = load(PROJ_FILE, []);
const safeName = (s) => String(s).replace(/[\/\\:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'du-an';
function newProject(name) {
  const id = crypto.randomUUID();
  const p = { id, name, dir: `${safeName(name)}_${id.slice(0, 4)}`, createdAt: Date.now() };
  projects.push(p);
  return p;
}
if (!projects.length) newProject('Dự án 1');
// Video cũ (trước khi có dự án) → dự án đầu tiên, file vẫn ở thư mục output gốc.
jobs.forEach((j) => {
  if (!j.projectId) { j.projectId = projects[0].id; if (j.dir === undefined) j.dir = ''; }
});
// Video tạo trước khi có dự án đang nằm ở output/ gốc → chuyển vào thư mục dự án của nó.
jobs.forEach((j) => {
  if (j.file && !j.dir) {
    const p = projects.find((x) => x.id === j.projectId) || projects[0];
    const from = path.join(OUTPUT, j.file);
    if (fs.existsSync(from)) {
      fs.mkdirSync(path.join(OUTPUT, p.dir), { recursive: true });
      fs.renameSync(from, path.join(OUTPUT, p.dir, j.file));
      j.dir = p.dir;
    }
  }
});
const saveProj = () => save(PROJ_FILE, projects);
saveProj();
save(JOB_FILE, jobs);

const saveAcc = () => save(ACC_FILE, accounts);
const saveJobs = () => save(JOB_FILE, jobs);
const sessions = new Map(); // accountId -> MuseSession
const busy = new Set(); // accountId đang chạy job hoặc đang kiểm tra

const publicAcc = (a) => ({
  id: a.id, name: a.name, enabled: a.enabled, status: a.status, lastError: a.lastError,
  done: a.done || 0, busy: busy.has(a.id), usage: a.usage || null,
  running: jobs.find((j) => j.status === 'running' && j.accountId === a.id)?.id || null,
});

function buildPrompt(j) {
  if (!j.wrap) return j.prompt;
  const parts = [];
  if (j.kind !== 'image' && j.duration) parts.push(`dài ${j.duration} giây`);
  if (j.ratio) parts.push(`tỉ lệ ${j.ratio}`);
  const what = j.kind === 'image' ? 'Tạo ảnh' : 'Tạo video';
  return `${what}${parts.length ? ' ' + parts.join(', ') : ''}: ${j.prompt}`;
}

function getSession(acc) {
  let s = sessions.get(acc.id);
  if (!s || s.opts.headless !== settings.headless) {
    if (s) s.close();
    s = new MuseSession(acc, { headless: settings.headless });
    sessions.set(acc.id, s);
  }
  return s;
}
async function dropSession(acc) {
  const s = sessions.get(acc.id);
  if (s) { await s.close(); sessions.delete(acc.id); }
}

// Đọc hạn mức của tài khoản. Không tự đổi trạng thái busy (người gọi lo).
async function readUsage(acc) {
  const s = getSession(acc);
  try {
    acc.usage = await s.readUsage();
    acc.status = acc.usage.exhausted ? 'exhausted' : 'ok';
    acc.lastError = acc.usage.exhausted ? 'Đã hết hạn mức sử dụng' : null;
  } catch (e) {
    if (/cookie/i.test(e.message)) { acc.status = 'invalid'; acc.lastError = e.message; await dropSession(acc); }
    else acc.lastError = 'Không đọc được hạn mức: ' + e.message;
    throw e;
  } finally {
    saveAcc();
  }
}

async function checkAccount(acc) {
  if (busy.has(acc.id)) return;
  busy.add(acc.id);
  const prev = acc.status;
  acc.status = 'checking';
  try { await readUsage(acc); } catch { if (acc.status === 'checking') acc.status = prev === 'checking' ? 'new' : prev; }
  finally { busy.delete(acc.id); saveAcc(); tick(); }
}

async function runJob(acc, job) {
  busy.add(acc.id);
  job.status = 'running';
  job.accountId = acc.id;
  job.accountName = acc.name;
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.error = null;
  job.attempts = (job.attempts || 0) + 1;
  job.logs = job.logs || [];
  const log = (m) => { job.logs.push(`${new Date().toLocaleTimeString('vi-VN')} ${m}`); };
  saveJobs();
  let requeue = false;
  try {
    const s = getSession(acc);
    log(`Tài khoản "${acc.name}" nhận job (lần ${job.attempts})`);
    // Kiểm tra hạn mức trước khi chạy nếu số liệu đã cũ.
    if (!acc.usage || Date.now() - acc.usage.checkedAt > USAGE_TTL) {
      log('Kiểm tra hạn mức tài khoản…');
      await readUsage(acc).catch(() => {});
      if (acc.status === 'invalid') throw new Error(acc.lastError);
      if (acc.usage) log(`Hạn mức: đã dùng ${acc.usage.planUsed}%`);
    }
    if (acc.status === 'exhausted') {
      log(`Tài khoản "${acc.name}" đã hết hạn mức → chuyển sang tài khoản khác`);
      requeue = true;
      return;
    }
    const fileBase = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}_${job.id.slice(0, 6)}`;
    const proj = projects.find((p) => p.id === job.projectId) || projects[0];
    job.dir = proj.dir;
    const r = await s.generate({
      kind: job.kind || 'video',
      prompt: buildPrompt(job),
      images: (job.images || []).map((i) => path.join(UPLOADS, i.file)),
      outDir: path.join(OUTPUT, proj.dir),
      fileBase,
      timeoutMs: settings.timeoutMin * 60000,
      log,
    });
    job.status = 'done';
    job.file = path.basename(r.file);
    job.size = r.size;
    acc.status = 'ok';
    acc.lastError = null;
    acc.done = (acc.done || 0) + 1;
    log(`Xong: ${job.file} (${(r.size / 1048576).toFixed(1)} MB)`);
    // Cập nhật hạn mức sau mỗi video.
    await readUsage(acc).catch(() => {});
  } catch (e) {
    log(`Lỗi: ${e.message}`);
    if (/cookie/i.test(e.message)) {
      acc.status = 'invalid';
      acc.lastError = e.message;
      await dropSession(acc);
      requeue = true; // để tài khoản khác làm
    } else {
      // Không ra video: xem có phải do hết hạn mức không.
      if (e.timeout) {
        await readUsage(acc).catch(() => {});
        if (acc.status === 'exhausted') {
          log(`Tài khoản "${acc.name}" đã hết hạn mức → chuyển sang tài khoản khác`);
          requeue = true;
        }
      } else {
        await dropSession(acc); // trang có thể đang ở trạng thái lạ, mở lại cho lần sau
      }
      if (!requeue) {
        job.status = 'error';
        job.error = e.message;
      }
    }
  } finally {
    if (requeue) {
      if (job.attempts >= MAX_ATTEMPTS) {
        job.status = 'error';
        job.error = `Đã thử ${job.attempts} lần không thành công`;
      } else {
        job.status = 'queued';
        job.accountId = null;
        job.accountName = null;
      }
    }
    job.finishedAt = job.status === 'queued' ? null : Date.now();
    busy.delete(acc.id);
    if (job.status !== 'queued') notifyBatch(job.batch);
    saveJobs();
    saveAcc();
    setImmediate(tick);
  }
}

// Báo bằng thông báo macOS khi mọi mục của 1 lượt tạo đã xong (thành công hoặc lỗi).
function notifyBatch(batch) {
  if (!settings.notify || !batch) return;
  const js = jobs.filter((j) => j.batch === batch);
  if (!js.length || js.some((j) => j.status === 'queued' || j.status === 'running')) return;
  const ok = js.filter((j) => j.status === 'done').length, err = js.length - ok;
  const what = js[0].kind === 'image' ? 'ảnh' : 'video';
  const msg = `Xong ${ok}/${js.length} ${what}` + (err ? ` · ${err} lỗi` : '');
  const proj = projects.find((p) => p.id === js[0].projectId);
  systemNotify('NextTool - Muse AI', proj ? proj.name : '', msg);
}

// ---- Hỗ trợ cả macOS / Windows / Linux ----
// Thông báo hệ thống (macOS: Notification Center, Windows: toast, Linux: notify-send).
function systemNotify(title, subtitle, msg) {
  const clean = (t) => String(t || '').replace(/["'`\\$<>&]/g, '');
  if (IS_MAC) {
    execFile('/usr/bin/osascript', ['-e', `display notification "${clean(msg)}" with title "${clean(title)}" subtitle "${clean(subtitle)}" sound name "Glass"`], () => {});
  } else if (IS_WIN) {
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast><visual><binding template="ToastGeneric"><text>${clean(title)}</text><text>${clean(msg)}</text><text>${clean(subtitle)}</text></binding></visual></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true }, () => {});
  } else {
    execFile('notify-send', [clean(title) + (subtitle ? ' — ' + clean(subtitle) : ''), clean(msg)], () => {});
  }
}

// Mở thư mục / chỉ ra file trong Finder / Explorer.
function revealPath(target, isFile) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: false };
  let cmd, args;
  if (IS_MAC) { cmd = 'open'; args = isFile ? ['-R', target] : [target]; }
  else if (IS_WIN) { cmd = 'explorer.exe'; args = isFile ? ['/select,', target] : [target]; }
  else { cmd = 'xdg-open'; args = [isFile ? path.dirname(target) : target]; }
  try { spawn(cmd, args, opts).on('error', () => {}).unref(); } catch {}
}

// Mở trình duyệt mặc định.
function openBrowser(url) {
  let cmd, args;
  if (IS_MAC) { cmd = 'open'; args = [url]; }
  else if (IS_WIN) { cmd = 'explorer.exe'; args = [url]; }
  else { cmd = 'xdg-open'; args = [url]; }
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
}

// Tự viết file .zip (kiểu "store", không nén — video/ảnh đã nén sẵn), không cần lệnh zip của hệ điều hành.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
async function fileCrc(file) {
  let c = 0xffffffff;
  for await (const chunk of fs.createReadStream(file)) for (let i = 0; i < chunk.length; i++) c = CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function writeZip(out, files) {
  const ws = fs.createWriteStream(out);
  const write = (b) => new Promise((ok, no) => ws.write(b, (e) => (e ? no(e) : ok())));
  const pipeFile = (f) => new Promise((ok, no) => { const rs = fs.createReadStream(f); rs.on('error', no); rs.on('end', ok); rs.pipe(ws, { end: false }); });
  const d = new Date(), dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const used = new Set(), central = [];
  let offset = 0;
  for (const f of files) {
    let name = path.basename(f), i = 1;
    while (used.has(name)) name = path.basename(f, path.extname(f)) + `_${i++}` + path.extname(f);
    used.add(name);
    const nameBuf = Buffer.from(name, 'utf8'), size = fs.statSync(f).size, crc = await fileCrc(f);
    if (offset + size > 0xfffffff0) throw new Error('Tổng dung lượng vượt 4 GB, hãy chọn ít file hơn');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    await write(h); await write(nameBuf); await pipeFile(f);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + size;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  await write(cd); await write(e);
  await new Promise((ok) => ws.end(ok));
}

function usable(a) {
  if (!a.enabled || busy.has(a.id) || a.status === 'invalid') return false;
  if (a.status === 'exhausted') {
    // Thử kiểm tra lại định kỳ, có thể hạn mức đã được đặt lại.
    if (!a.usage || Date.now() - a.usage.checkedAt > EXHAUSTED_RECHECK) checkAccount(a);
    return false;
  }
  return true;
}

// Mỗi tài khoản chạy 1 job một lúc; nhiều tài khoản chạy song song.
function tick() {
  for (const acc of accounts) {
    if (!usable(acc)) continue;
    const job = jobs.find((j) => j.status === 'queued');
    if (!job) return;
    runJob(acc, job);
  }
}
setInterval(tick, 60000);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/output', express.static(OUTPUT));
app.use('/uploads', express.static(UPLOADS));
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, f, cb) => cb(null, crypto.randomUUID() + (path.extname(f.originalname || '') || '.png')),
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

app.get('/api/state', (req, res) => {
  res.json({ accounts: accounts.map(publicAcc), projects, jobs: jobs.slice().reverse(), settings, history, platform: process.platform, update });
});

app.post('/api/accounts', (req, res) => {
  const { name, cookie } = req.body || {};
  try {
    if (!parseCookies(cookie).length) throw new Error('Không đọc được cookie nào');
  } catch (e) {
    return res.status(400).json({ error: 'Cookie sai định dạng: ' + e.message });
  }
  const acc = { id: crypto.randomUUID(), name: name || `Tài khoản ${accounts.length + 1}`, cookie, enabled: true, status: 'new', done: 0 };
  accounts.push(acc);
  saveAcc();
  checkAccount(acc); // kiểm tra ngay cookie + hạn mức
  res.json(publicAcc(acc));
});

// Đăng nhập trên tool: mở cửa sổ muse.ai, người dùng tự đăng nhập, tool lấy cookie.
// Body: { id? (đăng nhập lại tài khoản có sẵn), name? (tên cho tài khoản mới) }
let loginBusy = false;
app.post('/api/accounts/login', async (req, res) => {
  if (loginBusy) return res.status(409).json({ error: 'Đang có 1 cửa sổ đăng nhập mở rồi' });
  const { id, name } = req.body || {};
  const acc = id ? accounts.find((a) => a.id === id) : null;
  if (id && !acc) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  if (acc && busy.has(acc.id)) return res.status(409).json({ error: 'Tài khoản đang bận, thử lại sau' });
  loginBusy = true;
  try {
    const cookie = await loginInteractive();
    if (acc) {
      if (name && name.trim()) acc.name = name.trim();
      acc.cookie = cookie; acc.status = 'new'; acc.lastError = null; acc.usage = null;
      await dropSession(acc);
      saveAcc(); checkAccount(acc); tick();
      return res.json(publicAcc(acc));
    }
    const a = { id: crypto.randomUUID(), name: (name && name.trim()) || `Tài khoản ${accounts.length + 1}`, cookie, enabled: true, status: 'new', done: 0 };
    accounts.push(a);
    saveAcc(); checkAccount(a);
    res.json(publicAcc(a));
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    loginBusy = false;
  }
});

app.patch('/api/accounts/:id', async (req, res) => {
  const acc = accounts.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).end();
  const { name, cookie, enabled } = req.body || {};
  if (name !== undefined && name.trim()) acc.name = name.trim();
  if (enabled !== undefined) acc.enabled = !!enabled;
  if (cookie) {
    if (busy.has(acc.id)) return res.status(409).json({ error: 'Tài khoản đang bận, thử lại sau' });
    try { parseCookies(cookie); } catch (e) { return res.status(400).json({ error: e.message }); }
    acc.cookie = cookie;
    acc.status = 'new';
    acc.lastError = null;
    acc.usage = null;
    await dropSession(acc);
    checkAccount(acc);
  }
  saveAcc();
  tick();
  res.json(publicAcc(acc));
});

app.post('/api/accounts/:id/check', (req, res) => {
  const acc = accounts.find((a) => a.id === req.params.id);
  if (!acc) return res.status(404).end();
  if (busy.has(acc.id)) return res.status(409).json({ error: 'Tài khoản đang bận' });
  checkAccount(acc);
  res.json({ ok: true });
});

app.post('/api/accounts/check-all', (req, res) => {
  accounts.filter((a) => a.enabled && !busy.has(a.id)).forEach(checkAccount);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', async (req, res) => {
  if (busy.has(req.params.id)) return res.status(409).json({ error: 'Tài khoản đang bận' });
  const acc = accounts.find((a) => a.id === req.params.id);
  if (acc) await dropSession(acc);
  accounts = accounts.filter((a) => a.id !== req.params.id);
  saveAcc();
  res.json({ ok: true });
});

// Tạo job. items = [{ prompt, images: [chỉ số file upload] }], mỗi item × count = số video.
app.post('/api/jobs', upload.array('images', 50), (req, res) => {
  let items;
  try { items = JSON.parse(req.body.items || '[]'); } catch { return res.status(400).json({ error: 'Dữ liệu sai' }); }
  const files = (req.files || []).map((f) => ({ file: path.basename(f.path), name: f.originalname }));
  items = items.filter((it) => String(it.prompt || '').trim());
  if (!items.length) return res.status(400).json({ error: 'Chưa có prompt nào' });
  const count = Math.max(1, Math.min(20, parseInt(req.body.count) || 1));
  const proj = projects.find((p) => p.id === req.body.projectId);
  if (!proj) return res.status(400).json({ error: 'Chưa chọn dự án' });
  const batch = crypto.randomUUID().slice(0, 8);
  let n = 0;
  for (const it of items) {
    for (let i = 0; i < count; i++) {
      jobs.push({
        id: crypto.randomUUID(), batch, projectId: proj.id, kind: req.body.kind === 'image' ? 'image' : 'video',
        prompt: String(it.prompt).trim(),
        images: (it.images || []).map((k) => files[k]).filter(Boolean),
        ratio: req.body.ratio || '', duration: req.body.kind === 'image' ? '' : req.body.duration || '',
        wrap: settings.wrapPrompt !== false,
        status: 'queued', createdAt: Date.now(), attempts: 0, logs: [],
      });
      n++;
    }
  }
  // Lịch sử prompt (mới nhất lên đầu, không trùng, tối đa 300).
  const kind = req.body.kind === 'image' ? 'image' : 'video';
  for (const it of items.slice().reverse()) {
    const pr = String(it.prompt).trim();
    history[kind] = [pr, ...history[kind].filter((x) => x !== pr)].slice(0, 300);
  }
  save(HIST_FILE, history);
  saveJobs();
  tick();
  res.json({ created: n });
});

const resetJob = (j) => Object.assign(j, { status: 'queued', error: null, logs: [], attempts: 0, accountId: null, accountName: null, finishedAt: null });

app.post('/api/jobs/:id/retry', (req, res) => {
  const j = jobs.find((x) => x.id === req.params.id);
  if (!j || j.status === 'running') return res.status(400).end();
  if (j.status === 'done') {
    // Tạo lại = thêm 1 job mới cùng thông số, giữ video cũ.
    jobs.push(resetJob({ ...j, id: crypto.randomUUID(), file: null, dir: null, size: null, startedAt: null, createdAt: Date.now() }));
  } else resetJob(j);
  saveJobs();
  tick();
  res.json({ ok: true });
});

app.post('/api/jobs/retry-errors', (req, res) => {
  const pid = req.body && req.body.projectId;
  jobs.filter((j) => j.status === 'error' && (!pid || j.projectId === pid)).forEach(resetJob);
  saveJobs();
  tick();
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  const j = jobs.find((x) => x.id === req.params.id);
  if (j && j.status === 'running') return res.status(409).json({ error: 'Job đang chạy' });
  jobs = jobs.filter((x) => x.id !== req.params.id);
  saveJobs();
  res.json({ ok: true });
});

app.post('/api/jobs/clear', (req, res) => {
  const which = (req.body && req.body.which) || 'finished';
  const pid = req.body && req.body.projectId;
  const drop = { finished: ['done', 'error'], done: ['done'], error: ['error'], queued: ['queued'] }[which] || [];
  jobs = jobs.filter((j) => !(drop.includes(j.status) && (!pid || j.projectId === pid)));
  saveJobs();
  res.json({ ok: true });
});

// Xoá nhiều mục khỏi danh sách (file vẫn giữ).
app.post('/api/jobs/delete', (req, res) => {
  const ids = new Set((req.body && req.body.ids) || []);
  jobs = jobs.filter((j) => !(ids.has(j.id) && j.status !== 'running'));
  saveJobs();
  res.json({ ok: true });
});

// Gói nhiều file thành 1 file zip để tải về.
app.post('/api/jobs/zip', (req, res) => {
  const ids = new Set((req.body && req.body.ids) || []);
  const files = jobs.filter((j) => ids.has(j.id) && j.file).map((j) => path.join(OUTPUT, j.dir || '', j.file)).filter((f) => fs.existsSync(f));
  if (!files.length) return res.status(400).json({ error: 'Không có file nào để tải' });
  const tmp = path.join(os.tmpdir(), `toolmuse-${Date.now()}.zip`);
  writeZip(tmp, files)
    .then(() => res.download(tmp, `NextTool-${files.length}-file.zip`, () => fs.unlink(tmp, () => {})))
    .catch((e) => { fs.unlink(tmp, () => {}); res.status(500).json({ error: 'Không tạo được file zip: ' + e.message }); });
});

// ---- Dự án ----
app.post('/api/projects', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim() || `Dự án ${projects.length + 1}`;
  const p = newProject(name);
  saveProj();
  res.json(p);
});

app.patch('/api/projects/:id', (req, res) => {
  const p = projects.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).end();
  const name = String((req.body && req.body.name) || '').trim();
  if (name) p.name = name; // thư mục giữ nguyên để không làm mất đường dẫn video cũ
  saveProj();
  res.json(p);
});

// Xoá dự án: chỉ bỏ khỏi tool, file video vẫn nằm trong thư mục output.
app.delete('/api/projects/:id', (req, res) => {
  if (projects.length <= 1) return res.status(400).json({ error: 'Phải còn ít nhất 1 dự án' });
  if (jobs.some((j) => j.projectId === req.params.id && ['queued', 'running'].includes(j.status)))
    return res.status(409).json({ error: 'Dự án còn video đang chờ hoặc đang tạo' });
  projects = projects.filter((p) => p.id !== req.params.id);
  jobs = jobs.filter((j) => j.projectId !== req.params.id);
  saveProj();
  saveJobs();
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const { headless, timeoutMin, wrapPrompt, notify } = req.body || {};
  if (headless !== undefined) settings.headless = !!headless;
  if (wrapPrompt !== undefined) settings.wrapPrompt = !!wrapPrompt;
  if (notify !== undefined) settings.notify = !!notify;
  if (timeoutMin) settings.timeoutMin = Math.max(1, Math.min(60, +timeoutMin));
  save(SET_FILE, settings);
  res.json(settings);
});

app.post('/api/open-output', (req, res) => {
  const { jobId, projectId } = req.body || {};
  const j = jobId && jobs.find((x) => x.id === jobId && x.file);
  const p = projectId && projects.find((x) => x.id === projectId);
  let target = OUTPUT, reveal = false;
  if (j) { target = path.join(OUTPUT, j.dir || '', j.file); reveal = true; }
  else if (p) { target = path.join(OUTPUT, p.dir); fs.mkdirSync(target, { recursive: true }); }
  if (!path.resolve(target).startsWith(path.resolve(OUTPUT))) return res.status(400).end();
  revealPath(target, reveal);
  res.json({ ok: true });
});

// ---- Cập nhật phiên bản mới từ GitHub ----
const UPDATE_REPO = 'dinhduan183/NextTool-MuseAI';
const UPDATE_BRANCH = 'main';
const UPDATE_EVERY = 6 * 60 * 60 * 1000; // 6 tiếng kiểm tra 1 lần
const PKG = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const KEEP = new Set(['data', 'output', 'node_modules', '.git', '.claude']); // không bao giờ ghi đè
let update = { current: PKG().version, latest: null, available: false, checkedAt: 0, error: null, busy: false, canRestart: !!process.env.TM_LAUNCHER };

const verNum = (v) => String(v || '0').split('.').map((x) => parseInt(x, 10) || 0);
function newer(a, b) {
  const x = verNum(a), y = verNum(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}
async function checkUpdate() {
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${UPDATE_REPO}/${UPDATE_BRANCH}/package.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('GitHub trả về ' + r.status);
    const remote = await r.json();
    update.latest = remote.version;
    update.notes = remote.changelog || '';
    update.available = newer(remote.version, update.current);
    update.error = null;
  } catch (e) {
    update.error = 'Không kiểm tra được bản mới: ' + e.message;
  }
  update.checkedAt = Date.now();
  return update;
}
function copyTree(src, dst, top = true) {
  for (const name of fs.readdirSync(src)) {
    if (top && KEEP.has(name)) continue;
    const a = path.join(src, name), b = path.join(dst, name);
    if (fs.statSync(a).isDirectory()) { fs.mkdirSync(b, { recursive: true }); copyTree(a, b, false); }
    else fs.copyFileSync(a, b);
  }
}
const run = (cmd, args, opts = {}) => new Promise((ok, no) =>
  execFile(cmd, args, { maxBuffer: 1 << 24, ...opts }, (e, so, se) => (e ? no(new Error((se || e.message).toString().trim().split('\n').pop())) : ok(so))));
async function applyUpdate() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexttool-'));
  try {
    const r = await fetch(`https://codeload.github.com/${UPDATE_REPO}/tar.gz/refs/heads/${UPDATE_BRANCH}`);
    if (!r.ok) throw new Error('Tải bản mới thất bại (' + r.status + ')');
    const tgz = path.join(tmp, 'src.tar.gz');
    fs.writeFileSync(tgz, Buffer.from(await r.arrayBuffer()));
    const dir = path.join(tmp, 'src');
    fs.mkdirSync(dir);
    // Windows 10+ có sẵn tar.exe; gọi đúng bản của Windows để tránh nhầm tar của Git Bash.
    const winTar = IS_WIN && path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await run(winTar && fs.existsSync(winTar) ? winTar : 'tar', ['-xzf', tgz, '-C', dir, '--strip-components=1']);
    const next = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const before = JSON.stringify(PKG().dependencies || {});
    copyTree(dir, ROOT);
    if (JSON.stringify(next.dependencies || {}) !== before) {
      await run(IS_WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, shell: IS_WIN });
    }
    return next.version;
  } finally {
    fs.rm(tmp, { recursive: true, force: true }, () => {});
  }
}
checkUpdate();
setInterval(checkUpdate, UPDATE_EVERY);

app.get('/api/update', async (req, res) => {
  if (req.query.force) await checkUpdate();
  res.json(update);
});
app.post('/api/update/apply', async (req, res) => {
  if (update.busy) return res.status(409).json({ error: 'Đang cập nhật' });
  if (jobs.some((j) => j.status === 'running')) return res.status(409).json({ error: 'Đang có video/ảnh đang tạo — chờ xong rồi cập nhật' });
  update.busy = true;
  try {
    const v = await applyUpdate();
    update.current = v; update.available = false;
    res.json({ ok: true, version: v, restarting: update.canRestart });
    if (update.canRestart) setTimeout(async () => { await shutdown().catch(() => {}); process.exit(42); }, 500);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    update.busy = false;
  }
});

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`NextTool - Muse AI đang chạy: ${url}`);
  if (!process.env.NO_OPEN) openBrowser(url);
  tick();
});

const stop = async () => { await shutdown(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
