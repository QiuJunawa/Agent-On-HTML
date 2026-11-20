/* ============================================================
   zip.js · 最小 ZIP 打包（store，不压缩）
   仅用于“右键文件夹 → 下载 .zip”；不引入第三方库。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const enc = new TextEncoder();
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function dosTime(d) {
    const year = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }
  function u16(n) { return [(n >>> 0) & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [(n >>> 0) & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }
  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  const ZIP = (AH.zip = {});

  ZIP.folder = function (path) {
    const VFS = AH.vfs;
    const U = AH.util;
    const root = U.normPath(path);
    if (!VFS.exists(root)) throw new Error('目录不存在：' + root);
    const node = VFS.stat(root);
    if (!node || node.type !== 'dir') throw new Error('不是目录：' + root);

    const files = [];
    const dirs = [];
    const walk = (dir) => {
      for (const ch of VFS.list(dir)) {
        if (ch.type === 'dir') { dirs.push(ch.path); walk(ch.path); }
        else files.push(ch);
      }
    };
    walk(root);

    const baseName = U.baseName(root) || 'VFS';
    const entries = [];
    let offset = 0;
    const central = [];
    for (const p of dirs) {
      const name = enc.encode(U.normPath(p).replace(/^\/+/, '') + '/');
      const dt = dosTime(new Date());
      const local = concat([
        new Uint8Array(u32(0x04034b50)), new Uint8Array(u16(20)), new Uint8Array(u16(0x0800)),
        new Uint8Array(u16(0)), new Uint8Array(u16(dt.time)), new Uint8Array(u16(dt.date)),
        new Uint8Array(u32(0)), new Uint8Array(u32(0)), new Uint8Array(u32(0)),
        new Uint8Array(u16(name.length)), new Uint8Array(u16(0)), name
      ]);
      entries.push(local);
      central.push({ name, crc: 0, size: 0, offset, time: dt.time, date: dt.date });
      offset += local.length;
    }
    for (const f of files) {
      const name = enc.encode(f.path.replace(/^\/+/, ''));
      // 正文可能不在缓存里，统一走异步读取（folder 返回 Promise）
      entries.push({ pending: f, name });
    }
    return (async () => {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (!e.pending) continue;
        const raw = String(await VFS.read(e.pending.path) || '');
        let bytes;
        if (U.isImagePath(e.pending.path) && /^data:[^,]*,/.test(raw)) {
          const b64 = raw.slice(raw.indexOf(',') + 1);
          const bin = atob(b64);
          bytes = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
        } else bytes = enc.encode(raw);
        const dt = dosTime(new Date(e.pending.mtime || Date.now()));
        const crc = crc32(bytes);
        const local = concat([
          new Uint8Array(u32(0x04034b50)), new Uint8Array(u16(20)), new Uint8Array(u16(0x0800)),
          new Uint8Array(u16(0)), new Uint8Array(u16(dt.time)), new Uint8Array(u16(dt.date)),
          new Uint8Array(u32(crc)), new Uint8Array(u32(bytes.length)), new Uint8Array(u32(bytes.length)),
          new Uint8Array(u16(e.name.length)), new Uint8Array(u16(0)), e.name, bytes
        ]);
        entries[i] = local;
        central.push({ name: e.name, crc, size: bytes.length, offset, time: dt.time, date: dt.date });
        offset += local.length;
      }
      const centralParts = [];
      for (const c of central) {
        centralParts.push(concat([
          new Uint8Array(u32(0x02014b50)), new Uint8Array(u16(20)), new Uint8Array(u16(20)),
          new Uint8Array(u16(0x0800)), new Uint8Array(u16(0)),
          new Uint8Array(u16(c.time)), new Uint8Array(u16(c.date)),
          new Uint8Array(u32(c.crc)), new Uint8Array(u32(c.size)), new Uint8Array(u32(c.size)),
          new Uint8Array(u16(c.name.length)), new Uint8Array(u16(0)), new Uint8Array(u16(0)),
          new Uint8Array(u16(0)), new Uint8Array(u16(0)), new Uint8Array(u32(0)),
          new Uint8Array(u32(c.offset)), c.name
        ]));
      }
      const cd = concat(centralParts);
      const eocd = concat([
        new Uint8Array(u32(0x06054b50)), new Uint8Array(u16(0)), new Uint8Array(u16(0)),
        new Uint8Array(u16(central.length)), new Uint8Array(u16(central.length)),
        new Uint8Array(u32(cd.length)), new Uint8Array(u32(offset)), new Uint8Array(u16(0))
      ]);
      return { blob: new Blob([concat([...entries, cd, eocd])], { type: 'application/zip' }), name: baseName + '.zip', count: files.length };
    })();
  };

  /* ---------- 解压（读取中央目录；支持 store / deflate-raw） ---------- */
  function u16at(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32at(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function safeName(name) {
    const out = [];
    for (const seg of String(name || '').replace(/\\/g, '/').split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') return null;
      if (/^[a-zA-Z]:$/.test(seg)) return null;
      out.push(seg);
    }
    return out.join('/');
  }
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持 deflate 解压，请用 Chrome/Edge 新版');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  ZIP.unpack = async function (input) {
    let bytes;
    if (input instanceof Blob) bytes = new Uint8Array(await input.arrayBuffer());
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else bytes = new Uint8Array(input);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (u32at(bytes, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到目录尾）');
    const count = u16at(bytes, eocd + 10);
    const cdOff = u32at(bytes, eocd + 16);
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('不支持 ZIP64');
    if (count > 5000) throw new Error('ZIP 条目超过 5000 个，已拒绝');
    let p = cdOff, total = 0;
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (u32at(bytes, p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
      const flags = u16at(bytes, p + 8), method = u16at(bytes, p + 10);
      const compSize = u32at(bytes, p + 20), size = u32at(bytes, p + 24);
      const nameLen = u16at(bytes, p + 28), extraLen = u16at(bytes, p + 30), commentLen = u16at(bytes, p + 32);
      const localOff = u32at(bytes, p + 42);
      const rawName = new TextDecoder('utf-8').decode(bytes.slice(p + 46, p + 46 + nameLen));
      const clean = safeName(rawName);
      const isDir = /\/$/.test(rawName) || (!size && clean && !rawName.split('/').pop());
      if (clean === null) throw new Error('ZIP 包含非法路径：' + rawName);
      if (!clean) { p += 46 + nameLen + extraLen + commentLen; continue; }
      if (flags & 1) throw new Error('不支持加密 ZIP：' + clean);
      if (method !== 0 && method !== 8) throw new Error('不支持的压缩方式 ' + method + '：' + clean);
      if (compSize === 0xFFFFFFFF || size === 0xFFFFFFFF) throw new Error('不支持 ZIP64：' + clean);
      total += size;
      if (total > 100 * 1024 * 1024) throw new Error('解压后超过 100MB，已拒绝');
      if (!isDir) {
        if (u32at(bytes, localOff) !== 0x04034b50) throw new Error('ZIP 本地头损坏：' + clean);
        const lnLen = u16at(bytes, localOff + 26), leLen = u16at(bytes, localOff + 28);
        const start = localOff + 30 + lnLen + leLen;
        if (start + compSize > bytes.length) throw new Error('ZIP 数据越界：' + clean);
        const raw = bytes.slice(start, start + compSize);
        const data = method === 0 ? raw : await inflateRaw(raw);
        if (data.length !== size) throw new Error('ZIP 解压长度不符：' + clean);
        entries.push({ path: clean, dir: false, data });
      } else {
        entries.push({ path: clean, dir: true, data: null });
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  };

  function bytesToDataUrl(data, path) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < data.length; i += chunk) bin += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
    const mime = AH.util.mimeOf(path);
    return 'data:' + (mime === 'text/plain' ? 'application/octet-stream' : mime) + ';base64,' + btoa(bin);
  }

  ZIP.extractTo = async function (entries, dir) {
    const VFS = AH.vfs, U = AH.util;
    const root = U.normPath(dir);
    let files = 0, dirs = 0;
    for (const e of entries) {
      const target = U.joinPath(root, e.path);
      if (e.dir) { await VFS.mkdir(target); dirs++; continue; }
      const text = U.isTextPath(e.path) && !U.isImagePath(e.path);
      await VFS.write(target, text ? new TextDecoder('utf-8').decode(e.data) : bytesToDataUrl(e.data, e.path));
      files++;
    }
    return { root, files, dirs };
  };

  ZIP.toVfs = async function (input, baseDir, fileName) {
    const VFS = AH.vfs, U = AH.util;
    const base = U.baseName(String(fileName || 'archive.zip')).replace(/\.zip$/i, '').replace(/[\\/:*?"<>|]/g, '_') || 'archive';
    const parent = U.normPath(baseDir || '/uploads');
    let root = U.joinPath(parent, base), n = 2;
    while (VFS.exists(root)) root = U.joinPath(parent, base + '-' + n++);
    const entries = await ZIP.unpack(input);
    const r = await ZIP.extractTo(entries, root);
    return Object.assign({ name: base + '.zip' }, r);
  };
})();
