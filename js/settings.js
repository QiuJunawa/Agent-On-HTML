/* ============================================================
   settings.js · 设置面板、主题、数据管理
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;
  const cfg = AH.cfg;

  const PROVIDERS = {
    deepseek: { base: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-flash'] },
    zhipu: { base: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.7-flash', 'glm-4.5-air', 'glm-4-plus'] },
    openai: { base: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1'] },
    qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'] },
    kimi: { base: 'https://api.moonshot.cn/v1', models: ['kimi-k2', 'moonshot-v1-8k'] },
    ark: { base: 'https://ark.cn-beijing.volces.com/api/v3', models: ['doubao-seed-1-6-250615'] },
    ollama: { base: 'http://localhost:11434/v1', models: ['qwen2.5:7b', 'llama3.1:8b'] }
  };

  const S = (AH.settings = {});

  const $ = (id) => document.getElementById(id);

  S.init = function () {
    const modal = $('settingsModal');
    if (!modal) return;
    fillProviders();
    fillModelList();
    fillForm();
    fillToolSwitches();
    bindTabs();
    bindFields();
    bindData();
    S.applyUI();
    buildVersionInfo();

    // 遮罩点击关闭、Esc 关闭、data-close
    modal.addEventListener('click', (e) => { if (e.target === modal) S.close(); });
    modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => S.close()));
  };

  S.applyUI = function () {
    const theme = cfg.get('theme');
    document.body.classList.toggle('light', theme === 'light');
    const rail = document.getElementById('railTheme');
    if (rail) {
      rail.innerHTML = AH.ui.icon(theme === 'light' ? 'sun' : 'moon');
      rail.dataset.iconDone = '1';
    }
    document.documentElement.style.setProperty('--fs', (Number(cfg.get('fontSize')) || 15) + 'px');
    applyFonts();
    document.body.classList.toggle('compact', !!cfg.get('compact'));
    AH.chat.updateModelChip && AH.chat.updateModelChip();
    AH.chat.redrawCharts && AH.chat.redrawCharts();
  };

  S.toggleTheme = function () {
    cfg.set('theme', cfg.get('theme') === 'light' ? 'dark' : 'light');
    S.applyUI();
    syncThemeSeg();
  };

  function syncThemeSeg() {
    document.querySelectorAll('#themeSeg .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.theme === cfg.get('theme')));
  }

  function fillProviders() {
    const sel = $('cfgProvider');
    for (const [k, v] of Object.entries(PROVIDERS)) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = k;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => {
      const p = PROVIDERS[sel.value];
      if (!p) return;
      $('cfgBaseUrl').value = p.base;
      cfg.set('baseUrl', p.base);
      $('cfgModel').value = p.models[0];
      cfg.set('model', p.models[0]);
      fillModelList(p.models);
      AH.chat.updateModelChip && AH.chat.updateModelChip();
      AH.ui.toast('已填入 ' + sel.value + ' 默认地址与模型', 'ok', 1500);
      sel.value = '';
    });
  }

  function fillModelList(models) {
    const list = $('modelList');
    list.innerHTML = '';
    for (const m of models || []) {
      const opt = document.createElement('option');
      opt.value = m;
      list.appendChild(opt);
    }
  }

  function fillForm() {
    $('cfgBaseUrl').value = cfg.get('baseUrl') || '';
    $('cfgApiKey').value = cfg.get('apiKey') || '';
    $('cfgModel').value = cfg.get('model') || '';
    $('cfgTemp').value = String(cfg.get('temperature'));
    $('tempVal').textContent = String(cfg.get('temperature'));
    $('cfgReasoning').value = cfg.get('reasoning') || '';
    $('cfgMaxOut').value = cfg.get('maxOut') || '';
    $('cfgMaxLoops').value = cfg.get('maxLoops') || 16;
    $('cfgAgentMode').value = cfg.get('agentMode') || 'auto';
    $('cfgSystem').value = cfg.get('systemPrompt') || AH.agent.DEFAULT_SYSTEM;
    $('cfgLazy').checked = cfg.get('lazyTools') !== false;
    $('cfgToolTimeout').value = cfg.get('toolTimeoutSec') || 120;
    $('cfgMaxCalls').value = cfg.get('maxCalls') || 0;
    $('cfgMaxCost').value = cfg.get('maxCost') || 0;
    $('cfgMaxWall').value = cfg.get('maxWall') || 0;
    $('cfgMemory').checked = cfg.get('memory') !== false;
    $('cfgTitleGen').checked = cfg.get('titleGen') !== false;
    $('cfgProxy').value = cfg.get('proxy') || '';
    $('cfgFontSize').value = String(cfg.get('fontSize') || 15);
    $('cfgFontUI').value = cfg.get('fontUI') || '';
    $('cfgFontBody').value = cfg.get('fontBody') || '';
    $('cfgGitPlatform').value = cfg.get('gitPlatform') || 'github';
    $('cfgGitRepo').value = cfg.get('gitRepo') || '';
    $('cfgGitToken').value = cfg.get('gitToken') || '';
    $('cfgGitBranch').value = cfg.get('gitBranch') || '';
    $('cfgCompact').checked = !!cfg.get('compact');
    $('cfgSendKey').value = cfg.get('sendKey') || 'enter';
    syncThemeSeg();
    const models = (PROVIDERS[Object.keys(PROVIDERS).find((k) => PROVIDERS[k].base === cfg.get('baseUrl'))] || {}).models;
    fillModelList(models || []);
  }

  function bindTabs() {
    document.querySelectorAll('.settings-nav button').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.settings-nav button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        document.querySelectorAll('.settings-pane, .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === b.dataset.tab));
      });
    });
  }

  function bindFields() {
    const setStr = (id, key, trim) => {
      $(id).addEventListener('change', () => {
        let v = $(id).value;
        if (trim) v = v.trim();
        cfg.set(key, v);
        if (key === 'baseUrl' || key === 'model' || key === 'apiKey') AH.chat.updateModelChip && AH.chat.updateModelChip();
      });
    };
    setStr('cfgBaseUrl', 'baseUrl', true);
    setStr('cfgApiKey', 'apiKey', true);
    setStr('cfgModel', 'model', true);
    setStr('cfgProxy', 'proxy', true);
    setStr('cfgSystem', 'systemPrompt', false);
    let sysTimer = null;
    $('cfgSystem').addEventListener('input', () => {
      if (sysTimer) clearTimeout(sysTimer);
      sysTimer = setTimeout(() => { cfg.set('systemPrompt', $('cfgSystem').value); }, 600);
    });

    $('cfgTemp').addEventListener('input', () => {
      $('tempVal').textContent = $('cfgTemp').value;
      cfg.set('temperature', Number($('cfgTemp').value));
    });
    $('cfgReasoning').addEventListener('change', () => cfg.set('reasoning', $('cfgReasoning').value));
    $('cfgMaxOut').addEventListener('change', () => cfg.set('maxOut', Math.max(0, parseInt($('cfgMaxOut').value, 10) || 0)));
    $('cfgMaxLoops').addEventListener('change', () => cfg.set('maxLoops', Math.max(1, Math.min(60, parseInt($('cfgMaxLoops').value, 10) || 16))));
    $('cfgAgentMode').addEventListener('change', () => { cfg.set('agentMode', $('cfgAgentMode').value); });
    $('cfgLazy').addEventListener('change', () => cfg.set('lazyTools', $('cfgLazy').checked));
    $('cfgToolTimeout').addEventListener('change', () => cfg.set('toolTimeoutSec', Math.max(10, Math.min(900, parseInt($('cfgToolTimeout').value, 10) || 120))));
    $('cfgMaxCalls').addEventListener('change', () => cfg.set('maxCalls', Math.max(0, parseInt($('cfgMaxCalls').value, 10) || 0)));
    $('cfgMaxCost').addEventListener('change', () => cfg.set('maxCost', Math.max(0, Number($('cfgMaxCost').value) || 0)));
    $('cfgMaxWall').addEventListener('change', () => cfg.set('maxWall', Math.max(0, parseInt($('cfgMaxWall').value, 10) || 0)));
    $('cfgMemory').addEventListener('change', () => cfg.set('memory', $('cfgMemory').checked));
    $('cfgTitleGen').addEventListener('change', () => cfg.set('titleGen', $('cfgTitleGen').checked));
    $('btnResetSystem').addEventListener('click', async () => {
      const ok = await AH.ui.confirm({ title: '恢复默认提示词', text: '当前自定义的系统提示词会被覆盖。', danger: true });
      if (!ok) return;
      $('cfgSystem').value = AH.agent.DEFAULT_SYSTEM;
      cfg.set('systemPrompt', AH.agent.DEFAULT_SYSTEM);
      AH.ui.toast('已恢复默认提示词', 'ok');
    });

    $('btnToggleKey').addEventListener('click', () => {
      const k = $('cfgApiKey');
      k.type = k.type === 'password' ? 'text' : 'password';
      $('btnToggleKey').textContent = k.type === 'password' ? '显示' : '隐藏';
    });

    $('btnTestConn').addEventListener('click', () => S.testConnection());

    document.querySelectorAll('#themeSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
      cfg.set('theme', b.dataset.theme);
      S.applyUI();
      syncThemeSeg();
    }));
    $('cfgFontUI').addEventListener('change', () => {
      cfg.set('fontUI', $('cfgFontUI').value.trim());
      applyFonts();
    });
    $('cfgFontBody').addEventListener('change', () => {
      cfg.set('fontBody', $('cfgFontBody').value.trim());
      applyFonts();
    });
    $('cfgFontSize').addEventListener('input', () => {
      cfg.set('fontSize', Number($('cfgFontSize').value));
      document.documentElement.style.setProperty('--fs', $('cfgFontSize').value + 'px');
    });
    $('cfgCompact').addEventListener('change', () => { cfg.set('compact', $('cfgCompact').checked); S.applyUI(); });
    $('cfgSendKey').addEventListener('change', () => cfg.set('sendKey', $('cfgSendKey').value));
    $('cfgGitPlatform').addEventListener('change', () => cfg.set('gitPlatform', $('cfgGitPlatform').value));
    $('cfgGitRepo').addEventListener('change', () => cfg.set('gitRepo', $('cfgGitRepo').value.trim()));
    $('cfgGitToken').addEventListener('change', () => cfg.set('gitToken', $('cfgGitToken').value.trim()));
    $('cfgGitBranch').addEventListener('change', () => cfg.set('gitBranch', $('cfgGitBranch').value.trim()));
    $('btnGitTest').addEventListener('click', async () => {
      try {
        AH.ui.toast(await AH.git.test(), 'ok', 3000);
      } catch (e) { AH.ui.toast(e.message, 'err', 5000); }
    });
  }

  function applyFonts() {
    const root = document.documentElement.style;
    const ui = String(cfg.get('fontUI') || '').trim();
    const body = String(cfg.get('fontBody') || '').trim();
    if (ui) root.setProperty('--font-ui', ui); else root.removeProperty('--font-ui');
    if (body) root.setProperty('--font-body', body); else root.removeProperty('--font-body');
  }
  S.applyFonts = applyFonts;

  function fillToolSwitches() {
    const box = $('toolSwitches');
    box.innerHTML = '';
    const disabled = new Set(cfg.get('disabledTools') || []);
    const groups = AH.tools.GROUPS;
    const order = AH.tools.GROUP_ORDER;
    // 按分组列出，同组工具共享说明
    for (const g of order) {
      const head = document.createElement('div');
      head.style.cssText = 'font-size:11.5px;color:var(--text-3);margin:10px 0 2px;letter-spacing:.4px';
      head.textContent = groups[g].label;
      box.appendChild(head);
      for (const name of groups[g].tools) {
        const spec = AH.tools.SPECS[name];
        if (!spec) continue;
        const row = document.createElement('label');
        row.className = 'tool-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !disabled.has(name);
        cb.addEventListener('change', () => {
          const now = new Set(cfg.get('disabledTools') || []);
          if (cb.checked) now.delete(name); else now.add(name);
          cfg.set('disabledTools', [...now]);
        });
        const tn = document.createElement('span');
        tn.className = 'tn';
        tn.textContent = name;
        const td = document.createElement('span');
        td.className = 'td';
        td.textContent = U.clip(spec.function.description, 60);
        row.appendChild(cb); row.appendChild(tn); row.appendChild(td);
        box.appendChild(row);
      }
    }
  }

  /* ============================================================
     测试连接
     ============================================================ */
  S.testConnection = async function () {
    const key = String(cfg.get('apiKey') || '').trim();
    if (!key) return AH.ui.toast('先填写 API Key', 'warn');
    const btn = $('btnTestConn');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const base = String(cfg.get('baseUrl') || '').replace(/\/+$/, '');
      const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: cfg.get('model'),
          messages: [{ role: 'user', content: '回复 ok' }],
          max_tokens: 8,
          temperature: 0,
          stream: false
        })
      });
      const text = await resp.text();
      if (!resp.ok) {
        let detail = text;
        try { const j = JSON.parse(text); detail = j.error && (j.error.message || j.error); } catch (e) {}
        throw new Error('HTTP ' + resp.status + '：' + U.clip(detail, 300));
      }
      const j = JSON.parse(text);
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      AH.ui.toast('连接成功：' + U.clip(String(content || 'ok').trim(), 30), 'ok', 3200);
    } catch (e) {
      let msg = e.message || String(e);
      if (/Failed to fetch|NetworkError|CORS/i.test(msg)) msg += '（若是浏览器直连被拒，请换支持 CORS 的服务商或自建代理）';
      AH.ui.toast('连接失败：' + U.clip(msg, 300), 'err', 6000);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  };

  /* ============================================================
     数据
     ============================================================ */
  function bindData() {
    $('btnExportAll').addEventListener('click', () => S.exportAll());
    $('btnImportAll').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', async () => {
      const f = $('importFile').files[0];
      $('importFile').value = '';
      if (f) await S.importAll(f);
    });
    $('btnClearConvs').addEventListener('click', async () => {
      const ok = await AH.ui.confirm({ title: '清空全部对话', text: '所有会话与存档文件会被删除，VFS 其他文件不受影响。', danger: true });
      if (!ok) return;
      for (const s of AH.chat.sessions) await AH.db.del('kv', 'conv:' + s.id);
      AH.chat.sessions = [];
      AH.chat.currentId = null;
      AH.chat.conv = [];
      await AH.db.put('kv', { k: 'session_index', v: [] });
      await AH.chat.newSession();
      AH.ui.toast('已清空全部对话', 'ok');
    });
    $('btnResetAll').addEventListener('click', async () => {
      const ok = await AH.ui.confirm({ title: '清空全部数据', text: '文件、对话、记忆、设置都会被删除，且不可恢复。建议先导出备份。', danger: true });
      if (!ok) return;
      try {
        if (AH.db._db) { AH.db._db.close(); AH.db._db = null; }
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
        }
      } catch (e) {}
      localStorage.removeItem('xiaohe_cfg_v1');
      location.reload();
    });
    S.refreshStorage();
  }

  S.refreshStorage = async function () {
    const el = $('storageInfo');
    if (!el) return;
    let quota = '';
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        quota = '可用配额 ' + U.fmtSize(est.quota || 0) + '，已用 ' + U.fmtSize(est.usage || 0) + '。';
      }
    } catch (e) {}
    const st = AH.vfs.stats();
    const mode = AH.db.mode === 'idb' ? 'IndexedDB' : '内存模式（' + (AH.db.reason || '不可用') + '，关页面即丢）';
    el.textContent = '存储：' + mode + ' · ' + st.files + ' 个文件 / ' + U.fmtChars(st.chars) + '。' + quota;
  };

  S.exportAll = async function () {
    const ok = await AH.ui.confirm({
      title: '导出全部数据',
      text: '导出内容包含文件、对话、记忆与设置。设置里有 API Key，文件请妥善保管、不要公开分享。',
      danger: true,
      okText: '导出'
    });
    if (!ok) return;
    AH.ui.toast('正在打包…', 'ok', 1200);
    try {
      const exported = await AH.vfs.exportFiles();
      const sessions = [];
      for (const s of AH.chat.sessions) {
        sessions.push({ meta: s, conv: await AH.chat.loadConv(s.id) });
      }
      const data = {
        app: 'xiaohe',
        version: 2,
        exportedAt: Date.now(),
        config: cfg.data,
        files: exported,
        sessions,
        memory: await AH.memory.load(),
        todos: AH.todos.items
      };
      const name = 'xiaohe-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      U.downloadText(JSON.stringify(data), name, 'application/json');
      AH.ui.toast('已导出 ' + name, 'ok', 2600);
    } catch (e) { AH.ui.error('导出失败：' + e.message); }
  };

  S.importAll = async function (file) {
    let data;
    try { data = JSON.parse(await U.readFileText(file)); }
    catch (e) { return AH.ui.error('备份文件不是合法 JSON'); }
    if (!data || data.app !== 'xiaohe' || !data.files || !Array.isArray(data.files.files)) {
      return AH.ui.error('不是本应用的备份文件（缺少 files 数组）');
    }
    const ok = await AH.ui.confirm({
      title: '导入备份',
      text: '将用备份中的文件、对话与设置覆盖当前数据。是否继续？',
      danger: true,
      okText: '导入'
    });
    if (!ok) return;
    try {
      if (data.config) {
        cfg.data = { ...AH.cfg.defaults, ...data.config };
        cfg.save();
      }
      await AH.vfs.importFiles(data.files, { replace: true });
      if (Array.isArray(data.sessions)) {
        for (const s of AH.chat.sessions) await AH.db.del('kv', 'conv:' + s.id);
        AH.chat.sessions = [];
        for (const item of data.sessions) {
          if (!item.meta || !item.meta.id) continue;
          AH.chat.sessions.push(item.meta);
          await AH.db.put('kv', { k: 'conv:' + item.meta.id, v: item.conv || [] });
        }
        await AH.db.put('kv', { k: 'session_index', v: AH.chat.sessions });
      }
      if (Array.isArray(data.memory)) await AH.db.put('kv', { k: 'memory', v: data.memory });
      if (Array.isArray(data.todos)) await AH.db.put('kv', { k: 'todos', v: data.todos });
      AH.memory.items = null;
      AH.todos.loaded = false;
      AH.ui.toast('导入完成，正在刷新…', 'ok', 2200);
      setTimeout(() => location.reload(), 900);
    } catch (e) { AH.ui.error('导入失败：' + e.message); }
  };

  function buildVersionInfo() {
    const el = $('appVersion');
    if (el) el.textContent = '版本 2.0 · 单页 · 无依赖 · ' + (AH.db.mode === 'idb' ? 'IndexedDB' : '内存模式');
  }

  /* ============================================================
     打开 / 关闭
     ============================================================ */
  S.open = function () {
    fillForm();
    AH.settings.refreshStorage();
    buildVersionInfo();
    AH.ui.openModal('settingsModal');
  };
  S.close = function () { AH.ui.closeModal('settingsModal'); };
  S.PROVIDERS = PROVIDERS;
})();
