/* ============================================================
   plugins.js · 插件管理器
   插件存放在 VFS /plugins/<id>.js + <id>.json。
   启用后代码在 AsyncFunction 中执行，可用 AgentAPI.defineTool 注册工具，
   也可用 AgentAPI.registerHook(event, fn) 注册生命周期钩子；
   插件拥有页面权限，启用前必须由用户确认。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;
  const VFS = AH.vfs;
  const cfg = AH.cfg;

  const P = (AH.plugins = {
    metas: [],
    tools: new Map(),      // name -> { pluginId, spec, handler }
    loaded: new Map(),     // id -> { unloadFns, code }
    _loading: null,
    _inject: new Map(),    // pluginId -> Set<fn>，消息注入器（兼容旧 API）
    _hooks: new Map()      // event -> Set<{ pluginId, fn }>，事件钩子
  });
  const DIR = '/plugins';
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  function validId(id) { return /^[a-zA-Z0-9_.-]{1,60}$/.test(String(id || '')); }

  function apiFor(id) {
    return {
      VFS,
      cfg,
      toast: (m, t) => AH.ui.toast(m, t),
      getConversation: () => (AH.chat && AH.chat.conv) || [],
      executeTool: (name, args, ctx) => AH.tools.execute(name, args, ctx || { run: null, signal: null, confirm: AH.ui.confirm }),
      defineTool: (name, spec, handler) => P.register(id, name, spec, handler),
      registerTool: (name, spec, handler) => P.register(id, name, spec, handler),
      registerInjector: (fn) => P.addInjector(id, fn),
      registerHook: (event, fn) => P.addHook(id, event, fn),
      on: (event, fn) => P.addHook(id, event, fn),
      pluginId: id
    };
  }

  /* 消息注入器：插件可注册函数，每轮请求前被调用，
     返回 { before?, after? } 文本，插到发给模型的 user 消息前后。 */
  P.addInjector = function (pluginId, fn) {
    if (typeof fn !== 'function') throw new Error('registerInjector 需要一个函数');
    if (!P._inject.has(pluginId)) P._inject.set(pluginId, new Set());
    const set = P._inject.get(pluginId);
    set.add(fn);
    return () => set.delete(fn);
  };

  function addHook(pluginId, event, fn) {
    const name = String(event || '').trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,40}$/.test(name)) throw new Error('钩子事件名不合法：' + name);
    if (typeof fn !== 'function') throw new Error('registerHook 需要 (event, fn)');
    if (!P._hooks.has(name)) P._hooks.set(name, new Set());
    const entry = { pluginId, fn };
    P._hooks.get(name).add(entry);
    return () => P._hooks.get(name) && P._hooks.get(name).delete(entry);
  }
  P.addHook = addHook;

  P.runHook = async function (event, ctx) {
    const set = P._hooks.get(String(event || ''));
    if (!set || !set.size) return [];
    const out = [];
    for (const entry of [...set]) {
      try {
        out.push({ pluginId: entry.pluginId, value: await entry.fn(Object.assign({}, ctx, { pluginId: entry.pluginId })) });
      } catch (e) { console.warn('[hook]', event, entry.pluginId, e); }
    }
    return out;
  };

  const MAX_INJECT_MESSAGES = 12;
  const MAX_INJECT_CHARS = 16000;

  function addSystemMessages(out, value) {
    if (value == null) return;
    if (out.length >= MAX_INJECT_MESSAGES) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) out.push({ role: 'system', content: text.slice(0, MAX_INJECT_CHARS) });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) { if (out.length >= MAX_INJECT_MESSAGES) break; addSystemMessages(out, item); }
      return;
    }
    if (typeof value !== 'object') return;
    if (Array.isArray(value.messages)) addSystemMessages(out, value.messages);
    if (typeof value.content === 'string' && (!value.role || value.role === 'system')) {
      const text = value.content.trim();
      if (text) out.push({ role: 'system', content: text.slice(0, MAX_INJECT_CHARS) });
    }
    if (typeof value.system === 'string' && value.system.trim()) {
      out.push({ role: 'system', content: value.system.trim().slice(0, MAX_INJECT_CHARS) });
    }
  }

  function mergeInjectResult(r, before, after, system) {
    if (!r) return;
    if (typeof r === 'string') { if (r.trim()) before.push(r); return; }
    if (Array.isArray(r)) { for (const x of r) mergeInjectResult(x, before, after, system); return; }
    if (typeof r !== 'object') return;
    if (typeof r.before === 'string') { if (r.before) before.push(r.before); }
    else if (Array.isArray(r.before)) before.push(...r.before.filter((x) => typeof x === 'string' && x));
    if (typeof r.after === 'string') { if (r.after) after.push(r.after); }
    else if (Array.isArray(r.after)) after.push(...r.after.filter((x) => typeof x === 'string' && x));
    addSystemMessages(system, r.system);
    if (Array.isArray(r.messages)) addSystemMessages(system, r.messages);
  }

  P.collectInject = async function (ctx) {
    const before = [];
    const after = [];
    const system = [];
    for (const [pid, set] of P._inject) {
      for (const fn of set) {
        let r;
        try { r = await fn(ctx); } catch (e) { console.warn('[inject]', pid, e); continue; }
        mergeInjectResult(r, before, after, system);
      }
    }
    for (const r of await P.runHook('beforeRequest', ctx)) mergeInjectResult(r.value, before, after, system);

    const last = ctx && ctx.conv && ctx.conv[ctx.conv.length - 1];
    if (last && last.role === 'user') {
      for (const r of await P.runHook('afterUserMessage', Object.assign({}, ctx, { userMessage: last }))) addSystemMessages(system, r.value);
    } else if (last && last.role === 'tool') {
      for (const r of await P.runHook('afterToolResult', Object.assign({}, ctx, { toolMessage: last }))) addSystemMessages(system, r.value);
    }
    return { before, after, system };
  };

  P.register = function (pluginId, name, spec, handler) {
    const n = String(name || '').trim();
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(n)) throw new Error('插件工具名只能用小写字母开头、字母数字下划线，2-41 字符：' + n);
    if (typeof handler !== 'function') throw new Error('defineTool 第三个参数必须是函数');
    if (n === 'tools_expand' || (AH.tools.SPECS && AH.tools.SPECS[n])) throw new Error('与内置工具重名：' + n);
    if (P.tools.has(n)) throw new Error('工具已被其他插件注册：' + n);
    const raw = spec && spec.function ? spec.function : (spec || {});
    P.tools.set(n, {
      pluginId,
      handler,
      spec: {
        type: 'function',
        function: {
          name: n,
          description: String(raw.description || ('插件 ' + pluginId + ' 提供的工具')),
          parameters: (raw.parameters && typeof raw.parameters === 'object') ? raw.parameters : { type: 'object', properties: {} }
        }
      }
    });
    return n;
  };

  P.unregister = function (pluginId) {
    P._inject.delete(pluginId);
    for (const [event, set] of [...P._hooks]) {
      for (const entry of [...set]) if (entry.pluginId === pluginId) set.delete(entry);
      if (!set.size) P._hooks.delete(event);
    }
    let n = 0;
    for (const [name, t] of [...P.tools]) if (t.pluginId === pluginId) { P.tools.delete(name); n++; }
    return n;
  };

  P.specs = () => [...P.tools.values()].map((t) => t.spec);
  P.find = (name) => P.tools.get(name) || null;
  P.toolNames = (id) => [...P.tools.values()].filter((t) => t.pluginId === id).map((t) => t.spec.function.name);

  async function readMeta(id) {
    try {
      const raw = await VFS.read(DIR + '/' + id + '.json');
      const j = JSON.parse(raw || '{}');
      return { id, name: j.name || id, version: j.version || '0.0.1', enabled: !!j.enabled, description: j.description || '' };
    } catch (e) { return null; }
  }

  P.list = async function () {
    if (!VFS.exists(DIR)) return [];
    const files = VFS.list(DIR).filter((n) => n.type === 'file' && /\.json$/i.test(n.path));
    const out = [];
    for (const f of files) {
      const id = U.baseName(f.path).replace(/\.json$/i, '');
      const m = await readMeta(id);
      if (m) out.push(m);
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    P.metas = out;
    return out;
  };

  async function writeMeta(meta) {
    await VFS.write(DIR + '/' + meta.id + '.json', JSON.stringify({
      name: meta.name, version: meta.version, enabled: !!meta.enabled, description: meta.description || ''
    }, null, 2));
  }

  P.loadOne = async function (id) {
    if (P.loaded.has(id)) return;
    const code = await VFS.read(DIR + '/' + id + '.js');
    if (!String(code || '').trim()) throw new Error('插件代码为空：' + id);
    const unloadFns = [];
    const onUnload = (fn) => { if (typeof fn === 'function') unloadFns.push(fn); };
    P._loading = id;
    try {
      const fn = new AsyncFunction('AgentAPI', 'onUnload', String(code) + '\n//# sourceURL=plugin://' + id + '.js');
      await fn(apiFor(id), onUnload);
      P.loaded.set(id, { unloadFns, code });
    } catch (e) {
      P.unregister(id);
      throw new Error('插件加载失败 ' + id + '：' + (e && e.message ? e.message : e));
    } finally {
      P._loading = null;
    }
  };

  P.unloadOne = function (id) {
    const p = P.loaded.get(id);
    if (p) {
      for (const fn of p.unloadFns) { try { fn(); } catch (e) { console.warn('[plugin unload]', id, e); } }
      P.loaded.delete(id);
    }
    return P.unregister(id);
  };

  P.loadAll = async function () {
    const metas = await P.list();
    for (const m of metas) {
      if (!m.enabled) continue;
      try { await P.loadOne(m.id); } catch (e) { AH.ui.toast(e.message, 'err', 5000); }
    }
    return metas;
  };

  P.save = async function (id, code, meta, enable) {
    if (!validId(id)) throw new Error('插件 id 只能包含字母、数字、下划线、横线、点');
    await VFS.mkdir(DIR);
    await VFS.write(DIR + '/' + id + '.js', String(code || ''));
    const m = Object.assign({ id, name: id, version: '0.0.1', enabled: false }, meta || {});
    m.id = id;
    m.enabled = !!enable;
    await writeMeta(m);
    P.unloadOne(id);
    if (m.enabled) await P.loadOne(id);
    await P.render();
    return m;
  };

  P.setEnabled = async function (id, enabled, ctx) {
    const meta = await readMeta(id);
    if (!meta) throw new Error('插件不存在：' + id);
    if (enabled) {
      const ask = ctx && ctx.confirm ? ctx.confirm : (opts) => AH.ui.confirm(opts);
      const ok = await ask({ title: '启用插件', text: id + ' 的代码将获得页面全部权限（可读写 VFS、读取配置、发网络请求）。只启用你信任的插件。', rememberKey: 'plugin-enable' });
      if (!ok) return '用户取消了启用';
    }
    meta.enabled = enabled;
    await writeMeta(meta);
    if (enabled) await P.loadOne(id); else P.unloadOne(id);
    await P.render();
    return (enabled ? '已启用 ' : '已禁用 ') + id;
  };

  P.remove = async function (id, ctx) {
    const ask = ctx && ctx.confirm ? ctx.confirm : (opts) => AH.ui.confirm(opts);
    const ok = await ask({ title: '删除插件', text: '将删除 /plugins/' + id + '.js 与 .json，并注销它注册的工具。', danger: true });
    if (!ok) return '用户取消了删除';
    P.unloadOne(id);
    try { await VFS.remove(DIR + '/' + id + '.js'); } catch (e) {}
    try { await VFS.remove(DIR + '/' + id + '.json'); } catch (e) {}
    await P.render();
    return '已删除插件：' + id;
  };

  /* ============================================================
     官方插件库（GitHub Pages）
     清单：https://qiujunawa.github.io/AOH_Plugins/index.json
     ============================================================ */
  const LIB = (P.lib = {
    base: 'https://qiujunawa.github.io/AOH_Plugins/',
    manifest: 'index.json',
    ttl: 5 * 60 * 1000,
    maxBytes: 1024 * 1024,
    cache: null,
    filter: '',
    autoTried: false
  });

  function libBase() { return LIB.base.replace(/\/+$/, '') + '/'; }
  function libResolve(file) {
    const f = String(file || '');
    return /^https?:\/\//i.test(f) ? f : libBase() + f.replace(/^\/+/, '');
  }
  function libNormalize(e) {
    if (!e || typeof e !== 'object') return null;
    const id = String(e.id || '').trim();
    if (!validId(id)) return null;
    return {
      id,
      name: String(e.name || id).trim() || id,
      version: String(e.version || '0.0.0').trim() || '0.0.0',
      description: String(e.description || '').trim(),
      author: String(e.author || '').trim(),
      tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 8) : [],
      file: String(e.file || (id + '.js')).trim() || (id + '.js'),
      tools: Array.isArray(e.tools) ? e.tools.map(String).slice(0, 20) : [],
      homepage: String(e.homepage || '').trim()
    };
  }

  async function fetchLib(force) {
    const now = Date.now();
    if (!force && LIB.cache && now - LIB.cache.at < LIB.ttl) return LIB.cache;
    const url = libBase() + LIB.manifest + (force ? '?t=' + now : '');
    let resp;
    try { resp = await fetch(url, { cache: force ? 'no-store' : 'default' }); }
    catch (e) { throw new Error('无法连接插件库（网络/CORS）：' + (e && e.message ? e.message : e)); }
    if (!resp.ok) throw new Error('插件库清单 HTTP ' + resp.status + '：' + url);
    let j;
    try { j = await resp.json(); } catch (e) { throw new Error('插件库清单不是合法 JSON：' + url); }
    const raw = Array.isArray(j) ? j : (j && Array.isArray(j.plugins) ? j.plugins : []);
    LIB.cache = { at: now, url, plugins: raw.map(libNormalize).filter(Boolean), rawCount: raw.length };
    return LIB.cache;
  }

  async function fetchLibCode(entry, bust) {
    const base = libResolve(entry.file);
    if (!/^https?:\/\//i.test(base)) throw new Error('插件地址不合法：' + base);
    const url = bust ? base + (base.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now() : base;
    let resp;
    try { resp = await fetch(url, bust ? { cache: 'no-store' } : undefined); }
    catch (e) { throw new Error('下载插件失败（网络/CORS）：' + (e && e.message ? e.message : e)); }
    if (!resp.ok) throw new Error('下载插件失败 HTTP ' + resp.status + '：' + base);
    const code = await resp.text();
    if (!code.trim()) throw new Error('插件代码为空：' + base);
    if (code.length > LIB.maxBytes) throw new Error('插件代码 ' + code.length + ' 字节，超过 1MB 上限');
    return { code, url: base };
  }

  P.libEntries = async function (query, force) {
    const lib = await fetchLib(force);
    const q = String(query || '').trim().toLowerCase();
    const items = q ? lib.plugins.filter((p) =>
      (p.id + ' ' + p.name + ' ' + p.description + ' ' + p.tags.join(' ') + ' ' + p.tools.join(' ')).toLowerCase().includes(q)
    ) : lib.plugins;
    const local = await P.list();
    return { lib, items, local, q };
  };

  P.libListText = async function (query) {
    try {
      const { lib, items, local, q } = await P.libEntries(query, false);
      if (!items.length) {
        return q ? '插件库里没有匹配「' + q + '」的插件（共 ' + lib.plugins.length + ' 个）' : '插件库清单为空：' + lib.url;
      }
      const lines = items.map((p) => {
        const inst = local.find((x) => x.id === p.id);
        return '- ' + p.id + ' | ' + p.name + ' | v' + p.version +
          (p.tools.length ? ' | 工具: ' + p.tools.join(', ') : '') +
          (p.tags.length ? ' | #' + p.tags.join(' #') : '') +
          ' | ' + (inst ? ('已安装' + (inst.enabled ? '·已启用' : '·未启用')) : '未安装') +
          (p.description ? '\n    ' + p.description : '');
      });
      return '插件库共 ' + lib.plugins.length + ' 个' + (q ? ('（匹配「' + q + '」' + items.length + ' 个）') : '') +
        '，清单：' + lib.url + '\n' + lines.join('\n') +
        '\n\n安装用 plugin_lib_install（id=上面的 id）。装完默认未启用，要调用还需 plugin_toggle。';
    } catch (e) { return '读取插件库失败：' + (e && e.message ? e.message : e); }
  };

  P.libInstall = async function (opts, ctx) {
    const a = opts || {};
    const libId = String(a.id || '').trim();
    const rawUrl = String(a.url || '').trim();
    if (!libId && !rawUrl) throw new Error('id 和 url 至少给一个');
    const ask = ctx && ctx.confirm ? ctx.confirm : (o) => AH.ui.confirm(o);
    let id, name, version, description = '', sourceUrl, code;

    if (libId) {
      if (!validId(libId)) throw new Error('插件 id 只能用字母、数字、下划线、横线、点');
      const { lib } = await P.libEntries('', true);
      const entry = lib.plugins.find((p) => p.id === libId);
      if (!entry) throw new Error('插件库里没有 ' + libId + '，请先刷新插件库');
      const src = await fetchLibCode(entry, true);
      id = entry.id; name = entry.name; version = entry.version; description = entry.description;
      sourceUrl = src.url; code = src.code;
    } else {
      if (!/^https?:\/\//i.test(rawUrl)) throw new Error('url 必须是 http(s) 直链');
      const guessed = (rawUrl.split('?')[0].split('/').pop() || '').replace(/\.js$/i, '');
      if (!validId(guessed)) throw new Error('无法从 URL 推断插件 id，请改用插件库 id');
      id = guessed;
      name = String(a.name || id).trim() || id;
      version = '0.0.0';
      const src = await fetchLibCode({ file: rawUrl }, true);
      sourceUrl = rawUrl; code = src.code;
    }

    const exists = !!(await readMeta(id));
    if (exists && !a.overwrite) throw new Error('插件 ' + id + ' 已存在。要覆盖请传 overwrite=true');
    const enable = !!a.enable;
    const ok = await ask({
      title: '从官方插件库安装',
      text: '插件：' + name + '（' + id + ' v' + version + '）' + (enable ? '\n安装后立即启用' : '\n安装后默认未启用') +
        (exists ? '\n将覆盖已有的同名插件' : '') +
        '\n\n来源：' + sourceUrl +
        (description ? '\n说明：' + description : '') +
        '\n\n插件拥有页面全部权限（读写 VFS、读取配置、发网络请求）。\n\n代码摘录：\n' + U.cut(code, 900),
      rememberKey: 'plugin-lib-install'
    });
    if (!ok) return '用户取消了插件安装';

    await P.save(id, code, { name, version, description, enabled: enable }, enable);
    const tools = P.toolNames(id);
    return '已' + (exists ? '覆盖安装' : '安装') + '插件 ' + id + '（' + (enable ? '已启用' : '未启用') + '）' +
      (tools.length ? '，注册工具：' + tools.join(', ') : '') +
      (enable ? '' : '。要用它的工具请先启用');
  };

  /* ============================================================
     插件页 UI
     ============================================================ */
  const $ = (id) => document.getElementById(id);

  P.render = async function () {
    const list = $('pluginList');
    if (!list) return;
    const metas = await P.list();
    list.innerHTML = '';
    if (!metas.length) {
      list.innerHTML = '<div class="empty-tip">还没有插件。插件是运行在页面里的 JS，可注册自己的工具给 Agent 调用。</div>';
      P.renderLib(metas);
      return;
    }
    for (const m of metas) {
      const card = document.createElement('div');
      card.className = 'plugin-card';
      const tools = P.toolNames(m.id);
      card.innerHTML = '<div class="plugin-top"><div><b>' + U.esc(m.name) + '</b>' +
        '<span class="plugin-id">' + U.esc(m.id) + ' · v' + U.esc(m.version) + '</span></div>' +
        '<span class="plugin-state ' + (m.enabled ? 'on' : '') + '">' + (m.enabled ? '已启用' : '未启用') + '</span></div>' +
        '<div class="plugin-tools">' + (tools.length ? '工具：' + tools.map(U.esc).join(', ') : '未注册工具') + '</div>' +
        '<div class="plugin-actions"></div>';
      const actions = card.querySelector('.plugin-actions');
      const toggle = document.createElement('button');
      toggle.className = 'chip-btn';
      toggle.textContent = m.enabled ? '禁用' : '启用';
      toggle.addEventListener('click', async () => {
        try { await P.setEnabled(m.id, !m.enabled); AH.ui.toast((m.enabled ? '已禁用 ' : '已启用 ') + m.id, 'ok'); }
        catch (e) { AH.ui.toast(e.message, 'err'); }
      });
      const edit = document.createElement('button');
      edit.className = 'chip-btn';
      edit.textContent = '编辑';
      edit.addEventListener('click', () => P.openEditor(m));
      const del = document.createElement('button');
      del.className = 'chip-btn danger';
      del.textContent = '删除';
      del.addEventListener('click', async () => {
        try { await P.remove(m.id); AH.ui.toast('已删除 ' + m.id, 'ok'); } catch (e) { AH.ui.toast(e.message, 'err'); }
      });
      actions.append(toggle, edit, del);
      list.appendChild(card);
    }
    P.renderLib(metas);
  };

  P.renderLib = async function (metas) {
    const grid = $('pluginLibGrid');
    if (!grid) return;
    if (!LIB.cache) {
      grid.innerHTML = '<div class="empty-tip">' + (P._libLoading ? '正在加载官方插件库…' : '点「刷新插件库」加载官方清单') + '</div>';
      return;
    }
    const local = Array.isArray(metas) ? metas : await P.list();
    const q = LIB.filter.trim().toLowerCase();
    const items = LIB.cache.plugins.filter((p) => {
      if (!q) return true;
      return (p.id + ' ' + p.name + ' ' + p.description + ' ' + p.tags.join(' ') + ' ' + p.tools.join(' ')).toLowerCase().includes(q);
    });
    if (!items.length) {
      grid.innerHTML = '<div class="empty-tip">' + (LIB.cache.plugins.length ? '没有匹配的插件' : '官方插件库是空的') + '</div>';
      return;
    }
    const hint = $('pluginLibHint');
    if (hint && !P._libLoading) {
      const installed = local.filter((x) => LIB.cache.plugins.some((y) => y.id === x.id)).length;
      const skipped = LIB.cache.rawCount - LIB.cache.plugins.length;
      hint.textContent = '共 ' + LIB.cache.plugins.length + ' 个 · 已安装 ' + installed + (skipped > 0 ? ' · 跳过 ' + skipped + ' 条非法条目' : '');
    }

    grid.innerHTML = '';
    for (const p of items) {
      const inst = local.find((x) => x.id === p.id);
      const card = document.createElement('div');
      card.className = 'lib-card' + (inst ? ' installed' : '');
      card.innerHTML = '<div class="lib-top"><b>' + U.esc(p.name) + '</b><span class="lib-ver">v' + U.esc(p.version) + '</span></div>' +
        '<div class="lib-desc">' + U.esc(p.description || '（无描述）') + '</div>' +
        (p.tools.length ? '<div class="lib-meta">' + p.tools.map((t) => '<span class="lib-tag">' + U.esc(t) + '</span>').join('') + '</div>' : '') +
        '<div class="lib-acts"></div>';
      const acts = card.querySelector('.lib-acts');
      const btn = document.createElement('button');
      btn.className = 'chip-btn';
      btn.textContent = inst ? '重新安装' : '安装';
      btn.addEventListener('click', async () => {
        try {
          const r = await P.libInstall({ id: p.id, overwrite: !!inst }, { confirm: AH.ui.confirm });
          AH.ui.toast(r, 'ok', 3800);
          await P.render();
        } catch (e) { AH.ui.toast(e.message, 'err', 5000); }
      });
      acts.appendChild(btn);
      if (p.homepage) {
        const home = document.createElement('button');
        home.className = 'chip-btn';
        home.textContent = '主页';
        home.addEventListener('click', () => window.open(p.homepage, '_blank', 'noopener'));
        acts.appendChild(home);
      }
      if (inst) {
        const st = document.createElement('span');
        st.className = 'lib-state';
        st.textContent = inst.enabled ? '已安装 · 已启用' : '已安装';
        acts.appendChild(st);
      }
      grid.appendChild(card);
    }
  };

  P.refreshLib = async function (force) {
    const hint = $('pluginLibHint');
    P._libLoading = true;
    if (hint) hint.textContent = '正在加载…';
    await P.renderLib();
    try {
      const lib = await fetchLib(!!force);
      await P.renderLib();
      if (hint) {
        const local = await P.list();
        const installed = local.filter((p) => lib.plugins.some((x) => x.id === p.id)).length;
        const skipped = lib.rawCount - lib.plugins.length;
        hint.textContent = '共 ' + lib.plugins.length + ' 个 · 已安装 ' + installed + (skipped > 0 ? ' · 跳过 ' + skipped + ' 条非法条目' : '');
      }
    } catch (e) {
      if (hint) hint.textContent = '加载失败';
      const grid = $('pluginLibGrid');
      if (grid) grid.innerHTML = '<div class="empty-tip">' + U.esc(e.message || String(e)) + '</div>';
    } finally {
      P._libLoading = false;
    }
  };

  P.open = function () {
    P.render();
    if (!LIB.cache && !LIB.autoTried) {
      LIB.autoTried = true;
      P.refreshLib(false);
    }
  };

  P.openEditor = async function (meta) {
    const box = $('pluginEditor');
    if (!box) return;
    box.hidden = false;
    $('pluginId').value = meta ? meta.id : '';
    $('pluginId').disabled = !!meta;
    $('pluginName').value = meta ? meta.name : '';
    $('pluginVersion').value = meta ? meta.version : '0.0.1';
    $('pluginEnabled').checked = meta ? !!meta.enabled : false;
    $('pluginCode').value = meta ? (await VFS.read(DIR + '/' + meta.id + '.js')) : P.EXAMPLE;
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  P.init = function () {
    const page = $('pluginsPage');
    if (!page) return;
    $('btnPluginNew').addEventListener('click', () => P.openEditor(null));
    $('btnLibRefresh').addEventListener('click', () => P.refreshLib(true));
    $('pluginLibSearch').addEventListener('input', () => {
      LIB.filter = $('pluginLibSearch').value;
      P.renderLib();
    });
    $('btnPluginCancel').addEventListener('click', () => { $('pluginEditor').hidden = true; });
    $('btnPluginSave').addEventListener('click', async () => {
      try {
        const id = $('pluginId').value.trim();
        const code = $('pluginCode').value;
        const meta = { name: $('pluginName').value.trim() || id, version: $('pluginVersion').value.trim() || '0.0.1' };
        await P.save(id, code, meta, $('pluginEnabled').checked);
        AH.ui.toast('已保存插件 ' + id, 'ok');
        $('pluginEditor').hidden = true;
      } catch (e) { AH.ui.toast(e.message, 'err'); }
    });
    P.render();
    P.renderLib();
  };

  P.EXAMPLE = [
    '// 示例 1：注册一个 hello 工具，AI 可在后续轮次调用',
    'AgentAPI.defineTool("hello", {',
    '  description: "向指定名字打招呼",',
    '  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }',
    '}, async (args) => "你好，" + (args.name || "世界"));',
    '',
    '// 示例 2：用户消息之后注入一条 system 消息',
    'const offHook = AgentAPI.registerHook("afterUserMessage", async ({ userMessage }) => ({',
    '  system: "当前是测试环境；回答前先说明这一句是插件注入的系统提醒。"',
    '}));',
    '',
    'onUnload(() => { offHook(); /* 清理定时器/监听器 */ });'
  ].join('\n');
})();
