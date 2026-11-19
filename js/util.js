/* ============================================================
   util.js · 基础工具
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = (AH.util = {});

  U.qs = (sel, root) => (root || document).querySelector(sel);
  U.qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  U.esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  U.escAttr = U.esc;

  U.clamp = (n, min, max) => Math.min(max, Math.max(min, n));

  U.uid = (prefix) =>
    (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  U.debounce = (fn, ms) => {
    let t = null;
    const wrap = (...args) => {
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn(...args); }, ms);
    };
    wrap.cancel = () => { clearTimeout(t); t = null; };
    wrap.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
    return wrap;
  };

  U.throttle = (fn, ms) => {
    let last = 0, timer = null, lastArgs = null;
    return (...args) => {
      lastArgs = args;
      const now = performance.now();
      const wait = ms - (now - last);
      if (wait <= 0) {
        last = now;
        fn(...lastArgs);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null; last = performance.now(); fn(...lastArgs);
        }, wait);
      }
    };
  };

  U.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  U.fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };

  U.fmtChars = (n) => {
    n = Number(n) || 0;
    if (n < 1000) return n + ' 字';
    if (n < 10000) return (n / 1000).toFixed(1) + 'k 字';
    return (n / 10000).toFixed(1) + 'w 字';
  };

  U.fmtTime = (ts) => {
    const d = new Date(ts || Date.now());
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return hm;
    const md = d.getMonth() + 1 + '/' + d.getDate();
    return d.getFullYear() === now.getFullYear() ? md + ' ' + hm : d.getFullYear() + '/' + md;
  };

  U.fmtDuration = (ms) => {
    if (!ms || ms < 0) return '';
    if (ms < 1000) return Math.round(ms) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    const m = Math.floor(ms / 60000);
    return m + 'm' + Math.round((ms % 60000) / 1000) + 's';
  };

  U.nowText = () => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 周${week}`;
  };

  /* ---------- 路径 ---------- */
  U.normPath = (p) => {
    let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
    if (!s) return '/';
    if (s[0] !== '/') s = '/' + s;
    const parts = [];
    for (const seg of s.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { parts.pop(); continue; }
      parts.push(seg);
    }
    return '/' + parts.join('/');
  };

  U.joinPath = (dir, name) => U.normPath((dir || '/') + '/' + name);
  U.parentPath = (p) => {
    const n = U.normPath(p);
    if (n === '/') return '/';
    const i = n.lastIndexOf('/');
    return i <= 0 ? '/' : n.slice(0, i);
  };
  U.baseName = (p) => {
    const n = U.normPath(p);
    return n === '/' ? '/' : n.slice(n.lastIndexOf('/') + 1);
  };
  U.extName = (p) => {
    const b = U.baseName(p);
    const i = b.lastIndexOf('.');
    return i < 0 ? '' : b.slice(i + 1).toLowerCase();
  };
  U.isImagePath = (p) => /^(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(U.extName(p));

  U.mimeOf = (p) => {
    const e = U.extName(p);
    return {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
      md: 'text/markdown', json: 'application/json', html: 'text/html', css: 'text/css',
      js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', py: 'text/plain',
      txt: 'text/plain', csv: 'text/csv', xml: 'application/xml', yml: 'text/yaml', yaml: 'text/yaml'
    }[e] || 'text/plain';
  };

  U.isTextPath = (p) =>
    /^(md|markdown|txt|json|jsonc|js|mjs|cjs|ts|tsx|jsx|css|html|htm|xml|svg|csv|tsv|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|sh|bash|zsh|ps1|bat|yml|yaml|toml|ini|conf|log|sql|vue|svelte)$/i.test(U.extName(p));

  /* ---------- Token 估算（用于 UI 预算，不追求精确） ---------- */
  U.estimateTokens = (text) => {
    const s = String(text || '');
    if (!s) return 0;
    let cjk = 0, other = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c >= 0x2e80 && c <= 0x9fff) cjk++;
      else if (c >= 0xf900 && c <= 0xfaff) cjk++;
      else if (c >= 0xac00 && c <= 0xd7af) cjk++;
      else other++;
    }
    return Math.ceil(cjk * 0.62 + other / 4.1);
  };

  U.estimateMsgTokens = (m) => {
    if (!m) return 0;
    let n = 0;
    if (typeof m.content === 'string') n = U.estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === 'text') n += U.estimateTokens(part.text);
        else if (part && part.type === 'image_url') n += 320;
      }
    }
    if (m.tool_calls) for (const tc of m.tool_calls) n += U.estimateTokens(tc.function && tc.function.arguments) + 8;
    return n + 4;
  };

  U.hash = (s) => {
    let h = 5381;
    s = String(s);
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  };

  /* ---------- 文件 ---------- */
  U.downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  U.downloadText = (text, filename, type) =>
    U.downloadBlob(new Blob([text], { type: type || 'text/plain;charset=utf-8' }), filename);

  U.copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch (e2) { return false; }
    }
  };

  U.readFileText = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('读取文件失败'));
      r.readAsText(file);
    });

  U.readFileDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ''));
      r.onerror = () => reject(r.error || new Error('读取文件失败'));
      r.readAsDataURL(file);
    });

  /* 按码点截断，避免切坏代理对 */
  U.cut = (s, n) => Array.from(String(s || '')).slice(0, n).join('');

  U.bytesOf = (s) => new Blob([String(s || '')]).size;

  U.jsonSafe = (s, fallback) => {
    try { return JSON.parse(s); } catch (e) { return fallback; }
  };

  U.cleanSurrogates = (s) =>
    String(s || '').replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  U.clip = (s, max) => {
    const arr = Array.from(String(s || ''));
    if (arr.length <= max) return s;
    return arr.slice(0, max).join('');
  };
})();
