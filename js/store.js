/* ============================================================
   store.js · IndexedDB 存储层 + 虚拟文件系统
   设计要点：
   1. 元数据（nodes）常驻内存，正文按需读取并做小容量 LRU；
   2. 写入走批量事务，避免逐条 await 打开事务；
   3. IndexedDB 不可用时自动降级到内存，并在界面上明确提示；
   4. 事件采用「变更路径集合」，UI 只刷新受影响的部分。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;

  const DB_NAME = 'xiaohe_v2';
  const DB_VERSION = 1;
  const OPEN_TIMEOUT = 3500;

  const DB = (AH.db = {
    mode: 'pending',           // pending | idb | memory
    reason: '',
    _db: null,
    _mem: { nodes: new Map(), content: new Map(), kv: new Map() }
  });

  function timeout(ms) {
    return new Promise((_, rej) => setTimeout(() => rej(new Error('__TIMEOUT__')), ms));
  }

  DB.open = async function () {
    if (DB._db) return DB._db;
    if (DB.mode === 'memory') return null;
    try {
      const db = await Promise.race([
        new Promise((resolve, reject) => {
          let req;
          try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
          req.onupgradeneeded = () => {
            const d = req.result;
            if (!d.objectStoreNames.contains('nodes')) d.createObjectStore('nodes', { keyPath: 'path' });
            if (!d.objectStoreNames.contains('content')) d.createObjectStore('content', { keyPath: 'path' });
            if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
          req.onblocked = () => reject(new Error('IndexedDB 被其他标签页阻塞'));
        }),
        timeout(OPEN_TIMEOUT)
      ]);
      DB._db = db;
      DB.mode = 'idb';
      db.onversionchange = () => { try { db.close(); } catch (e) {} DB._db = null; };
    } catch (e) {
      DB.mode = 'memory';
      DB.reason = e && e.message === '__TIMEOUT__' ? '打开超时' : (e && e.message) || '不可用';
      console.warn('[store] 降级为内存模式：', DB.reason);
    }
    return DB._db;
  };

  function getStore(name, mode) {
    if (DB.mode === 'memory' || !DB._db) return null;
    try { return DB._db.transaction(name, mode || 'readonly').objectStore(name); } catch (e) { return null; }
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 操作失败'));
    });
  }

  DB.get = async function (store, key) {
    if (DB.mode === 'memory' || !DB._db) return DB._mem[store] ? DB._mem[store].get(key) : undefined;
    const s = getStore(store, 'readonly');
    if (!s) return undefined;
    return reqP(s.get(key));
  };

  DB.getAll = async function (store) {
    if (DB.mode === 'memory' || !DB._db) {
      const m = DB._mem[store];
      return m ? Array.from(m.values()) : [];
    }
    const s = getStore(store, 'readonly');
    if (!s) return [];
    return reqP(s.getAll());
  };

  DB.put = async function (store, value) {
    if (DB.mode === 'memory' || !DB._db) {
      if (!DB._mem[store]) DB._mem[store] = new Map();
      DB._mem[store].set(value.path != null ? value.path : value.k, value);
      return;
    }
    await reqP(getStore(store, 'readwrite').put(value));
  };

  DB.batch = async function (ops) {
    // ops: [{store, type:'put'|'del', value|key}]
    if (!ops || !ops.length) return;
    if (DB.mode === 'memory' || !DB._db) {
      for (const op of ops) {
        const m = DB._mem[op.store] || (DB._mem[op.store] = new Map());
        if (op.type === 'del') m.delete(op.key);
        else m.set(op.value.path != null ? op.value.path : op.value.k, op.value);
      }
      return;
    }
    const stores = [...new Set(ops.map((o) => o.store))];
    const tx = DB._db.transaction(stores, 'readwrite');
    for (const op of ops) {
      const s = tx.objectStore(op.store);
      if (op.type === 'del') s.delete(op.key); else s.put(op.value);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('事务失败'));
      tx.onabort = () => reject(tx.error || new Error('事务中止'));
    });
  };

  DB.del = async function (store, key) {
    if (DB.mode === 'memory' || !DB._db) {
      const m = DB._mem[store];
      if (m) m.delete(key);
      return;
    }
    await reqP(getStore(store, 'readwrite').delete(key));
  };

  DB.clear = async function (store) {
    if (DB.mode === 'memory' || !DB._db) {
      if (DB._mem[store]) DB._mem[store].clear();
      return;
    }
    await reqP(getStore(store, 'readwrite').clear());
  };

  /* ============================================================
     VFS
     ============================================================ */
  const VFS = (AH.vfs = {
    nodes: new Map(),
    rev: 0,
    ready: false,
    _listeners: new Set(),
    _cache: new Map(),
    _cacheBytes: 0,
    _cacheMaxBytes: 4 * 1024 * 1024,
    _cacheMaxItems: 80,
    root: '/'
  });

  /* ---------- 事件 ---------- */
  VFS.on = (fn) => { VFS._listeners.add(fn); return () => VFS._listeners.delete(fn); };
  VFS._emit = (paths) => {
    VFS.rev++;
    const set = paths instanceof Set ? paths : new Set(paths || []);
    for (const fn of VFS._listeners) {
      try { fn(set, VFS.rev); } catch (e) { console.error('[vfs] listener', e); }
    }
  };

  /* ---------- 缓存 ---------- */
  function cacheGet(path) {
    if (!VFS._cache.has(path)) return undefined;
    const v = VFS._cache.get(path);
    VFS._cache.delete(path);
    VFS._cache.set(path, v);
    return v;
  }
  function cacheSet(path, content) {
    if (VFS._cache.has(path)) {
      const old = VFS._cache.get(path);
      VFS._cacheBytes -= U.bytesOf(old);
      VFS._cache.delete(path);
    }
    VFS._cache.set(path, content);
    VFS._cacheBytes += U.bytesOf(content);
    while (VFS._cache.size > VFS._cacheMaxItems || VFS._cacheBytes > VFS._cacheMaxBytes) {
      const first = VFS._cache.keys().next().value;
      if (first == null) break;
      VFS._cacheBytes -= U.bytesOf(VFS._cache.get(first));
      VFS._cache.delete(first);
    }
  }
  function cacheDrop(path) {
    if (VFS._cache.has(path)) {
      VFS._cacheBytes -= U.bytesOf(VFS._cache.get(path));
      VFS._cache.delete(path);
    }
  }
  VFS.invalidateCache = () => { VFS._cache.clear(); VFS._cacheBytes = 0; };

  /* ---------- 初始化 ---------- */
  VFS.init = async function () {
    await DB.open();
    const rows = await DB.getAll('nodes');
    VFS.nodes.clear();
    for (const n of rows) VFS.nodes.set(n.path, n);
    if (VFS.nodes.size === 0) await seed();
    await seedKnowledge();
    if (!VFS.nodes.has('/')) {
      await rawPutNode({ path: '/', type: 'dir', size: 0, mtime: Date.now() }, true);
    }
    VFS.ready = true;
    VFS._emit(['/']);
    return VFS;
  };

  async function rawPutNode(node, silent) {
    VFS.nodes.set(node.path, node);
    await DB.put('nodes', node);
    if (!silent) VFS._emit([node.path]);
  }

  async function seed() {
    const files = {
      '/README.md': [
        '# 虚拟文件系统',
        '',
        '这里的文件保存在浏览器 **IndexedDB** 中，刷新页面不会丢；清理站点数据或换浏览器会丢。',
        '',
        '## 目录',
        '- `/notes`：随手记、草稿',
        '- `/projects`：按项目分目录',
        '- `/conversations`：对话记录（应用自动写入，不要手改）',
        '- `/knowledge`：内置知识库（Agent 的能力/环境/工具说明）',
        '- `/plugins`：本地插件（.js + .json，默认禁用）',
        '- `/tmp`：工具产生的临时文件，可随时清空',
        '',
        '## 给 Agent 的约定',
        '- 绝对路径，`/` 开头。',
        '- 改代码优先 `edit_file`；整写前先 `read_file`。',
        '- 删除、覆盖、移动、联网抓取前会弹确认。',
        '- 不要在文件里写 API Key。',
      ].join('\n'),
      '/notes/README.md': '# 笔记\n\n在这里记录想法。文件名用小写英文 + 连字符，例如 `project-plan.md`。\n'
    };
    const dirs = ['/notes', '/projects', '/conversations', '/tmp'];
    const ops = [];
    const now = Date.now();
    for (const d of dirs) {
      const node = { path: d, type: 'dir', size: 0, mtime: now };
      VFS.nodes.set(d, node);
      ops.push({ store: 'nodes', type: 'put', value: node });
    }
    for (const [path, content] of Object.entries(files)) {
      const node = { path, type: 'file', size: content.length, mtime: now };
      VFS.nodes.set(path, node);
      ops.push({ store: 'nodes', type: 'put', value: node });
      ops.push({ store: 'content', type: 'put', value: { path, content } });
    }
    await DB.batch(ops);
    await DB.put('kv', { k: 'seed_v2', v: now });
  }

  async function seedKnowledge() {
    const kb = AH.knowledge || {};
    const keys = Object.keys(kb);
    if (!keys.length) return;
    if (!VFS.nodes.has('/knowledge')) await VFS.mkdir('/knowledge');
    for (const path of keys) {
      if (VFS.nodes.has(path)) continue;      // 用户改过的内容不覆盖
      try { await VFS.write(path, kb[path]); } catch (e) { console.warn('[knowledge] 写入失败', path, e); }
    }
  }
  VFS.seedKnowledge = seedKnowledge;

  /* ---------- 查询 ---------- */
  VFS.stat = (path) => VFS.nodes.get(U.normPath(path)) || null;

  VFS.exists = (path) => VFS.nodes.has(U.normPath(path));

  VFS.list = function (path) {
    const p = U.normPath(path);
    const node = VFS.nodes.get(p);
    if (!node) throw new Error('目录不存在：' + p);
    if (node.type !== 'dir') throw new Error('不是目录：' + p);
    const out = [];
    for (const n of VFS.nodes.values()) {
      if (n.path === '/' || n.path === p) continue;
      if (U.parentPath(n.path) === p) out.push(n);
    }
    out.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.path.localeCompare(b.path, 'zh-Hans-CN');
    });
    return out;
  };

  VFS.childrenCount = function (path) {
    try { return VFS.list(path).length; } catch (e) { return 0; }
  };

  VFS.read = async function (path) {
    const p = U.normPath(path);
    const node = VFS.nodes.get(p);
    if (!node) throw new Error('文件不存在：' + p);
    if (node.type === 'dir') throw new Error('这是一个目录：' + p);
    const cached = cacheGet(p);
    if (cached !== undefined) return cached;
    const row = await DB.get('content', p);
    const content = row && typeof row.content === 'string' ? row.content : '';
    cacheSet(p, content);
    return content;
  };

  /* ---------- 写 ---------- */
  async function ensureDirs(path, ops, created) {
    let dir = U.parentPath(path);
    const chain = [];
    while (dir !== '/') {
      if (VFS.nodes.has(dir)) break;
      chain.push(dir);
      dir = U.parentPath(dir);
    }
    for (const d of chain.reverse()) {
      const node = { path: d, type: 'dir', size: 0, mtime: Date.now() };
      VFS.nodes.set(d, node);
      ops.push({ store: 'nodes', type: 'put', value: node });
      created.add(d);
    }
  }

  VFS.write = async function (path, content, opts) {
    const p = U.normPath(path);
    if (p === '/') throw new Error('不能写入根目录');
    const existing = VFS.nodes.get(p);
    if (existing && existing.type === 'dir') throw new Error('目标是目录，不能写文件：' + p);
    content = String(content == null ? '' : content);
    const ops = [];
    const changed = new Set([p]);
    await ensureDirs(p, ops, changed);
    const node = { path: p, type: 'file', size: content.length, mtime: Date.now() };
    VFS.nodes.set(p, node);
    cacheSet(p, content);
    ops.push({ store: 'nodes', type: 'put', value: node });
    ops.push({ store: 'content', type: 'put', value: { path: p, content } });
    await DB.batch(ops);
    if (!opts || !opts.silent) VFS._emit(changed);
    return node;
  };

  VFS.append = async function (path, text, atLine) {
    const p = U.normPath(path);
    const old = VFS.nodes.has(p) ? await VFS.read(p) : '';
    if (atLine == null) return VFS.write(p, old + String(text || ''));
    const lines = old.split('\n');
    const idx = U.clamp(Number(atLine) || 0, 0, lines.length);
    lines.splice(idx, 0, String(text || ''));
    return VFS.write(p, lines.join('\n'));
  };

  VFS.mkdir = async function (path) {
    const p = U.normPath(path);
    if (p === '/') return VFS.nodes.get('/');
    if (VFS.nodes.has(p)) {
      if (VFS.nodes.get(p).type === 'dir') return VFS.nodes.get(p);
      throw new Error('同名文件已存在：' + p);
    }
    const ops = [];
    const changed = new Set();
    await ensureDirs(p + '/x', ops, changed);
    const node = { path: p, type: 'dir', size: 0, mtime: Date.now() };
    VFS.nodes.set(p, node);
    ops.push({ store: 'nodes', type: 'put', value: node });
    changed.add(p);
    await DB.batch(ops);
    VFS._emit(changed);
    return node;
  };

  VFS.remove = async function (path, opts) {
    const p = U.normPath(path);
    if (p === '/') throw new Error('不能删除根目录');
    const node = VFS.nodes.get(p);
    if (!node) throw new Error('路径不存在：' + p);
    const targets = [];
    if (node.type === 'dir') {
      for (const n of VFS.nodes.values()) {
        if (n.path === p || n.path.startsWith(p + '/')) targets.push(n);
      }
    } else targets.push(node);
    const ops = [];
    const changed = new Set();
    for (const n of targets) {
      VFS.nodes.delete(n.path);
      ops.push({ store: 'nodes', type: 'del', key: n.path });
      if (n.type === 'file') {
        ops.push({ store: 'content', type: 'del', key: n.path });
        cacheDrop(n.path);
      }
      changed.add(n.path);
    }
    changed.add(U.parentPath(p));
    await DB.batch(ops);
    if (!opts || !opts.silent) VFS._emit(changed);
    return targets.length;
  };

  VFS.move = async function (from, to) {
    const a = U.normPath(from), b = U.normPath(to);
    if (a === '/' || b === '/') throw new Error('不能移动根目录');
    const node = VFS.nodes.get(a);
    if (!node) throw new Error('源路径不存在：' + a);
    if (VFS.nodes.has(b)) throw new Error('目标已存在：' + b);
    if (b.startsWith(a + '/')) throw new Error('不能移动到自身子目录');
    const targets = [];
    for (const n of VFS.nodes.values()) {
      if (n.path === a || n.path.startsWith(a + '/')) targets.push(n);
    }
    const ops = [];
    const changed = new Set([a, b, U.parentPath(a), U.parentPath(b)]);
    const dirs = [];
    await ensureDirs(b, ops, changed);
    for (const n of targets) {
      const np = b + n.path.slice(a.length);
      const oldPath = n.path;
      let content;
      if (n.type === 'file') { content = await VFS.read(oldPath); }
      dirs.push({ n, np, oldPath, content });
    }
    // 先移除旧键，再写新键，避免同名冲突
    for (const d of dirs) {
      VFS.nodes.delete(d.oldPath);
      ops.push({ store: 'nodes', type: 'del', key: d.oldPath });
      if (d.n.type === 'file') {
        ops.push({ store: 'content', type: 'del', key: d.oldPath });
        cacheDrop(d.oldPath);
      }
    }
    for (const d of dirs) {
      const node2 = { path: d.np, type: d.n.type, size: d.n.size, mtime: Date.now() };
      VFS.nodes.set(d.np, node2);
      ops.push({ store: 'nodes', type: 'put', value: node2 });
      if (d.n.type === 'file') {
        ops.push({ store: 'content', type: 'put', value: { path: d.np, content: d.content } });
        cacheSet(d.np, d.content);
      }
      changed.add(d.np);
    }
    await DB.batch(ops);
    VFS._emit(changed);
    return b;
  };

  /* ---------- 搜索 ---------- */
  VFS.search = async function (query, opts) {
    const o = Object.assign({ inPath: '/', limit: 30, inContent: true, regex: false, caseSensitive: false }, opts || {});
    const q = String(query || '');
    if (!q) throw new Error('搜索关键词为空');
    const base = U.normPath(o.inPath || '/');
    const limit = Math.max(1, Math.min(200, Number(o.limit) || 30));
    let matcher;
    if (o.regex) {
      try { matcher = new RegExp(q, o.caseSensitive ? '' : 'i'); }
      catch (e) { throw new Error('正则表达式无效：' + e.message); }
    } else {
      const needle = o.caseSensitive ? q : q.toLowerCase();
      matcher = { test: (s) => (o.caseSensitive ? s : s.toLowerCase()).includes(needle) };
    }
    const results = [];
    let scanned = 0;
    const files = [...VFS.nodes.values()].filter((n) => n.type === 'file' && (base === '/' || n.path.startsWith(base + '/'))).sort((a, b) => a.path.localeCompare(b.path));
    for (const n of files) {
      if (results.length >= limit || scanned > 600) break;
      scanned++;
      let hitName = matcher.test(n.path);
      if (hitName) {
        results.push(n.path + '  （文件名匹配）');
        continue;
      }
      if (!o.inContent || U.isImagePath(n.path)) continue;
      let content;
      try { content = await VFS.read(n.path); } catch (e) { continue; }
      if (!content || content.length > 2 * 1024 * 1024) continue;
      const lines = content.split('\n');
      let hits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!matcher.test(lines[i])) continue;
        results.push(n.path + ':' + (i + 1) + '  ' + U.clip(lines[i].trim(), 160));
        hits++;
        if (hits >= 3 || results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    return results;
  };

  /* ---------- 导入导出 ---------- */
  VFS.exportFiles = async function () {
    const files = [];
    for (const n of VFS.nodes.values()) {
      if (n.type !== 'file') continue;
      files.push({ path: n.path, content: await VFS.read(n.path), mtime: n.mtime });
    }
    const dirs = [...VFS.nodes.values()].filter((n) => n.type === 'dir').map((n) => n.path);
    return { dirs, files };
  };

  VFS.importFiles = async function (data, opts) {
    const o = Object.assign({ replace: false }, opts || {});
    if (!data || !Array.isArray(data.files)) throw new Error('备份格式不正确');
    const ops = [];
    if (o.replace) {
      for (const n of VFS.nodes.values()) {
        if (n.path === '/') continue;
        ops.push({ store: 'nodes', type: 'del', key: n.path });
        if (n.type === 'file') ops.push({ store: 'content', type: 'del', key: n.path });
      }
      for (const n of VFS.nodes.values()) if (n.path !== '/') VFS.nodes.delete(n.path);
      VFS.invalidateCache();
    }
    for (const d of data.dirs || []) {
      if (!d || d === '/') continue;
      const node = { path: U.normPath(d), type: 'dir', size: 0, mtime: Date.now() };
      VFS.nodes.set(node.path, node);
      ops.push({ store: 'nodes', type: 'put', value: node });
    }
    for (const f of data.files) {
      const path = U.normPath(f.path);
      if (!path || path === '/') continue;
      const content = String(f.content == null ? '' : f.content);
      const node = { path, type: 'file', size: content.length, mtime: f.mtime || Date.now() };
      VFS.nodes.set(path, node);
      ops.push({ store: 'nodes', type: 'put', value: node });
      ops.push({ store: 'content', type: 'put', value: { path, content } });
    }
    await DB.batch(ops);
    VFS.invalidateCache();
    VFS._emit(['/']);
    return { files: data.files.length, dirs: (data.dirs || []).length };
  };

  VFS.stats = function () {
    let files = 0, dirs = 0, chars = 0;
    for (const n of VFS.nodes.values()) {
      if (n.type === 'dir') dirs++; else { files++; chars += n.size || 0; }
    }
    return { files, dirs, chars };
  };

  VFS.clearAll = async function () {
    await DB.clear('nodes');
    await DB.clear('content');
    VFS.nodes.clear();
    VFS.invalidateCache();
    await seed();
    await rawPutNode({ path: '/', type: 'dir', size: 0, mtime: Date.now() }, true);
    VFS._emit(['/']);
  };
})();
