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
})();
