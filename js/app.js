/* ============================================================
   app.js · 启动、文件树、编辑器、待办、任务页、导航
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;
  const VFS = AH.vfs;
  const cfg = AH.cfg;
  const $ = (id) => document.getElementById(id);

  const App = (AH.app = {
    expanded: new Set(['/', '/notes', '/conversations']),
    page: 'chat',
    editor: { path: '', dirty: false, mode: 'text' },
    _treeTimer: null,
    _taskTimer: null
  });

  /* ============================================================
     启动
     ============================================================ */
  async function boot() {
    AH.ui.mountIcons();
    AH.ui.initConfirm();
    cfg.load();

    // 主题/字号尽早生效，避免闪烁
    document.body.classList.toggle('light', cfg.get('theme') === 'light');
    document.documentElement.style.setProperty('--fs', (Number(cfg.get('fontSize')) || 15) + 'px');
    if (cfg.get('compact')) document.body.classList.add('compact');

    try {
      await AH.db.open();
      await VFS.init();
      await AH.todos.load();
    } catch (e) {
      console.error('[boot]', e);
      AH.ui.toast('本地存储初始化失败：' + e.message, 'err', 6000);
    }

    await AH.chat.init();
    AH.settings.init();
    AH.settings.applyUI();
    AH.plugins.init();
    await AH.plugins.loadAll();
    App.bind();
    renderTree();
    renderTodos();
    updateFsStat();
    renderTasks();
    setPage('chat');
    document.body.classList.remove('booting');

    if (AH.db.mode !== 'idb') {
      AH.ui.toast('IndexedDB 不可用（' + (AH.db.reason || '未知') + '），本次数据只存在内存，关页面即丢。', 'warn', 7000);
    }
  }

  /* ============================================================
     文件树
     ============================================================ */
  function renderTree() {
    const tree = $('tree');
    if (!tree) return;
    if (!VFS.ready) { tree.innerHTML = '<div class="tree-empty">初始化中…</div>'; return; }
    tree.innerHTML = '';
    const frag = document.createDocumentFragment();
    const rootChildren = VFS.list('/');
    if (!rootChildren.length) {
      tree.innerHTML = '<div class="tree-empty">还没有文件</div>';
      return;
    }
    for (const n of rootChildren) frag.appendChild(nodeRow(n, 0));
    tree.appendChild(frag);
  }
  App.renderTree = renderTree;

  function nodeRow(node, depth) {
    const row = document.createElement('div');
    row.className = 'node-row' + (node.type === 'dir' ? ' dir' : '') + (node.path === App.editor.path ? ' active' : '');
    row.style.paddingLeft = (8 + depth * 13) + 'px';
    row.dataset.path = node.path;
    const isDir = node.type === 'dir';
    const open = isDir && App.expanded.has(node.path);
    const indent = isDir ? '<span class="twist">' + AH.ui.icon(open ? 'chevron-down' : 'chevron-right') + '</span>'
      : '<span class="twist"></span>';
    const ico = isDir ? AH.ui.icon('folder') : AH.ui.icon(U.isImagePath(node.path) ? 'box' : 'file-text');
    row.innerHTML = indent + '<span class="node-ico">' + ico + '</span>' +
      '<span class="node-name">' + U.esc(U.baseName(node.path) || '/') + '</span>' +
      '<span class="node-size">' + (isDir ? '' : U.fmtSize(node.size || 0)) + '</span>';
    row.title = node.path;
    row.addEventListener('click', () => {
      if (isDir) {
        if (App.expanded.has(node.path)) App.expanded.delete(node.path); else App.expanded.add(node.path);
        renderTree();
      } else {
        App.openFile(node.path);
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showNodeMenu(e.clientX, e.clientY, node);
    });
    const wrap = document.createElement('div');
    wrap.appendChild(row);
    if (isDir && open) {
      let children = [];
      try { children = VFS.list(node.path); } catch (e) { children = []; }
      for (const ch of children) wrap.appendChild(nodeRow(ch, depth + 1));
    }
    return wrap;
  }

  function showNodeMenu(x, y, node) {
    const isDir = node.type === 'dir';
    const items = [];
    if (!isDir) items.push({ label: '打开', icon: 'file-text', onClick: () => App.openFile(node.path) });
    items.push({
      label: isDir ? '新建文件' : '同名副本',
      icon: 'file-plus',
      onClick: () => isDir ? App.newFile(node.path) : App.duplicate(node.path)
    });
    if (isDir) {
      items.push({ label: '新建文件夹', icon: 'folder-plus', onClick: () => App.newDir(node.path) });
      items.push({ label: '下载文件夹 (.zip)', icon: 'download', onClick: () => App.downloadFolder(node.path) });
    }
    if (!isDir) items.push({ label: '下载', icon: 'download', onClick: () => App.download(node.path) });
    items.push({ sep: true });
    items.push({
      label: '重命名', icon: 'edit', onClick: async () => {
        const to = prompt('新路径', node.path);
        if (!to || to === node.path) return;
        try { await VFS.move(node.path, to); renderTree(); if (App.editor.path === node.path) App.editor.path = to; }
        catch (e) { AH.ui.error(e); }
      }
    });
    items.push({
      label: '删除', icon: 'trash', danger: true, onClick: async () => {
        const ok = await AH.ui.confirm({ title: '删除', text: '删除 ' + node.path + '？此操作可在对话里用撤销恢复（仅限 Agent 操作记录）。', rememberKey: '' });
        if (!ok) return;
        try {
          await VFS.remove(node.path);
          if (App.editor.path === node.path) App.closeEditor(true);
          renderTree();
        } catch (e) { AH.ui.error(e); }
      }
    });
    AH.ui.contextMenu(x, y, items);
  }

  App.newFile = async function (dir) {
    const def = (dir === '/' ? '' : dir) + '/untitled.md';
    const path = prompt('文件路径', def);
    if (!path) return;
    try {
      if (VFS.exists(path)) return AH.ui.toast('已存在：' + path, 'warn');
      await VFS.write(path, '');
      renderTree();
      App.openFile(path);
    } catch (e) { AH.ui.error(e); }
  };

  App.newDir = async function (dir) {
    const def = (dir === '/' ? '' : dir) + '/new-folder';
    const path = prompt('文件夹路径', def);
    if (!path) return;
    try { await VFS.mkdir(path); renderTree(); }
    catch (e) { AH.ui.error(e); }
  };

  App.duplicate = async function (path) {
    try {
      const content = await VFS.read(path);
      let to = path.replace(/(\.[^.]+)$/, '-copy$1');
      if (to === path) to = path + '-copy';
      await VFS.write(to, content);
      renderTree();
    } catch (e) { AH.ui.error(e); }
  };

  App.download = async function (path) {
    try {
      const content = await VFS.read(path);
      if (U.isImagePath(path)) {
        const a = document.createElement('a');
        a.href = content;
        a.download = U.baseName(path);
        a.click();
      } else U.downloadText(content, U.baseName(path), 'text/plain;charset=utf-8');
    } catch (e) { AH.ui.error(e); }
  };

  App.downloadFolder = async function (path) {
    try {
      AH.ui.toast('正在打包 ' + path + ' …', 'info', 1800);
      const { blob, name, count } = await AH.zip.folder(path);
      U.downloadBlob(blob, name);
      AH.ui.toast('已打包 ' + count + ' 个文件：' + name, 'ok', 2600);
    } catch (e) { AH.ui.error(e); }
  };

  /* ============================================================
     编辑器
     ============================================================ */
  App.openFile = async function (path) {
    if (App.editor.dirty && App.editor.path && App.editor.path !== path) {
      const ok = await AH.ui.confirm({ title: '未保存的修改', text: '当前文件有未保存的修改，切换将丢失。', danger: true, okText: '放弃并切换' });
      if (!ok) return;
    }
    const ta = $('editor');
    const pane = $('editorPane');
    try {
      const node = VFS.stat(path);
      if (!node) throw new Error('文件不存在：' + path);
      if (node.type === 'dir') throw new Error('这是目录');
      const content = await VFS.read(path);
      App.editor.path = path;
      App.editor.dirty = false;
      App.editor.mode = U.isImagePath(path) ? 'image' : /\.html?$/i.test(path) ? 'html' : /\.md$/i.test(path) ? 'md' : 'text';
      $('editorPath').textContent = path;
      $('editorEmpty').hidden = true;
      if (App.editor.mode === 'image') {
        ta.hidden = true;
        $('btnPreview').hidden = false;
        $('btnPreview').textContent = '预览';
        App.showPreview(content);
      } else {
        ta.hidden = false;
        ta.value = content;
        $('preview').hidden = true;
        $('btnPreview').hidden = !(App.editor.mode === 'md' || App.editor.mode === 'html');
        $('btnPreview').textContent = '预览';
      }
      $('btnSave').hidden = false;
      $('btnSave').textContent = '保存';
      pane.dataset.open = '1';
      document.querySelector('.app').classList.remove('no-editor');
      document.querySelector('.app').classList.add('has-editor');
      AH.ui.hideContextMenu();
      ta.focus();
    } catch (e) { AH.ui.error(e); }
  };

  App.saveFile = async function () {
    if (!App.editor.path || App.editor.mode === 'image') return;
    try {
      await VFS.write(App.editor.path, $('editor').value);
      App.editor.dirty = false;
      $('btnSave').textContent = '保存';
      AH.ui.toast('已保存 ' + App.editor.path, 'ok', 1600);
      updateFsStat();
    } catch (e) { AH.ui.error(e); }
  };

  App.showPreview = function (content) {
    const ta = $('editor');
    const preview = $('preview');
    const md = $('mdPreview');
    const iframe = $('htmlPreview');
    const imgBox = $('imgPreview');
    preview.hidden = false;
    ta.hidden = true;
    md.hidden = true; iframe.hidden = true; imgBox.hidden = true;
    if (App.editor.mode === 'md') {
      md.hidden = false;
      md.innerHTML = AH.md.toHtml(content);
      AH.md.renderMathIn(md);
    } else if (App.editor.mode === 'html') {
      iframe.hidden = false;
      iframe.srcdoc = content;
    } else if (App.editor.mode === 'image') {
      imgBox.hidden = false;
      $('imgPreviewImg').src = content;
    }
  };

  App.closeEditor = async function (force) {
    if (!App.editor.path && !$('editorPane').dataset.open) return;
    if (!force && App.editor.dirty) {
      const ok = await AH.ui.confirm({ title: '放弃修改？', text: '当前文件有未保存的修改。', danger: true, okText: '放弃' });
      if (!ok) return;
    }
    App.editor.path = '';
    App.editor.dirty = false;
    $('editorPath').textContent = '未打开文件';
    $('editor').value = '';
    $('editor').hidden = true;
    $('preview').hidden = true;
    $('editorEmpty').hidden = false;
    $('btnSave').hidden = true;
    $('btnPreview').hidden = true;
    delete $('editorPane').dataset.open;
    document.querySelector('.app').classList.remove('has-editor');
    document.querySelector('.app').classList.add('no-editor');
    renderTree();
  };

  App.toggleEditor = function () {
    const app = document.querySelector('.app');
    if (app.classList.contains('has-editor')) App.closeEditor();
    else if (App.editor.path) {
      app.classList.add('has-editor');
      app.classList.remove('no-editor');
    } else {
      AH.ui.toast('先从左侧选一个文件', 'warn', 1800);
    }
  };

  /* ============================================================
     待办
     ============================================================ */
  function renderTodos() {
    const box = $('todoList');
    if (!box) return;
    const items = AH.todos.items || [];
    const done = items.filter((x) => x.done).length;
    $('todoCount').textContent = done + '/' + items.length;
    $('todoClear').hidden = done === 0;
    box.innerHTML = '';
    if (!items.length) {
      box.innerHTML = '<div class="hist-empty" style="padding:10px">暂无待办，让 Agent 用 todo_add 添加</div>';
      return;
    }
    items.slice(-40).forEach((it) => {
      const row = document.createElement('div');
      row.className = 'todo-item' + (it.done ? ' done' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'box';
      cb.checked = !!it.done;
      cb.addEventListener('change', () => { AH.todos.setDone(it.id, cb.checked).catch((e) => AH.ui.error(e)); });
      const tx = document.createElement('span');
      tx.className = 't';
      tx.textContent = it.text;
      row.appendChild(cb); row.appendChild(tx);
      box.appendChild(row);
    });
  }
  App.renderTodos = renderTodos;

  /* ============================================================
     任务页
     ============================================================ */
  function renderTasks() {
    if (App.page !== 'tasks') return;
    const run = AH.chat.runs.get(AH.chat.currentId);
    const log = (run && run.toolLog || []).slice();
    const bg = AH.taskRegistry.list(AH.chat.currentId);
    const activeBtn = document.querySelector('#taskFilter .seg-btn.active');
    const filter = (activeBtn && activeBtn.dataset.filter) || 'all';
    const list = $('taskList');
    const stats = $('taskStats');
    let okCount = 0, errCount = 0, runCount = 0;
    log.forEach((t) => { if (t.status === 'running') runCount++; else if (t.status === 'error') errCount++; else okCount++; });
    bg.forEach((t) => { if (t.status === 'running') runCount++; else if (t.status === 'error') errCount++; else okCount++; });
    stats.innerHTML =
      '<span class="task-chip">本轮调用 <b>' + log.length + '</b></span>' +
      '<span class="task-chip">完成 <b>' + okCount + '</b></span>' +
      (errCount ? '<span class="task-chip err">失败 <b>' + errCount + '</b></span>' : '') +
      (runCount ? '<span class="task-chip run">进行中 <b>' + runCount + '</b></span>' : '') +
      (bg.length ? '<span class="task-chip">后台任务 <b>' + bg.length + '</b></span>' : '');
    list.innerHTML = '';
    const rows = [];
    log.forEach((t) => rows.push({ name: t.name, status: t.status, args: t.args, result: t.result, ms: t.ms, at: t.at }));
    bg.forEach((t) => rows.push({ name: t.name + '（后台）', status: t.status, args: t.args, result: t.result || t.error, ms: t.end ? t.end - t.start : 0, at: t.start }));
    if (filter === 'running') rows.splice(0, rows.length, ...rows.filter((r) => r.status === 'running'));
    if (filter === 'error') rows.splice(0, rows.length, ...rows.filter((r) => r.status === 'error'));
    if (!rows.length) {
      list.innerHTML = '<div class="task-empty">' + (filter === 'all' ? '当前会话还没有工具调用。' : '没有符合条件的任务。') + '</div>';
      return;
    }
    rows.reverse().forEach((r, i) => {
      const el = document.createElement('div');
      el.className = 'task-item ' + (r.status === 'running' ? 'running' : r.status === 'error' ? 'error' : '');
      let resultText = r.result || '';
      if (String(resultText).startsWith('@@card:')) {
        try {
          const card = JSON.parse(String(resultText).slice(7));
          resultText = card.type === 'chart' ? '（图表：' + (card.title || card.chartType) + '）'
            : card.type === 'deliver' ? '（交付：' + card.title + '）'
              : card.type === 'ask' ? '（提问：' + card.question + '）' : '（卡片结果）';
        } catch (e) { resultText = '（卡片结果）'; }
      }
      const detail = U.clip([r.args ? JSON.stringify(r.args) : '', resultText].filter(Boolean).join('\n'), 1200);
      el.innerHTML =
        '<div class="task-top"><span class="num">' + (i + 1) + '</span><span class="nm">' + U.esc(r.name) + '</span>' +
        '<span class="st ' + r.status + '">' + (r.status === 'running' ? '执行中' : r.status === 'error' ? '失败' : '完成') + (r.ms ? ' · ' + U.fmtDuration(r.ms) : '') + '</span></div>' +
        '<div class="task-detail"></div>';
      el.querySelector('.task-detail').textContent = detail || '（无参数）';
      list.appendChild(el);
    });
  }
  App.renderTasks = renderTasks;

  App.refreshTasks = function () {
    if (App._taskTimer) return;
    App._taskTimer = requestAnimationFrame(() => {
      App._taskTimer = null;
      renderTasks();
    });
  };

  /* ============================================================
     VFS 页（浏览 + 预览）
     ============================================================ */
  const VS = (App.vfsState = { cwd: '/', sel: '', view: 'preview', query: '' });

  function vfsPathRow(label, iconName, cls, onClick, meta) {
    const row = document.createElement('div');
    row.className = 'vfs-row' + (cls ? ' ' + cls : '');
    row.innerHTML = '<span class="ico"></span><span class="nm"></span><span class="sz"></span>';
    row.querySelector('.ico').innerHTML = AH.ui.icon(iconName);
    row.querySelector('.nm').textContent = label;
    row.querySelector('.sz').textContent = meta || '';
    row.addEventListener('click', onClick);
    return row;
  }

  function renderVfsList() {
    const list = $('vfsList');
    if (!list) return;
    list.innerHTML = '';
    $('vfsCrumb').textContent = VS.cwd;

    // 搜索模式：显示命中的文件
    if (VS.query) {
      const head = document.createElement('div');
      head.className = 'vfs-hits';
      head.textContent = '搜索结果';
      list.appendChild(head);
      (App._vfsHits || []).forEach((hit) => {
        list.appendChild(vfsPathRow(hit.label, 'file-text', hit.path === VS.sel ? 'active' : '', () => {
          openVfsFile(hit.path);
        }, hit.meta));
      });
      return;
    }

    // 上级目录
    if (VS.cwd !== '/') {
      list.appendChild(vfsPathRow('..', 'chevron-right', 'up', () => {
        VS.cwd = U.parentPath(VS.cwd) || '/';
        VS.sel = '';
        renderVfsList();
      }, ''));
    }

    let nodes = [];
    try { nodes = VFS.list(VS.cwd); }
    catch (e) { list.innerHTML = '<div class="vfs-empty">' + U.esc(e.message) + '</div>'; return; }

    if (!nodes.length) {
      const box = document.createElement('div');
      box.className = 'vfs-empty';
      box.textContent = '这个目录是空的';
      list.appendChild(box);
      return;
    }

    nodes.forEach((n) => {
      const isDir = n.type === 'dir';
      list.appendChild(vfsPathRow(
        U.baseName(n.path) || n.path,
        isDir ? 'folder' : (U.isImagePath(n.path) ? 'box' : 'file-text'),
        n.path === VS.sel ? 'active' : '',
        () => {
          if (isDir) {
            VS.cwd = n.path;
            VS.sel = '';
            renderVfsList();
          } else {
            openVfsFile(n.path);
          }
        },
        isDir ? '' : U.fmtSize(n.size || 0)
      ));
    });
  }

  function setVfsView(view) {
    VS.view = view;
    document.querySelectorAll('#vfsViewMode .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (VS.sel) renderVfsStage();
  }

  async function openVfsFile(path) {
    let content;
    try {
      const node = VFS.stat(path);
      if (!node) throw new Error('文件不存在：' + path);
      if (node.type === 'dir') throw new Error('这是目录');
      content = await VFS.read(path);
    } catch (e) { AH.ui.error(e); return; }
    VS.sel = path;
    App._vfsContent = content;
    const isMd = /\.md$/i.test(path);
    const isHtml = /\.html?$/i.test(path);
    $('vfsPath').textContent = path;
    $('vfsPath').title = path;
    // 只有 md / html 有「预览 / 源码」切换
    $('vfsViewMode').hidden = !(isMd || isHtml);
    if (isMd || isHtml) setVfsView('preview');
    else renderVfsStage();
    renderVfsList();
  }

  function renderVfsStage() {
    const stage = $('vfsStage');
    if (!stage) return;
    stage.innerHTML = '';
    if (!VS.sel) {
      const box = document.createElement('div');
      box.className = 'vfs-empty';
      box.textContent = '从左侧选择一个文件';
      stage.appendChild(box);
      return;
    }
    const path = VS.sel;
    const content = App._vfsContent == null ? '' : String(App._vfsContent);
    try {
      if (U.isImagePath(path)) {
        const box = document.createElement('div');
        box.className = 'vfs-img';
        const img = document.createElement('img');
        img.src = content;
        img.alt = U.baseName(path);
        box.appendChild(img);
        stage.appendChild(box);
        return;
      }
      if (VS.view === 'source') {
        const pre = document.createElement('pre');
        pre.className = 'vfs-source';
        pre.textContent = content;
        stage.appendChild(pre);
        return;
      }
      if (/\.html?$/i.test(path)) {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.title = 'HTML 预览';
        frame.srcdoc = content;
        stage.appendChild(frame);
        return;
      }
      if (/\.md$/i.test(path)) {
        const box = document.createElement('div');
        box.className = 'md-preview';
        box.innerHTML = AH.md.toHtml(content);
        stage.appendChild(box);
        AH.md.renderMathIn(box);
        return;
      }
      const pre = document.createElement('pre');
      pre.className = 'vfs-source';
      pre.textContent = content;
      stage.appendChild(pre);
    } catch (e) {
      stage.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'vfs-empty';
      box.textContent = '预览失败：' + (e && e.message ? e.message : e);
      stage.appendChild(box);
    }
  }

  async function vfsSearch(q) {
    VS.query = String(q || '').trim();
    if (!VS.query) { App._vfsHits = []; renderVfsList(); return; }
    try {
      const raw = await VFS.search(VS.query, { inPath: VS.cwd, limit: 40, inContent: true });
      App._vfsHits = raw.map((s) => {
        const m = String(s).match(/^(.*?)(?::(\d+))?\s{2,}/);
        const p = m ? m[1] : String(s);
        const line = m && m[2] ? m[2] : '';
        return { path: p, label: U.baseName(p) || p, meta: line ? '第 ' + line + ' 行' : '文件名' };
      });
    } catch (e) {
      App._vfsHits = [];
      AH.ui.error(e);
    }
    renderVfsList();
  }

  App.renderVfs = function () {
    if (!VS.sel) { $('vfsPath').textContent = '未选择文件'; }
    renderVfsList();
  };

  /* ============================================================
     导航 / 页面
     ============================================================ */
  function setPage(page) {
    App.page = page;
    document.querySelectorAll('.rail-btn[data-page]').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
    const app = document.querySelector('.app');
    app.style.display = page === 'chat' ? '' : 'none';
    $('tasksPage').hidden = page !== 'tasks';
    if (page === 'tasks') renderTasks();
    if ($('vfsPage')) {
      $('vfsPage').hidden = page !== 'vfs';
      if (page === 'vfs') App.renderVfs();
    }
    if ($('pluginsPage')) {
      $('pluginsPage').hidden = page !== 'plugins';
      if (page === 'plugins') AH.plugins.open();
    }
    if (page === 'chat') setTimeout(() => AH.chat.autoHeight && AH.chat.autoHeight(), 0);
  }
  App.setPage = setPage;

  /* ============================================================
     绑定
     ============================================================ */
  App.bind = function () {
    // 导航
    document.querySelectorAll('.rail-btn[data-page]').forEach((b) => {
      b.addEventListener('click', () => setPage(b.dataset.page));
    });
    $('railTheme').addEventListener('click', () => AH.settings.toggleTheme());
    $('railSettings').addEventListener('click', () => AH.settings.open());

    // 侧栏 tab
    document.querySelectorAll('.seg-btn[data-side]').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.seg-btn[data-side]').forEach((x) => {
          x.classList.toggle('active', x === b);
          x.setAttribute('aria-selected', x === b ? 'true' : 'false');
        });
        const side = b.dataset.side;
        $('tree').hidden = side !== 'files';
        $('historyList').hidden = side !== 'history';
        if (side === 'history') AH.chat.renderHistory();
      });
    });

    // 侧栏更多菜单
    const menu = $('sideMenu');
    $('btnSideMenu').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    document.addEventListener('click', (e) => { if (!e.target.closest('#sideMenu') && !e.target.closest('#btnSideMenu')) menu.hidden = true; });
    menu.addEventListener('click', async (e) => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (!act) return;
      menu.hidden = true;
      if (act === 'new-file') App.newFile('/notes');
      else if (act === 'new-dir') App.newDir('/');
      else if (act === 'upload') uploadToVfs();
      else if (act === 'export') AH.settings.exportAll();
      else if (act === 'import') $('importFile').click();
      else if (act === 'clear') {
        const ok = await AH.ui.confirm({ title: '清理缓存与临时文件', text: '会清空 /tmp 目录与内存缓存，不影响其他文件。', rememberKey: '' });
        if (!ok) return;
        try {
          if (VFS.exists('/tmp')) await VFS.remove('/tmp');
          await VFS.mkdir('/tmp');
          VFS.invalidateCache();
          AH.ui.toast('已清理', 'ok');
          renderTree(); updateFsStat();
        } catch (err) { AH.ui.error(err); }
      }
    });

    // 编辑器
    $('editor').addEventListener('input', () => {
      App.editor.dirty = true;
      $('btnSave').textContent = '保存 •';
    });
    $('btnSave').addEventListener('click', () => App.saveFile());
    $('btnCloseEditor').addEventListener('click', () => App.closeEditor());
    $('btnEditorToggle').addEventListener('click', () => App.toggleEditor());
    $('btnPreview').addEventListener('click', () => {
      if (App.editor.mode === 'image') { App.showPreview($('editor').value || $('imgPreviewImg').src); return; }
      const preview = $('preview');
      const showing = !preview.hidden;
      if (showing) {
        preview.hidden = true;
        $('editor').hidden = false;
        $('btnPreview').textContent = '预览';
      } else {
        App.showPreview($('editor').value);
        $('btnPreview').textContent = '编辑';
      }
    });

    // 待办
    $('todoClear').addEventListener('click', () => AH.todos.clearDone().catch((e) => AH.ui.error(e)));
    document.addEventListener('ah:todos', renderTodos);

    // 任务
    document.querySelectorAll('#taskFilter .seg-btn').forEach((b) => {
      b.addEventListener('click', () => {
        document.querySelectorAll('#taskFilter .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
        renderTasks();
      });
    });
    document.addEventListener('ah:tasks', () => App.refreshTasks());

    // VFS 页
    if ($('vfsSearch')) {
      $('vfsSearch').addEventListener('input', U.debounce((e) => {
        vfsSearch(e.target.value).catch((err) => AH.ui.error(err));
      }, 220));
      $('btnVfsRefresh').addEventListener('click', () => {
        $('vfsSearch').value = '';
        VS.query = '';
        App._vfsHits = [];
        renderVfsList();
        if (VS.sel) {
          const p = VS.sel;
          openVfsFile(p).catch((err) => AH.ui.error(err));
        }
      });
      document.querySelectorAll('#vfsViewMode .seg-btn').forEach((b) => {
        b.addEventListener('click', () => setVfsView(b.dataset.view));
      });
    }

    // 移动端
    $('btnSidebarToggle').addEventListener('click', () => {
      const app = document.querySelector('.app');
      app.classList.toggle('show-sidebar');
    });

    // 全局快捷键
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        if (App.editor.path && App.editor.mode !== 'image') { e.preventDefault(); App.saveFile(); }
      }
      if (e.key === 'Escape') {
        $('sideMenu').hidden = true;
        document.querySelector('.app').classList.remove('show-sidebar');
        if (!$('settingsModal').hidden) AH.settings.close();
      }
    });

    // VFS 变化 → 合并刷新（80ms 内的批量写入只重绘一次）
    App._vfsPending = new Set();
    VFS.on((paths) => {
      for (const p of paths) App._vfsPending.add(p);
      if (App._treeTimer) return;
      App._treeTimer = setTimeout(async () => {
        App._treeTimer = null;
        const pending = App._vfsPending;
        App._vfsPending = new Set();
        // 新文件默认展开父目录，否则树上看不到刚写出来的东西
        for (const p of pending) {
          if (p.startsWith('/conversations')) continue;
          let parent = U.parentPath(p);
          while (parent && parent !== '/') { App.expanded.add(parent); parent = U.parentPath(parent); }
        }
        renderTree();
        updateFsStat();
        // 打开的文件被外部修改：未编辑时自动重载
        if (App.editor.path && !App.editor.dirty && pending.has(App.editor.path)) {
          try {
            const content = await VFS.read(App.editor.path);
            if ($('editor').value !== content && App.editor.mode !== 'image') {
              $('editor').value = content;
              if (!$('preview').hidden) App.showPreview(content);
            }
          } catch (e) {}
        }
      }, 80);
    });

    // 页面关闭前提示
    window.addEventListener('beforeunload', (e) => {
      if (App.editor.dirty || (AH.chat.anyRunning && AH.chat.anyRunning())) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // 点击文件树空白处上传？不处理，避免误触
  };

  function uploadToVfs() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    document.body.appendChild(input);
    input.hidden = true;
    input.addEventListener('change', async () => {
      for (const f of [...input.files]) {
        try {
          const name = String(f.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
          if (U.extName(name) === 'zip') {
            const r = await AH.zip.toVfs(f, '/uploads', name);
            AH.ui.toast('已解压 ' + r.files + ' 个文件到 ' + r.root, 'ok', 3200);
            continue;
          }
          const path = '/uploads/' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6) + '-' + name;
          if (U.isImagePath(name)) await VFS.write(path, await U.readFileDataUrl(f));
          else await VFS.write(path, await U.readFileText(f));
          AH.ui.toast('已上传 ' + name, 'ok', 1600);
        } catch (e) { AH.ui.error('上传失败：' + e.message); }
      }
      renderTree(); updateFsStat();
      input.remove();
    });
    input.click();
  }

  /* ============================================================
     状态栏
     ============================================================ */
  function updateFsStat() {
    const el = $('fsStat');
    if (!el) return;
    const st = VFS.stats();
    const mode = AH.db.mode === 'idb' ? 'IndexedDB' : '内存模式';
    el.textContent = st.files + ' 个文件 · ' + U.fmtChars(st.chars) + ' · ' + mode;
    el.title = '目录 ' + st.dirs + ' 个；' + (AH.db.mode === 'idb' ? '数据保存在本机浏览器' : '关页面即丢：' + (AH.db.reason || ''));
  }
  App.updateFsStat = updateFsStat;

  /* 启动 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
