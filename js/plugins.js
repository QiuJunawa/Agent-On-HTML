/* ============================================================
   plugins.js · 插件管理器
   插件存放在 VFS /plugins/<id>.js + <id>.json。
   启用后代码在 AsyncFunction 中执行，可用 AgentAPI.defineTool 注册工具；
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
    _loading: null
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
      pluginId: id
    };
  }

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
  };

  P.EXAMPLE = [
    '// 示例：注册一个 hello 工具，AI 可在后续轮次调用',
    'AgentAPI.defineTool("hello", {',
    '  description: "向指定名字打招呼",',
    '  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }',
    '}, async (args) => "你好，" + (args.name || "世界"));',
    '',
    'onUnload(() => { /* 清理定时器/监听器 */ });'
  ].join('\n');
})();
