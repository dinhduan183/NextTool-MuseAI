// Điều khiển muse.ai qua trình duyệt ngầm (Playwright).
// Muse gửi chat qua WebSocket mã hoá nên không gọi API trực tiếp được —
// tool gõ prompt vào ô chat, chờ video mới xuất hiện rồi tải blob mp4 về.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MUSE_URL = 'https://muse.ai/';
const INPUT_SEL = 'textarea[placeholder]';
const FILE_SEL = 'input[type=file]';
// User-agent khớp hệ điều hành đang chạy (Windows / macOS / Linux).
const USER_AGENT = `Mozilla/5.0 (${
  process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36`;

let browser = null;
let browserHeadless = null;

async function getBrowser(headless) {
  if (browser && browserHeadless === headless && browser.isConnected()) return browser;
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  browserHeadless = headless;
  return browser;
}

// Nhận cookie dạng JSON (Cookie-Editor / EditThisCookie export) hoặc chuỗi "a=b; c=d".
function parseCookies(raw) {
  raw = String(raw || '').trim();
  if (!raw) throw new Error('Cookie trống');
  if (raw.startsWith('[') || raw.startsWith('{')) {
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = arr.cookies || [arr];
    return arr
      .filter((c) => c.name && c.value !== undefined)
      .map((c) => {
        const out = {
          name: c.name,
          value: String(c.value),
          domain: c.domain || 'muse.ai',
          path: c.path || '/',
          httpOnly: !!c.httpOnly,
          secure: c.secure !== false,
        };
        const exp = c.expirationDate || c.expires;
        if (exp && exp > 0) out.expires = Math.floor(exp);
        const ss = String(c.sameSite || '').toLowerCase();
        out.sameSite = ss === 'strict' ? 'Strict' : ss === 'lax' ? 'Lax' : 'None';
        if (out.sameSite === 'None') out.secure = true;
        return out;
      });
  }
  const s = raw.replace(/^cookie:\s*/i, '');
  return s
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return {
        name: p.slice(0, i).trim(),
        value: p.slice(i + 1).trim(),
        url: MUSE_URL,
        secure: true,
        sameSite: 'Lax',
      };
    })
    .filter((c) => c.name);
}

// Tách số liệu từ đoạn text "Mức sử dụng".
// VD: "Mức sử dụng\nGói miễn phí\nGiới hạn hàng tuần sẽ đặt lại vào 17 tháng 11\nĐã dùng 17%\nToken bổ sung\n…Đã dùng 0% (còn 31 tỷ token)\nNâng cấp"
function parseUsage(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  let i = lines.findIndex((l) => /^(Mức sử dụng|Usage)$/.test(l));
  const end = lines.findIndex((l, k) => k > i && /^(Nâng cấp|Upgrade)/.test(l));
  const sec = lines.slice(i + 1, end > 0 ? end : undefined);
  const pctIdx = sec.map((l, k) => (/\d+\s*%/.test(l) ? k : -1)).filter((k) => k >= 0);
  const pct = (l) => parseInt(l.match(/(\d+)\s*%/)[1], 10);
  const u = { plan: sec[0] || '', checkedAt: Date.now() };
  if (pctIdx[0] !== undefined) {
    u.planUsed = pct(sec[pctIdx[0]]);
    u.reset = sec.slice(1, pctIdx[0]).join(' · ');
  }
  if (pctIdx[1] !== undefined) {
    const l = sec[pctIdx[1]];
    u.extraName = sec[pctIdx[0] + 1] || 'Token bổ sung';
    u.extraUsed = pct(l);
    const m = l.match(/\(([^)]+)\)/);
    u.extraLeft = m ? m[1] : '';
  }
  u.exhausted = u.planUsed >= 100 && (u.extraUsed === undefined || u.extraUsed >= 100);
  return u;
}

// Mỗi tài khoản giữ 1 context + 1 tab muse.ai.
class MuseSession {
  constructor(account, opts) {
    this.account = account;
    this.opts = opts;
    this.context = null;
    this.page = null;
  }

  async open() {
    if (this.page && !this.page.isClosed()) return;
    const b = await getBrowser(this.opts.headless);
    this.context = await b.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'vi-VN',
      userAgent:
        USER_AGENT,
    });
    await this.context.addCookies(parseCookies(this.account.cookie));
    this.page = await this.context.newPage();
    await this.page.goto(MUSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await this.page.waitForSelector(INPUT_SEL, { state: 'visible', timeout: 45000 });
    } catch {
      await this.close();
      throw new Error('Không vào được ô chat — cookie hết hạn hoặc không hợp lệ');
    }
    // Ô chat hiện trước khi Muse kết nối xong; gửi sớm sẽ bị nuốt mất.
    await this.page
      .getByText(/Đã kết nối|Connected/)
      .first()
      .waitFor({ state: 'visible', timeout: 40000 })
      .catch(() => {});
    await this.page.waitForTimeout(2000);
  }

  // Gửi prompt, xác nhận ô nhập đã được xoá (tin đã đi); thử lại tối đa 3 lần.
  async sendPrompt(prompt, log) {
    const box = this.page.locator(INPUT_SEL).first();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await box.click();
      await box.fill('');
      await this.page.keyboard.insertText(prompt);
      await this.page.waitForTimeout(500);
      await box.press('Enter');
      const sent = await this.page
        .waitForFunction((sel) => !document.querySelector(sel)?.value.trim(), INPUT_SEL, { timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (sent) return;
      log(`Muse chưa nhận tin nhắn, thử gửi lại (${attempt}/3)`);
      await this.page.waitForTimeout(4000);
    }
    throw new Error('Muse không nhận tin nhắn (đã thử gửi 3 lần)');
  }

  // Đọc "Mức sử dụng" trong Cài đặt của Muse (số liệu này đi qua kênh mã hoá nên phải đọc từ giao diện).
  async readUsage() {
    await this.open();
    const page = this.page;
    await page.keyboard.press('Escape').catch(() => {});
    const raw = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const btn = document.querySelector('button[aria-haspopup="menu"][aria-label="Cài đặt"], button[aria-haspopup="menu"][aria-label="Settings"]');
      if (!btn) return { err: 'Không thấy nút Cài đặt' };
      btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
      btn.click();
      await sleep(800);
      const item = [...document.querySelectorAll('[role=menuitem]')].find((m) => /Cài đặt|Settings/.test(m.innerText));
      if (!item) return { err: 'Không mở được menu Cài đặt' };
      item.click();
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        const dlg = document.querySelector('[role=dialog]');
        const h = dlg && [...dlg.querySelectorAll('h1,h2,h3')].find((e) => /^(Mức sử dụng|Usage)$/.test(e.textContent.trim()));
        if (h) {
          let blk = h;
          for (let k = 0; k < 3 && blk.innerText.length < 60; k++) blk = blk.parentElement;
          if (/\d+\s*%/.test(blk.innerText)) return { text: blk.innerText };
        }
      }
      return { err: 'Không đọc được mục Mức sử dụng' };
    });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
    if (raw.err) throw new Error(raw.err);
    return parseUsage(raw.text);
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    this.context = null;
    this.page = null;
  }

  // Đánh dấu bong bóng tin nhắn chứa prompt vừa gửi (cái cuối cùng trong trang).
  async markSentMessage(prompt, marker) {
    return this.page.evaluate(
      ({ prompt, marker }) => {
        const norm = (s) => s.replace(/\s+/g, ' ').trim();
        const want = norm(prompt);
        const box = document.querySelector('textarea[placeholder]');
        const hits = [...document.querySelectorAll('body *')].filter(
          (el) =>
            el.children.length === 0 || [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
        ).filter((el) => !el.contains(box) && el !== box && norm(el.textContent || '') === want);
        if (!hits.length) return false;
        document.querySelectorAll(`[data-tm-sent]`).forEach((e) => e.removeAttribute('data-tm-sent'));
        hits[hits.length - 1].setAttribute('data-tm-sent', marker);
        return true;
      },
      { prompt, marker }
    );
  }

  // Video trong khung chat, nằm SAU tin nhắn đã đánh dấu, đã tải được metadata.
  async videosAfterMarker(marker) {
    return this.page.evaluate((marker) => {
      const anchor = document.querySelector(`[data-tm-sent="${marker}"]`);
      if (!anchor) return { videos: [], images: [], reply: '' };
      const after = (n) => anchor.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING;
      const outside = (el) =>
        !el.closest('[data-hatch-avatar-host]') &&
        !el.closest('[data-testid^="hatch-status-panel"]') &&
        !el.closest('[role="complementary"]') &&
        !el.closest('[role="dialog"]') &&
        !el.closest('form') &&
        !el.closest('textarea');
      const videos = [...document.querySelectorAll('video')]
        .filter((v) => outside(v) && after(v) && (v.currentSrc || v.src) && v.readyState >= 1 && v.duration > 0)
        .map((v) => v.currentSrc || v.src);
      // Ảnh Muse tạo ra: nằm trong nút "Mở hình ảnh đã tạo …" (ảnh tham chiếu mình tải lên không có nhãn này).
      const images = [...document.querySelectorAll('img')]
        .filter((i) => {
          if (!outside(i) || !after(i) || !i.complete || !i.naturalWidth) return false;
          const b = i.closest('button,[role="button"]');
          return !!b && /hình ảnh đã tạo|generated image/i.test(b.getAttribute('aria-label') || '');
        })
        .map((i) => i.currentSrc || i.src);
      // Chữ Muse trả lời sau tin nhắn của mình (để hiện trong nhật ký).
      const parts = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        const t = n.textContent.trim();
        if (t && after(n) && n.parentElement && outside(n.parentElement) && n.parentElement.offsetParent !== null) parts.push(t);
      }
      return { videos, images, reply: parts.join(' ').slice(0, 400) };
    }, marker);
  }

  async generate({ kind = 'video', prompt, images = [], outDir, fileBase, timeoutMs, log }) {
    const what = kind === 'image' ? 'ảnh' : 'video';
    await this.open();
    const page = this.page;
    const marker = fileBase;
    this.lastReply = '';

    if (images.length) {
      log(`Đính ${images.length} ảnh tham chiếu`);
      await page.setInputFiles(FILE_SEL, images);
      await page.waitForTimeout(2500 + images.length * 1500);
    }

    await this.sendPrompt(prompt, log);
    log(`Đã gửi prompt, đang chờ Muse tạo ${what}…`);

    const deadline = Date.now() + timeoutMs;
    const markDeadline = Date.now() + 30000;
    let marked = false;
    let found = null;
    let lastReply = '';
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      if (!marked) {
        marked = await this.markSentMessage(prompt, marker);
        if (!marked && Date.now() > markDeadline) break;
        if (!marked) continue;
      }
      const { videos, images: imgs, reply } = await this.videosAfterMarker(marker);
      const media = kind === 'image' ? imgs : videos;
      if (reply && reply !== lastReply) {
        lastReply = reply;
        this.lastReply = reply;
      }
      if (media.length) {
        found = media[media.length - 1];
        break;
      }
    }
    if (!marked) throw new Error('Không thấy tin nhắn vừa gửi trong khung chat');
    if (lastReply) {
      const norm = (s) => s.replace(/\s+/g, ' ').trim();
      let r = norm(lastReply);
      const p = norm(prompt);
      if (r.startsWith(p)) r = r.slice(p.length);
      r = r.replace(/^[\s👍]+/u, '').replace(/\s*(Nhắn tin|Message)$/i, '').trim();
      if (r) log(`Muse trả lời: ${r}`);
    }
    if (!found) {
      const e = new Error(`Hết thời gian chờ (${Math.round(timeoutMs / 60000)} phút) mà chưa thấy ${what}`);
      e.timeout = true;
      throw e;
    }

    // Chờ blob tải xong rồi lấy dữ liệu file.
    await page.waitForTimeout(1500);
    const { b64, type } = await page.evaluate(async (src) => {
      const blob = await (await fetch(src)).blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { b64: btoa(bin), type: blob.type };
    }, found);
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 10000) throw new Error(`File ${what} tải về quá nhỏ, có thể lỗi`);
    const ext = kind === 'image' ? ({ 'image/png': '.png', 'image/jpeg': '.jpg' }[type] || '.webp') : '.mp4';
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${fileBase}${ext}`);
    fs.writeFileSync(file, buf);
    return { file, size: buf.length };
  }
}

async function shutdown() {
  if (browser) await browser.close().catch(() => {});
}


// Mở cửa sổ Chromium thật để người dùng tự đăng nhập muse.ai; đăng nhập xong thì trả về cookie (JSON).
// Mật khẩu gõ thẳng vào trang muse.ai, tool không đọc. Đóng cửa sổ = huỷ.
async function loginInteractive({ timeoutMs = 10 * 60000 } = {}) {
  const b = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  try {
    const ctx = await b.newContext({
      viewport: null,
      locale: 'vi-VN',
      userAgent:
        USER_AGENT,
    });
    const page = await ctx.newPage();
    await page.goto(MUSE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!b.isConnected() || ctx.pages().length === 0) throw new Error('Đã đóng cửa sổ đăng nhập');
      const cookies = await ctx.cookies().catch(() => []);
      const p = ctx.pages()[0];
      const hasChat = p ? await p.locator(INPUT_SEL).first().isVisible().catch(() => false) : false;
      if (hasChat && cookies.some((c) => c.name === 'hatch_sess')) {
        await new Promise((r) => setTimeout(r, 2000)); // chờ cookie ghi xong
        const all = (await ctx.cookies()).filter((c) => /muse\.ai$/.test(c.domain.replace(/^\./, '')));
        return JSON.stringify(all.map((c) => ({ ...c, expirationDate: c.expires > 0 ? c.expires : undefined })));
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error('Hết 10 phút chờ đăng nhập');
  } finally {
    await b.close().catch(() => {});
  }
}

module.exports = { MuseSession, parseCookies, parseUsage, shutdown, loginInteractive };
