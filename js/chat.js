/* ============================================================
   chat.js · 会话、消息渲染、流式 UI、输入区
   性能要点：
   1. 每个会话单独存一个 kv（不再每次整包重写所有会话）；
   2. 长对话只渲染最近 60 条，向上可加载；
    3. 流式阶段即按 Markdown 渲染，自适应间隔节流（60ms→260ms），不再等结束才排版；
   4. 工具卡片按调用增量更新，不重建整条消息。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;
  const VFS = AH.vfs;
  const cfg = AH.cfg;

  const RENDER_LIMIT = 60;
  const RENDER_CHARS = 180000;
  const MIN_RENDER = 8;
  const LOAD_MORE = 20;
  const EMPTY_CONV = [];

  const Chat = (AH.chat = {
    sessions: [],
    currentId: null,
    runs: new Map(),
    toolLog: [],
    _loaded: new Set(),
    _saveTimers: new Map(),
    _saveBump: new Map(),
    _mdTimer: null
  });

  /* 多会话运行期状态：
     convs → 会话 id 到消息数组（各存一份，切走也继续增长）
     views → 会话 id 到独立 DOM（隐藏但持续更新，切回来立刻是完整内容）
     这样同一个页面里可以有多个 run 并行，互不踩对方的数组和 DOM；
     入口就在左侧「对话」列表，不需要额外的标签栏。 */
  const RT = (Chat._rt = { convs: new Map(), views: new Map() });

  Object.defineProperty(Chat, 'conv', {
    configurable: true,
    enumerable: true,
    get() { return RT.convs.get(Chat.currentId) || EMPTY_CONV; },
    set(v) { if (Chat.currentId) RT.convs.set(Chat.currentId, Array.isArray(v) ? v : []); }
  });

  function convOf(id) {
    let c = RT.convs.get(id);
    if (!c) { c = []; RT.convs.set(id, c); }
    return c;
  }
  Chat.convOf = convOf;
  // 导出备份用：内存里是最新的就先拿内存，否则再读 IndexedDB
  Chat.snapshotConv = (id) => (RT.convs.has(id) ? RT.convs.get(id).slice() : null);

  const els = {};
  function bindEls() {
    els.chatBody = document.getElementById('chatBody');
    els.tree = document.getElementById('tree');
    els.history = document.getElementById('historyList');
    els.input = document.getElementById('input');
    els.send = document.getElementById('btnSend');
    els.stop = document.getElementById('btnStop');
    els.attach = document.getElementById('attachRow');
    els.tokenBar = document.getElementById('tokenBar');
    els.title = document.getElementById('chatTitleInput');
    els.icon = document.getElementById('chatIcon');
    els.modelChip = document.getElementById('modelChip');
  }

  /* ============================================================
     每会话 DOM：一个 .msg-view 装 .messages + .welcome
     ============================================================ */
  function buildViewFallback() {
    const root = document.createElement('div');
    root.className = 'msg-view';
    const msgs = document.createElement('div');
    msgs.className = 'messages';
    msgs.tabIndex = 0;
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    welcome.hidden = true;
    root.appendChild(msgs);
    root.appendChild(welcome);
    return root;
  }

  function viewOf(id) {
    if (!id) return null;
    let v = RT.views.get(id);
    if (v) return v;
    const tpl = document.getElementById('sessionViewTpl');
    let root;
    try {
      root = tpl && tpl.content && tpl.content.firstElementChild
        ? tpl.content.firstElementChild.cloneNode(true)
        : buildViewFallback();
    } catch (e) { root = buildViewFallback(); }
    root.dataset.session = id;
    root.hidden = Chat.currentId !== id;
    v = {
      id,
      root,
      msgs: root.querySelector('.messages'),
      welcome: root.querySelector('.welcome'),
      renderStart: 0,
      live: null,
      scroll: 0,
      stick: true
    };
    if (els.chatBody) els.chatBody.appendChild(root);
    RT.views.set(id, v);
    ensureStick(v.msgs);
    return v;
  }
  Chat.viewOf = viewOf;

  function currentView() { return viewOf(Chat.currentId); }

  function dropView(id) {
    const v = RT.views.get(id);
    if (!v) return;
    try { v.root.remove(); } catch (e) {}
    RT.views.delete(id);
  }

  /* ============================================================
     会话加载 / 保存
     ============================================================ */
  function sessionMeta(id) {
    return {
      id,
      title: '新对话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      filePath: convPath(),
      count: 0,
      preview: '',
      unread: false
    };
  }

  function convPath() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return '/conversations/chat-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + Math.random().toString(36).slice(2, 6) + '.md';
  }

  Chat.init = async function () {
    bindEls();
    const row = await AH.db.get('kv', 'session_index');
    let index = (row && Array.isArray(row.v)) ? row.v : [];
    index = index.filter((s) => s && s.id);
    if (!index.length) {
      const id = U.uid('s');
      index = [sessionMeta(id)];
      await AH.db.put('kv', { k: 'session_index', v: index });
      await AH.db.put('kv', { k: 'conv:' + id, v: [] });
    }
    Chat.sessions = index;
    const lastId = (await AH.db.get('kv', 'last_session')) || null;
    const start = index.find((s) => lastId && s.id === lastId.v) || index[0];

    await Chat.switchSession(start.id, { initial: true });
    bindEvents();
    renderHistory();
    updateModelChip();
  };

  Chat._saveIndex = async function () {
    await AH.db.put('kv', { k: 'session_index', v: Chat.sessions });
  };

  Chat.loadConv = async function (id) {
    const row = await AH.db.get('kv', 'conv:' + id);
    return (row && Array.isArray(row.v)) ? row.v : [];
  };

  /* opts.bump = true 表示这次保存源于真实活动（发消息、生成完成、清空等），
     才更新 updatedAt 以影响历史列表排序。
     切换会话、单纯归档等被动保存不传 bump，排序时间保持不变——
     否则「点开看一眼」就会把对话顶到最前面。 */
  Chat.saveConv = async function (id, conv, opts) {
    if (!id || !conv) return;
    const meta = Chat.sessions.find((s) => s.id === id);
    if (!meta) return;
    const bump = !!(opts && (opts.bump || opts.now));
    if (bump) meta.updatedAt = Date.now();
    meta.count = conv.length;
    let last = null;
    for (let i = conv.length - 1; i >= 0; i--) {
      if (conv[i].role === 'user' || conv[i].role === 'assistant') { last = conv[i]; break; }
    }
    meta.preview = last ? U.clip(typeof last.content === 'string' ? last.content : '（图文消息）', 90) : '';
    Chat.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    await AH.db.put('kv', { k: 'conv:' + id, v: conv });
    await Chat._saveIndex();
    renderHistory();
    scheduleMarkdown(id, conv);
  };

  Chat.save = async function (opts) {
    if (!Chat.currentId) return;
    await Chat.saveConv(Chat.currentId, convOf(Chat.currentId), opts);
  };

  /* 每个会话一个防抖计时器：并发多个 run 时不会互相顶掉保存 */
  Chat.saveSoon = function (id, opts) {
    const sid = id || Chat.currentId;
    if (!sid) return;
    const bump = !!(opts && (opts.bump || opts.now));
    if (bump) Chat._saveBump.set(sid, true);
    const prev = Chat._saveTimers.get(sid);
    if (prev) clearTimeout(prev);
    Chat._saveTimers.set(sid, setTimeout(() => {
      Chat._saveTimers.delete(sid);
      const doBump = Chat._saveBump.get(sid) === true;
      Chat._saveBump.delete(sid);
      Chat.saveConv(sid, convOf(sid), { bump: doBump }).catch((e) => console.warn(e));
    }, 450));
  };

  async function flushMarkdown(id, conv) {
    const meta = Chat.sessions.find((s) => s.id === id);
    if (!meta || !conv || !conv.length) return;
    const toolResults = new Map();
    for (const m of conv) if (m.role === 'tool' && m.tool_call_id) toolResults.set(m.tool_call_id, m.content);
    const lines = ['# ' + (meta.title || '对话'), '', '> 保存于 ' + U.nowText(), ''];
    for (const m of conv) {
      if (m.role === 'user') {
        lines.push('## 用户', '', typeof m.content === 'string' ? m.content : (m.images ? '（含图片）' : ''), '');
      } else if (m.role === 'assistant') {
        lines.push('## 小匣', '', m.content || '（无正文）', '');
        if (m.tool_calls) {
          for (const tc of m.tool_calls) {
            const res = toolResults.get(tc.id);
            lines.push('### 工具：' + tc.function.name, '', '```json', tc.function.arguments || '{}', '```', '');
            lines.push('结果：', '', '```', U.clip(res ? res.content : '（无）', 2000), '```', '');
          }
        }
      }
    }
    try { await VFS.write(meta.filePath, lines.join('\n'), { silent: true }); }
    catch (e) { console.warn('[chat] 存档写入失败', e); }
  }

  async function flushPendingMarkdown() {
    Chat._mdTimer = null;
    const pending = Chat._mdPending;
    Chat._mdPending = new Map();
    for (const [id, conv] of pending) {
      try { await flushMarkdown(id, conv); }
      catch (e) { console.warn('[chat] 存档写入失败', e); }
    }
  }

  function scheduleMarkdown(id, conv) {
    if (!id || !conv) return;
    if (!Chat._mdPending) Chat._mdPending = new Map();
    Chat._mdPending.set(id, conv);
    if (Chat._mdTimer) clearTimeout(Chat._mdTimer);
    Chat._mdTimer = setTimeout(flushPendingMarkdown, 3000);
  }

  Chat.switchSession = async function (id, opts) {
    if (!id) return;
    if (Chat.currentId === id && Chat._loaded.has(id) && !(opts && opts.initial)) return;
    const prev = Chat.currentId;
    if (prev) {
      // 切走前记住滚动位置与贴底状态，切回来时还原
      const pv = RT.views.get(prev);
      if (pv) {
        pv.scroll = pv.msgs.scrollTop;
        pv.stick = pv.msgs._stick !== false;
      }
      await Chat.saveConv(prev, convOf(prev));
    }
    Chat.currentId = id;
    await AH.db.put('kv', { k: 'last_session', v: id });
    if (!Chat._loaded.has(id)) {
      RT.convs.set(id, await Chat.loadConv(id));
      Chat._loaded.add(id);
    }
    const view = viewOf(id);
    for (const v of RT.views.values()) v.root.hidden = v.id !== id;
    const run = Chat.runs.get(id);
    Chat.toolLog = (run && run.toolLog) || [];
    // 点开即视为已读：清掉后台回复留下的未读点
    const meta = Chat.sessions.find((s) => s.id === id);
    if (meta && meta.unread) { meta.unread = false; Chat._saveIndex().catch(() => {}); }
    renderHeader();
    // 正在生成的会话保留流式 DOM；其余按存档重绘
    if (!(run && run.running && view.live && !view.live.finished)) {
      view.renderStart = renderStartFor(convOf(id));
      renderConversation(view, { silent: true });
    } else {
      reflectBackground(view);
    }
    restoreScroll(view, run);
    updateTokenBar();
    updateRunningUI();
    renderHistory();
  };

  function reflectBackground(view) {
    if (!view) return;
    const empty = !convOf(view.id).length;
    if (view.welcome) view.welcome.hidden = !empty;
    view.msgs.style.visibility = empty ? 'hidden' : '';
  }

  function restoreScroll(view, run) {
    const el = view && view.msgs;
    if (!el) return;
    if (run && run.running) { el._stick = true; pinToBottom(el, true); return; }
    if (view.stick === false) {
      el._stick = false;
      el.scrollTop = view.scroll;
      el._lastTop = el.scrollTop;
    } else {
      el._stick = true;
      pinToBottom(el, true);
    }
  }

  Chat.newSession = async function () {
    if (Chat.currentId) await Chat.saveConv(Chat.currentId, convOf(Chat.currentId));
    const id = U.uid('s');
    const meta = sessionMeta(id);
    Chat.sessions.unshift(meta);
    await AH.db.put('kv', { k: 'session_index', v: Chat.sessions });
    await AH.db.put('kv', { k: 'conv:' + id, v: [] });
    await Chat.switchSession(id, { initial: true });
    return id;
  };

  Chat.deleteSession = async function (id) {
    const i = Chat.sessions.findIndex((s) => s.id === id);
    if (i < 0) return;
    const meta = Chat.sessions[i];
    const ok = await AH.ui.confirm({ title: '删除对话', text: '删除「' + (meta.title || '未命名') + '」的记录？VFS 里的存档文件不会被删除。', rememberKey: '' });
    if (!ok) return;
    const run = Chat.runs.get(id);
    if (run && run.running) { try { run.controller.abort(); } catch (e) {} }
    Chat.sessions.splice(i, 1);
    Chat.runs.delete(id);
    RT.convs.delete(id);
    Chat._loaded.delete(id);
    dropView(id);
    await AH.db.del('kv', 'conv:' + id);
    await Chat._saveIndex();
    if (Chat.currentId === id) {
      Chat.currentId = null;
      const next = Chat.sessions[0] && Chat.sessions[0].id;
      if (next) await Chat.switchSession(next);
      else await Chat.newSession();
    }
    renderHistory();
  };

  /* 清空全部对话时把每个会话的 DOM、数组、运行状态一并丢掉 */
  Chat.resetAll = function () {
    for (const r of Chat.runs.values()) { try { r.controller.abort(); } catch (e) {} }
    for (const id of [...RT.views.keys()]) dropView(id);
    for (const t of Chat._saveTimers.values()) clearTimeout(t);
    Chat._saveTimers.clear();
    Chat._saveBump.clear();
    if (Chat._mdPending) Chat._mdPending.clear();
    RT.convs.clear();
    Chat._loaded.clear();
    Chat.runs.clear();
    Chat.currentId = null;
    Chat.sessions = [];
    Chat.toolLog = [];
  };

  Chat.clearCurrent = async function () {
    const conv = convOf(Chat.currentId);
    if (!conv.length) return;
    if (Chat.isRunning()) { AH.ui.toast('这个对话正在生成，先点停止再清空', 'warn', 2000); return; }
    const ok = await AH.ui.confirm({ title: '清空当前对话', text: '只清空当前会话的消息，VFS 文件不受影响。', rememberKey: '' });
    if (!ok) return;
    conv.length = 0;
    Chat.toolLog = [];
    await Chat.save({ bump: true });
    const view = currentView();
    if (view) {
      view.renderStart = 0;
      renderConversation(view);
    }
    updateTokenBar();
  };

  Chat.renameCurrent = async function (title) {
    const meta = Chat.sessions.find((s) => s.id === Chat.currentId);
    if (!meta) return;
    meta.title = U.clip(String(title || '').trim() || '新对话', 40);
    await Chat._saveIndex();
    renderHistory();
  };

  /* ============================================================
     头部 / token 条
     ============================================================ */
  function renderHeader() {
    const meta = Chat.sessions.find((s) => s.id === Chat.currentId);
    if (els.title) els.title.value = (meta && meta.title) || '';
    if (els.icon) els.icon.innerHTML = AH.ui.icon(iconOf((meta && meta.title) || ''));
  }

  function iconOf(title) {
    const t = String(title || '').toLowerCase();
    if (/代码|code|开发|程序|bug|修复/.test(t)) return 'terminal';
    if (/图表|数据|分析|chart/.test(t)) return 'chart';
    if (/计划|待办|清单|todo/.test(t)) return 'checklist';
    if (/笔记|文档|写|文章|报告/.test(t)) return 'file-text';
    if (/搜索|调研|研究/.test(t)) return 'search';
    return 'chat';
  }

  function updateModelChip() {
    if (!els.modelChip) return;
    const m = cfg.get('model') || '未配置';
    const bad = !cfg.get('apiKey') || !cfg.get('baseUrl') || !cfg.get('model');
    els.modelChip.textContent = m;
    els.modelChip.classList.toggle('unset', bad);
    els.modelChip.title = bad ? '尚未完整配置模型（设置 → 模型）' : m;
  }

  Chat.updateModelChip = updateModelChip;

  function updateTokenBar() {
    if (!els.tokenBar) return;
    const convTok = Chat.conv.reduce((n, m) => n + U.estimateMsgTokens(m), 0);
    const run = Chat.runs.get(Chat.currentId);
    const usage = run && run.usage;
    const parts = [];
    parts.push('对话 <b>' + (convTok > 1000 ? (convTok / 1000).toFixed(1) + 'k' : convTok) + '</b> tokens');
    if (usage && (usage.inTok || usage.outTok)) {
      parts.push('本轮 <b>' + usage.inTok + '</b> 入 / <b>' + usage.outTok + '</b> 出');
      if (usage.cost > 0) parts.push('≈ <b>$' + usage.cost.toFixed(4) + '</b>');
    }
    const others = runningIds().filter((id) => id !== Chat.currentId).length;
    if (others > 0) parts.push('另有 <b>' + others + '</b> 个对话在生成');
    els.tokenBar.innerHTML = parts.join(' · ');
    els.tokenBar.hidden = false;
  }

  Chat.updateTokenBar = updateTokenBar;

  /* ============================================================
     渲染
     ============================================================ */
  function msgText(m) {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
    return '';
  }

  function msgWeight(m) {
    let n = 0;
    if (typeof m.content === 'string') n = m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) if (p && p.type === 'text') n += String(p.text || '').length;
    }
    if (m.tool_calls) for (const tc of m.tool_calls) n += String(tc.function && tc.function.arguments || '').length;
    return n;
  }

  function normRenderStart(conv, start) {
    start = Math.max(0, Math.min(start, conv.length));
    while (start > 0 && conv[start] && conv[start].role === 'tool') start--;
    return start;
  }

  /* 不只按条数，还按正文字符预算截断，避免长回答把 60 条全部解析进 DOM */
  function renderStartFor(conv) {
    const hard = Math.max(0, conv.length - RENDER_LIMIT);
    let start = hard, chars = 0;
    for (let i = conv.length - 1; i >= hard; i--) {
      chars += msgWeight(conv[i]);
      if (chars > RENDER_CHARS && conv.length - i >= MIN_RENDER) { start = i; break; }
    }
    return normRenderStart(conv, start);
  }

  function toolResultFor(conv, tc, startIndex) {
    for (let i = startIndex; i < Math.min(conv.length, startIndex + 60); i++) {
      const m = conv[i];
      if (m.role === 'tool' && m.tool_call_id === tc.id) return m.content;
    }
    return null;
  }

  function msgsOf(view) {
    const v = view || currentView();
    return v && v.msgs;
  }

  function renderConversation(view, opts) {
    if (!view) view = currentView();
    if (!view) return;
    const box = view.msgs;
    const conv = convOf(view.id);
    box.innerHTML = '';
    view.live = null;   // 整段重绘后，旧的气泡节点已不在文档里
    renderWelcome(view);
    if (!conv.length) return;
    const start = normRenderStart(conv, view.renderStart || 0);
    if (start > 0) {
      const btn = document.createElement('button');
      btn.className = 'load-earlier chip-btn';
      btn.textContent = '加载更早的 ' + Math.min(LOAD_MORE, start) + ' 条';
      btn.style.cssText = 'display:block;margin:0 auto 14px';
      btn.addEventListener('click', () => {
        const next = normRenderStart(conv, start - LOAD_MORE);
        view.renderStart = next;
        renderConversation(view, { anchor: next });
      });
      box.appendChild(btn);
    }
    let i = start;
    while (i < conv.length) {
      const m = conv[i];
      if (m.role === 'user') {
        box.appendChild(buildUserEl(m, i));
        i++;
      } else if (m.role === 'assistant') {
        box.appendChild(buildAssistantEl(view, m, i));
        // 跳过它对应的 tool 消息（已经在卡片里渲染）
        if (m.tool_calls) {
          let j = i + 1;
          while (j < conv.length && conv[j].role === 'tool') j++;
          i = j;
        } else i++;
      } else i++;
    }
    if (opts && opts.silent) return;
    if (opts && Number.isFinite(opts.anchor)) {
      const target = box.querySelector('.msg[data-i="' + opts.anchor + '"]');
      if (target) target.scrollIntoView({ block: 'start', inline: 'nearest' });
      else scrollToBottom(view, true);
    } else scrollToBottom(view, true);
  }
  Chat.renderConversation = renderConversation;

  /* 长会话新增消息时同步裁掉预算外的旧 DOM，避免越聊越卡 */
  function trimConversationDom(view, conv) {
    if (!view) return;
    const box = view.msgs;
    const start = renderStartFor(conv);
    const nearBottom = atBottom(box, 80);
    for (const el of [...box.querySelectorAll('.msg')]) {
      const i = Number(el.dataset.i);
      if (Number.isFinite(i) && i < start) el.remove();
    }
    let btn = box.querySelector('.load-earlier');
    if (start > 0) {
      if (!btn) {
        btn = document.createElement('button');
        btn.className = 'load-earlier chip-btn';
        btn.style.cssText = 'display:block;margin:0 auto 14px';
        box.prepend(btn);
      }
      btn.textContent = '加载更早的 ' + Math.min(LOAD_MORE, start) + ' 条';
      btn.onclick = () => {
        const next = normRenderStart(conv, start - LOAD_MORE);
        view.renderStart = next;
        renderConversation(view, { anchor: next });
      };
    } else if (btn) btn.remove();
    if (nearBottom) scrollToBottom(view, true);
  }

  function buildUserEl(m, index) {
    const wrap = document.createElement('div');
    wrap.className = 'msg user';
    if (typeof index === 'number') wrap.dataset.i = String(index);
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = msgText(m);
    wrap.appendChild(bubble);
    if (m.images && m.images.length) {
      const refs = document.createElement('div');
      refs.className = 'refs';
      m.images.forEach((img) => {
        const span = document.createElement('span');
        span.className = 'ref';
        span.textContent = '🖼 ' + U.baseName(img.path);
        span.title = img.path;
        refs.appendChild(span);
      });
      wrap.appendChild(refs);
    }
    return wrap;
  }

  function buildAssistantEl(view, m, index) {
    const conv = convOf(view.id);
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    if (typeof index === 'number') wrap.dataset.i = String(index);
    const name = document.createElement('div');
    name.className = 'name';
    name.innerHTML = '<span class="avatar">' + AH.ui.icon('sparkles') + '</span><b>小匣</b><span>' + U.fmtTime(m._at || Date.now()) + '</span>';
    wrap.appendChild(name);

    if (m._thinking) wrap.appendChild(buildThinking(m._thinking, false));

    const parsed = parseDeliver(m.content || '');
    if (parsed.text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble assistant';
      const md = document.createElement('div');
      md.className = 'md';
      md.innerHTML = AH.md.toHtml(parsed.text);
      AH.md.renderMathIn(md);
      bubble.appendChild(md);
      wrap.appendChild(bubble);
    }
    (parsed.datas || []).forEach((d) => wrap.appendChild(buildDeliverCard(d)));

    if (m.tool_calls && m.tool_calls.length) {
      const cards = document.createElement('div');
      cards.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      m.tool_calls.forEach((tc) => {
        const result = toolResultFor(conv, tc, index + 1);
        cards.appendChild(buildToolCard(tc, parseSafe(tc.function.arguments), result));
      });
      wrap.appendChild(cards);
    }

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    if (m._usage) meta.innerHTML = '<span>' + m._usage.in + ' 入 / ' + m._usage.out + ' 出' + (m._usage.cost ? ' · $' + m._usage.cost.toFixed(4) : '') + '</span>';
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (parsed.text) {
      const copy = document.createElement('button');
      copy.textContent = '复制';
      copy.addEventListener('click', async () => { const ok = await U.copyText(parsed.text); AH.ui.copied(ok); });
      actions.appendChild(copy);
    }
    if (index === conv.length - 1 || (conv[index + 1] && conv[index + 1].role === 'tool' && index + 1 === conv.length - 1)) {
      const retry = document.createElement('button');
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        if (view.id !== Chat.currentId) Chat.switchSession(view.id).then(() => Chat.regenerate());
        else Chat.regenerate();
      });
      actions.appendChild(retry);
    }
    meta.appendChild(actions);
    wrap.appendChild(meta);
    return wrap;
  }

  function buildThinking(text, live) {
    const box = document.createElement('div');
    box.className = 'thinking';
    const head = document.createElement('div');
    head.className = 'thinking-head';
    head.innerHTML = (live ? '<span class="spin"></span>' : '') + '<span class="lbl">' + (live ? '思考中…' : '思考过程') + '</span><span style="margin-left:auto">展开</span>';
    const body = document.createElement('div');
    body.className = 'thinking-body';
    body.textContent = text;
    head.addEventListener('click', () => {
      box.classList.toggle('collapsed');
      head.lastElementChild.textContent = box.classList.contains('collapsed') ? '展开' : '收起';
    });
    box.appendChild(head);
    box.appendChild(body);
    if (live) head.lastChild.textContent = '收起';
    return box;
  }

  function parseSafe(s) { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } }

  function argSummary(args) {
    const order = ['path', 'query', 'url', 'expression', 'text', 'question', 'title', 'from', 'to', 'task_id'];
    for (const k of order) if (args && args[k]) return String(args[k]);
    const keys = Object.keys(args || {});
    if (!keys.length) return '';
    const k = keys[0];
    return k + '=' + String(args[k]);
  }

  function buildToolCard(tc, args, result) {
    const card = document.createElement('div');
    card.className = 'tool-card collapsed';
    card.dataset.call = tc.id || '';
    const head = document.createElement('div');
    head.className = 'tool-head';
    const isBackground = result != null && String(result).startsWith('⏳');
    const status = result == null ? '准备中' : isBackground ? '后台运行' : (isErrorResult(result) ? '失败' : '完成');
    head.innerHTML =
      '<span class="tool-dot ' + (result == null || isBackground ? 'running' : (isErrorResult(result) ? 'error' : 'ok')) + '"></span>' +
      '<span class="tool-name">' + U.esc(tc.function.name) + '</span>' +
      '<span class="tool-args">' + U.esc(U.clip(argSummary(args), 70)) + '</span>' +
      '<span class="tool-status">' + status + '</span>';
    head.addEventListener('click', () => {
      card.classList.toggle('collapsed');
    });
    card.appendChild(head);
    const body = document.createElement('div');
    body.className = 'tool-body';
    body.innerHTML = '<div class="args-label">参数</div>';
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(args, null, 2);
    body.appendChild(pre);
    if (result != null) {
      const label = document.createElement('div');
      label.className = 'args-label';
      label.style.marginTop = '10px';
      label.textContent = '结果';
      const out = document.createElement('pre');
      out.textContent = cleanCardText(result);
      body.appendChild(label);
      body.appendChild(out);
      card.classList.toggle('collapsed', !isErrorResult(result));
    }
    card.appendChild(body);
    if (result != null) renderCardExtras(card, result);
    return card;
  }

  function cleanCardText(s) {
    s = String(s || '');
    if (s.startsWith('@@card:')) {
      try {
        const d = JSON.parse(s.slice(7));
        if (d.type === 'ask') return '（已向用户提问）';
        if (d.type === 'deliver') return '（交付卡片）';
        if (d.type === 'chart') return '（图表）';
      } catch (e) {}
    }
    return U.clip(s, 100000);
  }

  function isErrorResult(s) {
    const t = String(s || '');
    return /^(工具执行失败：|错误：|⚠️|⚠ )/.test(t) || /^API 返回/.test(t);
  }

  /* 交付卡：统一给工具结果与 [deliver:...] 标记复用 */
  function buildDeliverCard(data) {
    const box = document.createElement('div');
    box.className = 'card-wrap';
    const dc = document.createElement('div');
    dc.className = 'deliver-card';
    dc.innerHTML = '<h4>' + U.esc(data.title || '交付') + '</h4>' +
      (data.description ? '<p>' + U.esc(data.description) + '</p>' : '');
    const files = document.createElement('div');
    files.className = 'deliver-files';
    (data.files || []).forEach((p) => {
      const b = document.createElement('button');
      b.className = 'deliver-file';
      b.innerHTML = AH.ui.icon('file') + '<span>' + U.esc(p) + '</span>';
      b.addEventListener('click', () => AH.app && AH.app.openFile(p));
      files.appendChild(b);
    });
    dc.appendChild(files);
    box.appendChild(dc);
    return box;
  }

  /*
   * 流式阶段专用：把尚未闭合、或已闭合的 [deliver:...] 标记从展示文本里去掉。
   * 流式时标记是逐字吐出来的，若原样显示，用户会先看到 "…| /notes" 这类碎片。
   * 这里只处理展示，不改变 state.text（最终仍由 parseDeliver 出卡）。
   * 规则：围栏代码块内的内容不动；完整标记整段删除；末尾半截标记一并截断。
   */
  function stripPartialDeliver(text) {
    const src = String(text == null ? '' : text);
    if (!src) return '';
    const out = [];
    let fence = null;
    let i = 0;
    while (i < src.length) {
      const lineStart = i === 0 || src[i - 1] === '\n';
      if (lineStart) {
        const fm = /^[ \t]*(```+|~~~+)/.exec(src.slice(i, i + 12));
        if (fm) {
          fence = fence ? null : fm[1];
          const nl = src.indexOf('\n', i);
          if (nl < 0) { out.push(src.slice(i)); break; }
          out.push(src.slice(i, nl + 1));
          i = nl + 1;
          continue;
        }
      }
      if (!fence && src[i] === '[') {
        // 标记是逐字吐出来的：`[`、`[d`、`[del`… 都要提前截断，不能等 '[deliver' 完整
        const KEY = '[deliver';
        const rest = src.slice(i, i + KEY.length);
        if (KEY.startsWith(rest) && rest.length < KEY.length) {
          return out.join('');   // 标记词还没吐完
        }
        if (rest === KEY) {
          // 找配对的本层右方括号
          let j = i + KEY.length;
          let depth = 0;
          let closed = false;
          while (j < src.length) {
            const ch = src[j];
            if (ch === '[') depth++;
            else if (ch === ']') {
              if (depth === 0) { closed = true; break; }
              depth--;
            } else if (ch === '\n' && depth === 0 && j - i > 400) {
              break;
            }
            j++;
          }
          if (closed) { i = j + 1; continue; }
          // 未闭合：截断，等闭合后再显示
          return out.join('');
        }
      }
      out.push(src[i]);
      i++;
    }
    return out.join('');
  }

  /*
   * 解析正文里的 [deliver:标题 | 描述 | /文件1, /文件2] 标记。
   * 与旧版的区别（旧版只认「整行、且不含 ]」的写法，导致标记被原样显示）：
   *  1) 先扫描出所有完整标记（方括号按层配对，描述里可含 [ref:] 之类的方括号）；
   *  2) 标记可以出现在行内、列表项、加粗里，不再要求独占一行；
   *  3) 跳过围栏代码块与行内代码，避免把示例当指令执行；
   *  4) 全角冒号「：」、全角竖线「｜」与半角等价；
   *  5) 一行/一段里出现多个标记时全部收集，交给渲染层逐张出卡。
   * 返回 { text, data, datas }：text 为剔除标记后的正文，data 为首张（兼容旧调用方）。
   */
  function parseDeliver(text) {
    const src = String(text == null ? '' : text);
    const spans = [];
    let i = 0;
    let fence = null;
    while (i < src.length) {
      const lineStart = i === 0 || src[i - 1] === '\n';
      if (lineStart) {
        const fm = /^[ \t]*(```|~~~)/.exec(src.slice(i, i + 8));
        if (fm) {
          if (!fence) fence = fm[1];
          else if (fence === fm[1]) fence = null;
          const nl = src.indexOf('\n', i);
          i = nl === -1 ? src.length : nl + 1;
          continue;
        }
      }
      if (fence) { i++; continue; }
      if (src[i] === '`') {
        let n = 0;
        while (src[i + n] === '`') n++;
        const close = src.indexOf('`'.repeat(n), i + n);
        i = close === -1 ? i + n : close + n;
        continue;
      }
      if (src[i] === '[' && src.slice(i, i + 8).toLowerCase() === '[deliver') {
        let k = i + 8;
        while (src[k] === ' ' || src[k] === '\t') k++;
        if (src[k] === ':' || src[k] === '：') k++;
        else if (src[k] !== ']') { i++; continue; }  // [deliverXYZ] 不是标记
        let depth = 1;
        let j = k;
        while (j < src.length && depth > 0) {
          if (src[j] === '[') depth++;
          else if (src[j] === ']') depth--;
          j++;
        }
        if (depth === 0) {
          spans.push({ start: i, end: j, body: src.slice(k, j - 1) });
          i = j;
          continue;
        }
      }
      i++;
    }
    if (!spans.length) return { text: src, data: null, datas: [] };

    let keep = '';
    let last = 0;
    for (const s of spans) { keep += src.slice(last, s.start); last = s.end; }
    keep += src.slice(last);
    // 标记独占列表项时，留下一个空条目，清掉
    keep = keep.split('\n')
      .map((l) => l.replace(/^([ \t]*)([-*+]|\d+\.)[ \t]*$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const datas = spans.map((s) => {
      const parts = String(s.body || '').trim().split(/[|｜]/)
        .map((x) => x.trim())
        .filter((x, idx) => idx === 0 || x !== '');
      let title = '交付', description = '', files = [];
      if (parts.length && parts[0]) {
        if (parts[0].startsWith('/')) files = parts;
        else {
          title = parts[0];
          if (parts[1]) {
            if (parts[1].startsWith('/')) files = parts.slice(1);
            else { description = parts[1]; files = parts.slice(2); }
          }
        }
      }
      if (files.length === 1 && files[0].indexOf(',') >= 0) files = files[0].split(',');
      files = [...new Set(files.map((x) => x.trim()).filter(Boolean).map((x) => U.normPath(x)))];
      return { type: 'deliver', title, description, files };
    });
    return { text: keep, data: datas[0], datas };
  }

  /* 交付 / 提问 / 图表卡片 */
  function renderCardExtras(card, result) {
    if (!String(result).startsWith('@@card:')) return;
    let data;
    try { data = JSON.parse(String(result).slice(7)); } catch (e) { return; }
    if (data.type === 'deliver') {
      card.appendChild(buildDeliverCard(data));
    } else if (data.type === 'ask') {
      const box = document.createElement('div');
      box.className = 'card-wrap';
      const ac = document.createElement('div');
      ac.className = 'ask-card';
      const p = document.createElement('p');
      p.textContent = data.question || '';
      ac.appendChild(p);
      const opts = document.createElement('div');
      opts.className = 'ask-options';
      (data.options && data.options.length ? data.options : ['确认', '取消']).forEach((opt) => {
        const b = document.createElement('button');
        b.textContent = opt;
        b.addEventListener('click', () => {
          opts.querySelectorAll('button').forEach((x) => { x.disabled = true; });
          b.style.borderColor = 'var(--accent-line)';
          // 提问卡可能属于别的标签：按卡片所在的会话发，别发到当前对话里
          const host = b.closest('.msg-view');
          const sid = (host && host.dataset.session) || Chat.currentId;
          // 等本轮 finally 收尾后再发，避免“还在生成”被拦截
          setTimeout(() => Chat.send(String(opt), { fromCard: true, sessionId: sid }), 260);
        });
        opts.appendChild(b);
      });
      ac.appendChild(opts);
      box.appendChild(ac);
      card.appendChild(box);
    } else if (data.type === 'chart') {
      const box = document.createElement('div');
      box.className = 'card-wrap';
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 300;
      canvas.style.cssText = 'width:100%;max-width:640px;height:auto;display:block';
      box.appendChild(canvas);
      card.appendChild(box);
      requestAnimationFrame(() => drawChart(canvas, data));
    }
  }

  Chat.redrawCharts = function () {
    requestAnimationFrame(() => {
      document.querySelectorAll('.card-wrap canvas').forEach((c) => {
        if (c._spec) drawChart(c, c._spec);
      });
    });
  };

  /* 图表绘制：坐标轴 + 网格 + 多系列 */
  function drawChart(canvas, spec) {
    canvas._spec = spec;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvas.width = 640 * dpr;
    const H = canvas.height = 300 * dpr;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.body);
    const textColor = css.getPropertyValue('--text-2').trim() || '#a3b0c2';
    const gridColor = css.getPropertyValue('--line').trim() || '#232d3b';
    const palette = ['#4d9cff', '#3ecfa5', '#ffbf5e', '#ff6b78', '#a78bfa', '#38bdf8'];
    const pad = { l: 52, r: 20, t: spec.title ? 56 : 28, b: 34 };
    const cw = 640, chh = 300;
    ctx.clearRect(0, 0, cw, chh);
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    ctx.fillStyle = textColor;

    if (spec.title) {
      ctx.fillStyle = css.getPropertyValue('--text').trim() || '#e7edf5';
      ctx.font = '600 15px -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(spec.title, cw / 2, 22);
      ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    }

    const labels = spec.labels || [];
    const datasets = (spec.datasets || []).slice(0, 6);
    const isPie = spec.chartType === 'pie' || spec.chartType === 'doughnut';

    if (isPie) {
      const data = datasets[0] ? datasets[0].data : [];
      const total = data.reduce((a, b) => a + Math.max(0, b), 0) || 1;
      const cx = cw / 2 - 40, cy = (chh + 20) / 2, r = Math.min(100, (chh - 80) / 2);
      let angle = -Math.PI / 2;
      data.forEach((v, i) => {
        const a = Math.max(0, v) / total * Math.PI * 2;
        ctx.beginPath();
        ctx.fillStyle = palette[i % palette.length];
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, r, angle, angle + a);
        ctx.closePath();
        ctx.fill();
        if (spec.chartType === 'doughnut') {
          ctx.globalCompositeOperation = 'destination-out';
          ctx.beginPath(); ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2); ctx.fill();
          ctx.globalCompositeOperation = 'source-over';
        }
        angle += a;
      });
      // 图例
      let ly = 70;
      data.forEach((v, i) => {
        ctx.fillStyle = palette[i % palette.length];
        ctx.fillRect(430, ly - 8, 10, 10);
        ctx.fillStyle = textColor;
        ctx.textAlign = 'left';
        ctx.fillText(U.clip(labels[i] || '', 10) + '  ' + Math.round(v / total * 100) + '%', 446, ly);
        ly += 20;
      });
      return;
    }

    // 计算范围
    let max = 0, min = 0;
    datasets.forEach((d) => d.data.forEach((v) => { if (Number.isFinite(v)) { max = Math.max(max, v); min = Math.min(min, v); } }));
    if (max === min) max = min + 1;
    if (min > 0) min = 0;
    const plotW = cw - pad.l - pad.r;
    const plotH = chh - pad.t - pad.b;
    const y = (v) => pad.t + plotH - (v - min) / (max - min) * plotH;

    // 网格 + y 轴刻度
    ctx.strokeStyle = gridColor;
    ctx.fillStyle = textColor;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const gy = pad.t + plotH * i / 4;
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(cw - pad.r, gy); ctx.stroke();
      const val = max - (max - min) * i / 4;
      ctx.textAlign = 'right';
      ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + 'k' : String(Math.round(val * 10) / 10), pad.l - 8, gy + 4);
    }
    // x 标签
    ctx.textAlign = 'center';
    const step = labels.length > 1 ? plotW / (labels.length - 1) : 0;
    labels.forEach((l, i) => {
      const x = labels.length === 1 ? pad.l + plotW / 2 : pad.l + step * i;
      ctx.fillText(U.clip(l, 6), x, chh - 12);
    });

    if (spec.chartType === 'line') {
      datasets.forEach((d, di) => {
        ctx.strokeStyle = palette[di % palette.length];
        ctx.lineWidth = 2;
        ctx.beginPath();
        d.data.forEach((v, i) => {
          const x = labels.length === 1 ? pad.l + plotW / 2 : pad.l + step * i;
          const yy = y(v);
          if (i === 0) ctx.moveTo(x, yy); else ctx.lineTo(x, yy);
        });
        ctx.stroke();
        ctx.fillStyle = palette[di % palette.length];
        d.data.forEach((v, i) => {
          const x = labels.length === 1 ? pad.l + plotW / 2 : pad.l + step * i;
          ctx.beginPath(); ctx.arc(x, y(v), 3, 0, Math.PI * 2); ctx.fill();
        });
      });
    } else {
      const groups = labels.length || 1;
      const barW = Math.min(28, plotW / groups / Math.max(1, datasets.length) * 0.7);
      labels.forEach((_, i) => {
        datasets.forEach((d, di) => {
          const v = d.data[i] || 0;
          const x = pad.l + (plotW / groups) * i + (plotW / groups) / 2 - (datasets.length * barW) / 2 + di * barW;
          ctx.fillStyle = palette[di % palette.length];
          const top = y(v);
          ctx.fillRect(x, top, barW - 2, Math.max(1, pad.t + plotH - top));
        });
      });
    }

    // 图例（标题下方单独一行，避免压住绘图区）
    let lx = pad.l;
    const legendY = spec.title ? 40 : 18;
    datasets.forEach((d, di) => {
      ctx.fillStyle = palette[di % palette.length];
      ctx.fillRect(lx, legendY - 8, 9, 9);
      ctx.fillStyle = textColor;
      ctx.textAlign = 'left';
      const label = U.clip(d.label || '系列 ' + (di + 1), 12);
      ctx.fillText(label, lx + 13, legendY);
      lx += 13 + ctx.measureText(label).width + 18;
    });
  }

  /* ============================================================
     流式渲染
     ============================================================ */
  function appendUserToDom(view, m, index) {
    const el = buildUserEl(m, index);
    view.msgs.appendChild(el);
    scrollToBottom(view, true);
  }

  function createLiveAssistant(run) {
    const view = viewOf(run.session.id);
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.innerHTML = '<div class="name"><span class="avatar">' + AH.ui.icon('sparkles') + '</span><b>小匣</b><span class="live-time">' + U.fmtTime(Date.now()) + '</span></div>';
    const status = document.createElement('div');
    status.className = 'bubble assistant';
    status.innerHTML = '<span style="color:var(--text-3)">正在连接…</span>';
    wrap.appendChild(status);

    const stick = atBottom(view.msgs, 80);
    ensureStick(view.msgs);
    view.msgs.appendChild(wrap);
    if (stick) pinToBottom(view.msgs);
    const state = {
      view,
      wrap,
      statusEl: status,
      thinkingEl: null,
      thinkingBody: null,
      bodyEl: null,
      mdEl: null,
      cursorEl: null,
      text: '',
      thinking: '',
      cards: new Map(),
      cardsWrap: null,
      finished: false,
      visible: true,
      roundSeq: 0,
      // 上一次渲染时的输入指纹，用于跳过无变化的重复解析
      lastRendered: '',
      lastRenderAt: 0
    };

    // 正文：流式阶段即按 Markdown 渲染（节流 + 自适应间隔），避免"先看源码、结束才排版"
    const ensureBody = () => {
      if (state.bodyEl) return;
      status.remove();
      state.bodyEl = document.createElement('div');
      state.bodyEl.className = 'bubble assistant';
      state.mdEl = document.createElement('div');
      state.mdEl.className = 'md';
      state.cursorEl = document.createElement('span');
      state.cursorEl.className = 'cursor';
      state.bodyEl.appendChild(state.mdEl);
      if (state.cardsWrap && state.cardsWrap.parentElement === wrap) wrap.insertBefore(state.bodyEl, state.cardsWrap);
      else wrap.appendChild(state.bodyEl);
    };
    const ensureThinking = () => {
      if (state.thinkingEl) return;
      state.thinkingEl = buildThinking('', true);
      state.thinkingBody = state.thinkingEl.querySelector('.thinking-body');
      wrap.insertBefore(state.thinkingEl, state.bodyEl || status);
    };
    const ensureCards = () => {
      if (state.cardsWrap) return state.cardsWrap;
      state.cardsWrap = document.createElement('div');
      state.cardsWrap.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      wrap.appendChild(state.cardsWrap);
      return state.cardsWrap;
    };

    // 流式渲染：直接按 Markdown 解析，但用"自适应间隔"控制重排频率。
    // 短文本 60ms、长文本逐步放宽到 260ms —— 既保持观感连贯，又不在长回答时把主线程拖死。
    const renderNow = () => {
      if (state.finished) return;
      const stick = atBottom(view.msgs, 80);
      if (state.thinking) {
        ensureThinking();
        state.thinkingBody.textContent = state.thinking;
      }
      if (state.text) {
        ensureBody();
        const src = state.text;
        if (src !== state.lastRendered) {
          // 流式阶段先剥掉 [deliver:...] 标记，避免半截标记闪出来
          const shown = stripPartialDeliver(src);
          state.mdEl.innerHTML = AH.md.toHtml(shown) || '';
          state.lastRendered = src;
        }
        // 光标：跟在最后一个块级元素内部，保持行内跟随（结束后不再挂回）
        // 注意：上面的 innerHTML 赋值会把光标节点移出文档，这里必须重新挂载
        if (!state.finished && state.cursorEl) {
          const last = state.mdEl.lastElementChild;
          const inlineHost = last && /^(P|LI|H[1-6]|TD|TH|BLOCKQUOTE)$/.test(last.tagName) ? last : state.mdEl;
          if (state.cursorEl.parentElement !== inlineHost) inlineHost.appendChild(state.cursorEl);
        }
      }
      if (stick) pinToBottom(view.msgs);
    };

    // 根据当前文本长度决定下一次允许渲染的时间
    const renderInterval = () => {
      const n = state.text.length;
      if (n < 1200) return 60;
      if (n < 4000) return 120;
      if (n < 10000) return 180;
      return 260;
    };

    const pending = { t: null };
    const render = () => {
      const now = performance.now();
      const wait = renderInterval() - (now - state.lastRenderAt);
      if (wait <= 0) {
        if (pending.t) { clearTimeout(pending.t); pending.t = null; }
        state.lastRenderAt = now;
        renderNow();
      } else if (!pending.t) {
        pending.t = setTimeout(() => {
          pending.t = null;
          state.lastRenderAt = performance.now();
          renderNow();
        }, wait);
      }
    };

    state.setStatus = (t) => {
      if (state.finished) return;
      if (!state.text && !state.thinking && !state.cardsWrap) {
        status.innerHTML = '<span style="color:var(--text-3)">' + U.esc(t) + '</span>';
      }
    };
    state.onDelta = (text, thinking) => {
      state.text = text;
      state.thinking = thinking;
      if (state.thinkingEl && text && state.thinking) {
        const lbl = state.thinkingEl.querySelector('.lbl');
        if (lbl) lbl.textContent = '思考过程';
      }
      render();
    };
    state.onToolDelta = (index, name, argsText) => {
      if (!name) return;
      const stick = atBottom(view.msgs, 80);
      const key = state.roundSeq + ':' + index;
      let card = state.cards.get(key);
      if (!card) {
        const tc = { id: '', function: { name, arguments: argsText || '' } };
        card = buildToolCard(tc, parseSafe(argsText), null);
        state.cards.set(key, card);
        ensureCards().appendChild(card);
      } else {
        const argEl = card.querySelector('.tool-args');
        const args = parseSafe(argsText);
        if (argEl) argEl.textContent = U.clip(argSummary(args), 70);
        const pre = card.querySelector('.tool-body pre');
        if (pre) pre.textContent = JSON.stringify(args, null, 2);
      }
      if (stick) pinToBottom(view.msgs);
    };
    state.bindIds = (toolCalls) => {
      toolCalls.forEach((tc, i) => {
        const card = state.cards.get(state.roundSeq + ':' + i);
        if (card) card.dataset.call = tc.id;
      });
      state.roundSeq++;
    };
    state.findCard = (id) => {
      for (const c of state.cards.values()) if (c.dataset.call === id) return c;
      return null;
    };
    state.onToolStart = (id, args) => {
      const stick = atBottom(view.msgs, 80);
      const card = state.findCard(id);
      if (!card) return;
      card.dataset.status = 'running';
      const st = card.querySelector('.tool-status');
      const dot = card.querySelector('.tool-dot');
      if (st) st.textContent = '执行中…';
      if (dot) dot.className = 'tool-dot running';
      const pre = card.querySelector('.tool-body pre');
      if (pre) pre.textContent = JSON.stringify(args || {}, null, 2);
      card.classList.add('collapsed');
      if (stick) pinToBottom(view.msgs);
    };
    state.onToolFinish = (id, ok, text, ms, meta) => {
      const stick = atBottom(view.msgs, 80);
      const isBackground = !!(meta && meta.background && !meta.backgroundDone);
      const isCancelled = !!(meta && meta.cancelled);
      let card = state.findCard(id);
      if (!card) {
        // 兜底：流式阶段没拿到该调用，按 id 建一张
        card = buildToolCard({ id, function: { name: 'tool' } }, {}, null);
        card.dataset.call = id;
        state.cards.set('fallback:' + id, card);
        ensureCards().appendChild(card);
      }
      const dot = card.querySelector('.tool-dot');
      const st = card.querySelector('.tool-status');
      const dotState = isCancelled ? 'cancelled' : isBackground ? 'running' : ok ? 'ok' : 'error';
      if (dot) dot.className = 'tool-dot ' + dotState;
      if (st) st.textContent = isCancelled ? '已取消' : isBackground ? '后台运行' : ok ? '完成' : '失败';
      card.dataset.status = dotState;
      const head = card.querySelector('.tool-head');
      if (head && ms) {
        let time = head.querySelector('.tool-time');
        if (!time) { time = document.createElement('span'); time.className = 'tool-time'; time.style.marginLeft = '6px'; head.appendChild(time); }
        time.textContent = U.fmtDuration(ms);
      }
      const body = card.querySelector('.tool-body');
      if (body) {
        if (!body.querySelector('.result-label')) {
          const lbl = document.createElement('div');
          lbl.className = 'args-label result-label';
          lbl.style.marginTop = '10px';
          lbl.textContent = '结果';
          body.appendChild(lbl);
          const pre = document.createElement('pre');
          pre.className = 'tool-result';
          body.appendChild(pre);
        }
        const pre = body.querySelector('.tool-result');
        if (pre) pre.textContent = cleanCardText(text);
      }
      renderCardExtras(card, text);
      card.classList.toggle('collapsed', ok);
      if (stick) pinToBottom(view.msgs);
    };
    state.finalize = (content, thinking) => {
      state.finished = true;
      const stick = atBottom(view.msgs, 80);
      if (state.statusEl && state.statusEl.parentElement) state.statusEl.remove();
      const parsed = parseDeliver(content || state.text || '');
      state.text = parsed.text;
      state.thinking = thinking || state.thinking;
      if (state.thinkingEl) {
        const lbl = state.thinkingEl.querySelector('.lbl');
        if (lbl) lbl.textContent = '思考过程';
        const spin = state.thinkingEl.querySelector('.spin');
        if (spin) spin.remove();
        if (state.thinkingBody) state.thinkingBody.textContent = state.thinking;
      }
      if (state.text) {
        ensureBody();
        state.bodyEl.classList.remove('streaming');
        // 清理流式光标，做最终一次完整渲染（此时 deliver 标记已剔除）
        if (state.cursorEl && state.cursorEl.parentElement) state.cursorEl.remove();
        state.mdEl.innerHTML = AH.md.toHtml(state.text) || '';
        AH.md.renderMathIn(state.mdEl);
        state.lastRendered = state.text;
      }
      if ((parsed.datas || []).length && !state.deliverEl) {
        state.deliverEl = document.createDocumentFragment();
        parsed.datas.forEach((d) => state.deliverEl.appendChild(buildDeliverCard(d)));
        wrap.appendChild(state.deliverEl);
      }
      attachMsgActions(state, state.text);
      if (stick) pinToBottom(view.msgs, true);
    };
    state.attachMeta = (usage) => {
      if (!usage || (!usage.inTok && !usage.outTok)) return;
      const stick = atBottom(view.msgs, 80);
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.innerHTML = '<span>' + usage.inTok + ' 入 / ' + usage.outTok + ' 出' + (usage.cost ? ' · $' + usage.cost.toFixed(4) : '') + '</span>';
      wrap.appendChild(meta);
      if (stick) pinToBottom(view.msgs);
    };
    // 记住这条会话当前的气泡：切走再切回来时，保留流式 DOM 而不是重绘
    view.live = state;
    return state;
  }

  function attachMsgActions(state, content) {
    if (!state.actionsAdded) {
      state.actionsAdded = true;
      if (content) {
        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        const actions = document.createElement('div');
        actions.className = 'msg-actions';
        const copy = document.createElement('button');
        copy.textContent = '复制';
        copy.addEventListener('click', async () => { AH.ui.copied(await U.copyText(content)); });
        actions.appendChild(copy);
        meta.appendChild(actions);
        state.wrap.appendChild(meta);
      }
    }
  }

  function ensureStick(el) {
    if (!el || el._stickReady) return;
    el._stickReady = true;
    el._stick = true;
    el._lastTop = el.scrollTop || 0;
    el.addEventListener('scroll', () => {
      const top = el.scrollTop;
      const gap = el.scrollHeight - top - el.clientHeight;
      if (gap <= 8) el._stick = true;
      else if (top < el._lastTop - 2) el._stick = false;
      el._lastTop = top;
    }, { passive: true });
  }
  function atBottom(el, slack) {
    if (!el) return false;
    ensureStick(el);
    if (el._stick === false) return false;
    return el._stick === true || el.scrollHeight - el.scrollTop - el.clientHeight <= (slack == null ? 80 : slack);
  }
  function pinToBottom(el, settle) {
    if (!el) return;
    ensureStick(el);
    if (el._stick === false) return;
    const toEnd = () => {
      if (el._stick === false) return;
      el.scrollTop = el.scrollHeight;
      el._lastTop = el.scrollTop;
    };
    let left = settle ? 8 : 3;
    const step = () => {
      toEnd();
      if (left-- > 0 && el._stick !== false) requestAnimationFrame(step);
    };
    step();
    if (settle) {
      setTimeout(toEnd, 140);
      setTimeout(toEnd, 320);
    }
  }
  function scrollBottomSmart(view) {
    const el = msgsOf(view);
    if (!el) return;
    if (atBottom(el, 80)) pinToBottom(el);
  }
  function scrollToBottom(view, force) {
    const el = msgsOf(view);
    if (!el) return;
    if (force) {
      ensureStick(el);
      el._stick = true;
      pinToBottom(el, true);
    } else scrollBottomSmart(view);
  }

  /* ============================================================
     欢迎页
     ============================================================ */
  function renderWelcome(view) {
    const v = view || currentView();
    if (!v || !v.welcome) return;
    const empty = !convOf(v.id).length;
    v.welcome.hidden = !empty;
    v.msgs.style.visibility = empty ? 'hidden' : '';
  }

  /* ============================================================
     历史列表
     ============================================================ */
  function renderHistory() {
    if (!els.history) return;
    els.history.innerHTML = '';
    const list = [...Chat.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!list.length) { els.history.innerHTML = '<div class="hist-empty">还没有对话</div>'; return; }

    // 多会话：顶部一条状态，明确告诉用户“有几个在同时生成”，并给一个全部停止
    const runningList = list.filter((s) => Chat.isRunning(s.id));
    if (runningList.length) {
      const bar = document.createElement('div');
      bar.className = 'hist-status';
      const txt = document.createElement('span');
      txt.innerHTML = '<b>' + runningList.length + '</b> 个对话正在生成';
      const stopAll = document.createElement('button');
      stopAll.className = 'link-btn';
      stopAll.textContent = '全部停止';
      stopAll.addEventListener('click', () => Chat.stopAll());
      bar.appendChild(txt);
      bar.appendChild(stopAll);
      els.history.appendChild(bar);
    }

    list.forEach((s) => {
      const running = Chat.isRunning(s.id);
      const unread = !!s.unread && !running;
      const row = document.createElement('div');
      row.className = 'node-row' + (s.id === Chat.currentId ? ' active' : '') +
        (running ? ' running' : '') + (unread ? ' unread' : '');
      row.innerHTML =
        '<span class="node-ico">' + AH.ui.icon(iconOf(s.title)) + '</span>' +
        '<span class="node-name">' + U.esc(s.title || '未命名') + '</span>' +
        (unread ? '<span class="unread-dot" title="有新回复"></span>' : '') +
        (running ? '<span class="run-dot" title="正在生成 · 点击停止"></span>'
          : '<span class="node-size">' + U.fmtTime(s.updatedAt) + '</span>');
      row.title = (running ? '生成中（点转圈可停止）· ' : unread ? '有新回复 · ' : '') + (s.preview || s.title || '');
      row.addEventListener('click', () => Chat.switchSession(s.id));
      if (running) {
        const dot = row.querySelector('.run-dot');
        if (dot) dot.addEventListener('click', (e) => { e.stopPropagation(); Chat.stop(s.id); });
      }
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const items = [];
        if (running) items.push({ label: '停止生成', icon: 'stop', onClick: () => Chat.stop(s.id) });
        items.push({ label: '重命名', icon: 'edit', onClick: async () => {
          const t = prompt('对话标题', s.title || '');
          if (t) {
            s.title = U.clip(t, 40);
            await Chat._saveIndex();
            if (s.id === Chat.currentId) renderHeader();
            renderHistory();
          }
        } });
        items.push({ sep: true });
        items.push({ label: '删除对话', icon: 'trash', danger: true, onClick: () => Chat.deleteSession(s.id) });
        AH.ui.contextMenu(e.clientX, e.clientY, items);
      });
      els.history.appendChild(row);
    });

    // 侧栏「对话」页签上挂一个数字，停在「文件」页时也知道有几个在跑
    const segBtn = document.querySelector('.seg-btn[data-side="history"]');
    if (segBtn) {
      let badge = segBtn.querySelector('.seg-badge');
      if (runningList.length) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'seg-badge'; segBtn.appendChild(badge); }
        badge.textContent = String(runningList.length);
      } else if (badge) badge.remove();
    }

    // 浏览器标签页上也标一下，切到别的窗口时能看见还有几个在跑
    try { document.title = (runningList.length ? '(' + runningList.length + ') ' : '') + '小匣 · AI Agent'; } catch (e) {}
  }
  Chat.renderHistory = renderHistory;

  /* ============================================================
     输入与附件
     ============================================================ */
  const attachments = [];
  Chat.attachments = attachments;

  function renderAttachments() {
    if (!els.attach) return;
    els.attach.innerHTML = '';
    els.attach.hidden = !attachments.length;
    attachments.forEach((a, i) => {
      const el = document.createElement('div');
      el.className = 'attach';
      if (a.isImage) {
        const img = document.createElement('img');
        img.src = a.thumb || '';
        el.appendChild(img);
      }
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = a.name + (a.isDir ? '（' + (a.count || 0) + ' 个文件）' : '');
      el.appendChild(nm);
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.innerHTML = AH.ui.icon('x');
      rm.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); });
      el.appendChild(rm);
      els.attach.appendChild(el);
    });
  }
  Chat.renderAttachments = renderAttachments;

  Chat.addUpload = async function (file) {
    if (!file) return;
    const name = String(file.name || 'file').replace(/[\\/:*?"<>|]/g, '_');
    if (U.extName(name) === 'zip') {
      if (file.size > 25 * 1024 * 1024) { AH.ui.toast('ZIP 超过 25MB，未上传', 'warn'); return; }
      try {
        const r = await AH.zip.toVfs(file, '/uploads', name);
        attachments.push({
          name: r.name.replace(/\.zip$/i, '') + '/',
          path: r.root,
          isDir: true,
          count: r.files,
          isImage: false
        });
        renderAttachments();
        AH.ui.toast('已解压 ' + r.files + ' 个文件到 ' + r.root, 'ok', 2800);
      } catch (e) {
        AH.ui.error('ZIP 解压失败：' + e.message);
      }
      return;
    }
    const isImage = /^image\//.test(file.type) || U.isImagePath(name);
    const path = '/uploads/' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6) + '-' + name;
    try {
      if (isImage) {
        const dataUrl = await U.readFileDataUrl(file);
        const item = { name, path, isImage: true, thumb: dataUrl };
        if (dataUrl.length > 400000) {
          const ok = await AH.ui.confirm({ title: '图片较大', text: '这张图片约 ' + U.fmtSize(dataUrl.length) + '，存入 VFS 会占用本地空间。继续？', danger: false });
          if (!ok) return;
        }
        await VFS.write(path, dataUrl);
        attachments.push(item);
      } else {
        if (file.size > 2 * 1024 * 1024) {
          AH.ui.toast('文本文件超过 2MB，未上传', 'warn');
          return;
        }
        const text = await U.readFileText(file);
        await VFS.write(path, text);
        attachments.push({ name, path, isImage: false });
      }
      renderAttachments();
    } catch (e) {
      AH.ui.error('上传失败：' + e.message);
    }
  };

  Chat.handlePaste = async function (e) {
    const items = [...(e.clipboardData && e.clipboardData.items || [])];
    const imgs = items.filter((it) => it.type.startsWith('image/'));
    if (!imgs.length) return;
    e.preventDefault();
    for (const it of imgs) {
      const file = it.getAsFile();
      if (file) await Chat.addUpload(new File([file], 'paste-' + Date.now() + '.' + (file.type.split('/')[1] || 'png'), { type: file.type }));
    }
  };

  /* ============================================================
     发送
     ============================================================ */
  /* 图片能力判定
     原实现只看模型名白名单，白名单外的模型（如 deepseek-flash）一律判为不支持，
     图片被降级成一行文字，模型根本收不到图像。
     现在改为三级：手动强制开/关，或 auto 乐观尝试——未知模型先带图发出，
     真正被服务端拒绝时再自动降级并把该模型记下来，不重复试错。 */
  function visionRejectedList() {
    const arr = cfg.get('visionRejected');
    return Array.isArray(arr) ? arr : [];
  }

  Chat.markVisionUnsupported = function (model) {
    const m = String(model || '');
    if (!m) return;
    const list = visionRejectedList();
    if (list.indexOf(m) >= 0) return;
    cfg.set('visionRejected', list.concat([m]));
  };

  function supportsVision(model) {
    const m = String(model || '');
    const mode = cfg.get('vision');
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    // auto：已知会拒绝的模型不再发图，其余一律乐观尝试
    return visionRejectedList().indexOf(m) < 0;
  }
  Chat.supportsVision = supportsVision;

  function needsAgent(text, atts) {
    const mode = cfg.get('agentMode');
    if (mode === 'agent') return true;
    if (mode === 'chat') return false;
    if (atts && atts.length) return true;
    const t = String(text || '');
    if (t.length > 120) return true;
    if (/[\/\\]\w+|[A-Za-z]:\\/.test(t)) return true;
    return /(文件|目录|读一下|读取|写入|写到|改一下|修改|代码|脚本|运行|执行|搜索|查找|创建|新建|删除|整理|分析|检查|编译|调试|图表|画个|生成|导出|保存|项目|网页|html|js|python|json|markdown|todo|待办|帮我|能不能|请|查一下|列一下|列出)/.test(t);
  }

  Chat.isRunning = function (sessionId) {
    const r = Chat.runs.get(sessionId || Chat.currentId);
    return !!(r && r.running);
  };

  function runningIds() {
    const out = [];
    for (const [id, r] of Chat.runs) if (r && r.running) out.push(id);
    return out;
  }
  Chat.runningIds = runningIds;
  Chat.anyRunning = () => runningIds().length > 0;
  Chat.runningCount = () => runningIds().length;

  function maxParallel() {
    return U.clamp(parseInt(cfg.get('maxParallel'), 10) || 3, 1, 5);
  }

  /* 在「对话」列表里按当前排序切上一条 / 下一条（不影响其它正在生成的会话） */
  Chat.cycleSession = function (dir) {
    const list = [...Chat.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
    if (list.length < 2) return;
    const i = list.findIndex((s) => s.id === Chat.currentId);
    const next = list[(Math.max(0, i) + dir + list.length) % list.length];
    if (next && next.id !== Chat.currentId) Chat.switchSession(next.id);
  };

  function updateRunningUI() {
    const running = Chat.isRunning();
    if (els.stop) els.stop.hidden = !running;
    if (els.send) els.send.disabled = running;
    const others = runningIds().filter((id) => id !== Chat.currentId).length;
    if (els.input) {
      els.input.placeholder = running
        ? '小匣正在处理，可点停止…'
        : others
          ? '其他对话正在生成中，这个对话也可以继续发…（Enter 发送）'
          : '给 AI 下达指令…（Enter 发送，Shift+Enter 换行，可粘贴图片）';
    }
  }
  Chat.updateRunningUI = updateRunningUI;

  Chat.send = async function (text, opts) {
    const o = opts || {};
    const sid = o.sessionId || Chat.currentId;
    if (!sid) return;
    const meta = Chat.sessions.find((s) => s.id === sid);
    if (!meta) return;
    if (!o.fromCard) {
      text = String(text == null ? '' : text).trim();
      if (!text && !attachments.length) return;
    }
    if (Chat.isRunning(sid)) { AH.ui.toast('这个对话还在生成，先停止或等它结束', 'warn'); return; }
    if (runningIds().length >= maxParallel()) {
      AH.ui.toast('同时进行的对话已达上限 ' + maxParallel() + ' 个，等其中一个结束再发；可在设置 → Agent 调整', 'warn', 4200);
      return;
    }
    if (!cfg.get('apiKey')) {
      AH.ui.toast('请先填写 API Key（设置 → 模型）', 'warn', 3200);
      setTimeout(() => AH.settings.open(), 120);
      return;
    }

    const conv = convOf(sid);
    const view = viewOf(sid);
    const fromComposer = !o.fromCard && sid === Chat.currentId;
    // 卡片触发的自动发送（提问卡等）不碰输入区里的附件，避免别的对话把它“吃掉”
    const atts = o.fromCard ? [] : attachments.splice(0, attachments.length);
    if (!o.fromCard) renderAttachments();

    const useTools = typeof o.useTools === 'boolean' ? o.useTools : needsAgent(text, atts);
    const vision = supportsVision(cfg.get('model'));
    const hasImage = atts.some((a) => a.isImage);

    // 组装用户消息：图片在支持视觉时走 image_url，否则只给路径
    let content = text;
    const images = atts.filter((a) => a.isImage).map((a) => ({ path: a.path }));
    if (hasImage && vision) {
      const parts = [{ type: 'text', text: text || '请看这张图片。' }];
      for (const a of atts.filter((x) => x.isImage)) {
        try {
          const dataUrl = await VFS.read(a.path);
          parts.push({ type: 'image_url', image_url: { url: dataUrl } });
        } catch (e) {}
      }
      content = parts;
    } else if (atts.length) {
      const lines = atts.map((a) => '- ' + a.path + (a.isDir ? '（目录' + (a.count ? '，' + a.count + ' 个文件' : '') + '，可 list_files）' : a.isImage ? '（图片，本次未随消息发送图像内容）' : '（已存入 VFS，可 read_file）'));
      content = (text ? text + '\n\n' : '') + '附带文件（已存入 VFS）：\n' + lines.join('\n');
    }

    let userMsg;
    if (o.reuseLastUser) {
      let lastUser = -1;
      for (let i = conv.length - 1; i >= 0; i--) if (conv[i].role === 'user') { lastUser = i; break; }
      userMsg = conv[lastUser];
      if (!userMsg) return;
    } else {
      userMsg = { role: 'user', content, images, _at: Date.now() };
      conv.push(userMsg);
      if (fromComposer) { els.input.value = ''; autoHeight(); }
      view.welcome.hidden = true;
      view.msgs.style.visibility = '';
      appendUserToDom(view, userMsg, conv.length - 1);
      trimConversationDom(view, conv);
    }
    view.renderStart = renderStartFor(conv);
    // 发消息是真实活动，刷新排序时间
    Chat.saveSoon(sid, { bump: true });

    if (meta.title === '新对话' && conv.filter((m) => m.role === 'user').length === 1) {
      const t = U.clip(text || '图片对话', 26);
      meta.title = t || '新对话';
      if (sid === Chat.currentId) renderHeader();
      renderHistory();
    }

    const controller = new AbortController();
    const run = {
      session: meta,
      conv,
      signal: controller.signal,
      controller,
      useTools,
      vision,
      attachments: atts,
      running: true,
      awaitUser: false,
      roundId: U.uid('r'),
      toolLog: [],
      usage: { inTok: 0, outTok: 0, cost: 0 },
      hooks: {},
      startedAt: Date.now(),
      _undo: []
    };
    Chat.runs.set(sid, run);
    updateRunningUI();
    updateTokenBar();
    renderHistory();

    // 每一轮模型调用一个独立气泡：上一轮收尾后，下一轮开始再新建
    let live = null;
    const beginRound = () => {
      if (live && !live.finished) live.finalize(live.text, live.thinking);
      live = createLiveAssistant(run);
    };
    run.hooks.roundStart = beginRound;

    run.hooks.status = (t) => { if (live) live.setStatus(t); };
    run.hooks.delta = (text2, thinking) => { if (live) live.onDelta(text2, thinking); };
    run.hooks.toolDelta = (idx, name, args) => { if (live) live.onToolDelta(idx, name, args); };
    run.hooks.toolsReady = (calls) => { if (live) live.bindIds(calls); };
    run.hooks.toolStart = (id, args) => {
      if (!live) return;
      live.onToolStart(id, args);
      let tc = null;
      for (const m of run.conv) {
        if (m.role !== 'assistant' || !m.tool_calls) continue;
        const hit = m.tool_calls.find((x) => x.id === id);
        if (hit) { tc = hit; break; }
      }
      run.toolLog.push({ id, name: tc ? tc.function.name : 'tool', args, status: 'running', at: Date.now() });
      AH.app.refreshTasks();
    };
    run.hooks.toolFinish = (id, ok, text2, ms, meta) => {
      if (live) live.onToolFinish(id, ok, text2, ms, meta);
      const item = run.toolLog.find((x) => x.id === id);
      if (item) {
        item.status = meta && meta.background && !meta.backgroundDone ? 'background'
          : meta && meta.cancelled ? 'cancelled' : ok ? 'ok' : 'error';
        item.result = U.clip(String(text2 || ''), 2400);
        item.ms = ms;
      }
      AH.app.refreshTasks();
    };
    run.hooks.usage = (usage) => { if (Chat.currentId === sid) updateTokenBar(); };
    run.hooks.assistantDone = (content, thinking) => { if (live) live.finalize(content, thinking); };
    run.hooks.error = (msg) => {
      const mine = Chat.currentId === sid;
      AH.ui.toast((mine ? '' : '「' + (meta.title || '对话') + '」') + msg, 'err', 5000);
      appendError(view, msg);
    };

    try {
      if (run.memHits == null && cfg.get('memory') !== false) {
        run.memHits = await AH.memory.search(text || '', 3).then((x) => x).catch(() => []);
      }
      await AH.agent.run(run);
    } catch (e) {
      if (String(e.message) === '__STOPPED__') {
        appendStopped(view);
      } else {
        appendError(view, e && e.message ? e.message : String(e));
      }
    } finally {
      run.running = false;
      // 中断/失败时补齐 tool 响应，避免下一次请求 400
      repairDangling(conv);
      if (live) {
        if (!live.finished) {
          const last = [...conv].reverse().find((m) => m.role === 'assistant');
          if (last && last.content) live.finalize(last.content, last._thinking);
          else if (live.wrap.parentElement) live.wrap.remove();
        }
        live.attachMeta(run.usage);
      }
      // 会话在生成过程中被删掉：不再写回 kv，避免“诈尸”
      const alive = Chat.sessions.some((s) => s.id === sid);
      if (alive) {
        // 后台跑完的会话在列表里留一个未读点，直到用户点开
        if (Chat.currentId !== sid) meta.unread = true;
        await Chat.saveConv(sid, conv, { bump: true });
      }
      trimConversationDom(view, conv);
      run.conv = null;
      run.attachments = null;
      run._undo = null;
      run._seenResults = null;
      if (Chat.currentId === sid) {
        updateTokenBar();
        updateRunningUI();
      }
      renderHistory();
      AH.app.refreshTasks();
      if (alive) maybeTitleGen(meta, conv);
      if (live && !live.text && !live.cards.size && !live.finished && live.wrap.parentElement) live.wrap.remove();
    }
  };

  function repairDangling(conv) {
    let last = null;
    for (let i = conv.length - 1; i >= 0; i--) {
      if (conv[i].role === 'assistant' && conv[i].tool_calls && conv[i].tool_calls.length) { last = conv[i]; break; }
    }
    if (!last) return;
    for (const tc of last.tool_calls) {
      if (!conv.some((m) => m.role === 'tool' && m.tool_call_id === tc.id)) {
        conv.push({ role: 'tool', tool_call_id: tc.id, content: '用户已停止或本轮异常结束，未执行。' });
      }
    }
  }

  function appendError(view, msg) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="bubble" style="border:1px solid var(--danger-soft);background:var(--danger-soft);color:var(--danger);padding:9px 12px;border-radius:9px;font-size:13px;white-space:pre-wrap"></div>';
    el.querySelector('.bubble').textContent = String(msg);
    view.msgs.appendChild(el);
    scrollToBottom(view, true);
  }

  function appendStopped(view) {
    const el = document.createElement('div');
    el.className = 'msg assistant';
    el.innerHTML = '<div class="msg-meta"><span>已停止生成</span></div>';
    view.msgs.appendChild(el);
    scrollToBottom(view, true);
  }

  /* 停止指定会话（默认当前）：多个 run 并行时不会误停别人 */
  Chat.stop = function (id) {
    const sid = id || Chat.currentId;
    const run = Chat.runs.get(sid);
    if (!run || !run.running) return;
    try { run.controller.abort(); } catch (e) {}
    const name = (run.session && run.session.title) || '对话';
    AH.ui.toast(sid === Chat.currentId ? '正在停止…' : '正在停止「' + name + '」…', 'warn', 1400);
  };

  Chat.stopAll = function () {
    for (const id of runningIds()) Chat.stop(id);
  };

  Chat.regenerate = async function () {
    if (Chat.isRunning()) return;
    const conv = Chat.conv;
    let lastUser = -1;
    for (let i = conv.length - 1; i >= 0; i--) if (conv[i].role === 'user') { lastUser = i; break; }
    if (lastUser < 0) return;
    const text = msgText(conv[lastUser]);
    const hadTools = conv.slice(lastUser + 1).some((m) => m.role === 'assistant' && m.tool_calls);
    conv.splice(lastUser + 1);
    const view = currentView();
    if (view) {
      view.renderStart = renderStartFor(conv);
      renderConversation(view);
    }
    // 重新生成是真实活动，刷新排序时间
    Chat.saveSoon(null, { bump: true });
    // 复用这条用户消息，不重复插入
    await Chat.send(text, { fromCard: true, reuseLastUser: true, useTools: hadTools, sessionId: Chat.currentId });
  };

  async function maybeTitleGen(meta, conv) {
    if (!meta || !cfg.get('titleGen')) return;
    if (meta.title && meta.title !== '新对话') return;
    const title = await AH.agent.generateTitle({ conv: conv || convOf(meta.id) });
    if (!title) return;
    meta.title = title;
    await Chat._saveIndex();
    if (Chat.currentId === meta.id) renderHeader();
    renderHistory();
  }

  /* ============================================================
     事件绑定
     ============================================================ */
  function autoHeight() {
    const ta = els.input;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(280, Math.max(46, ta.scrollHeight)) + 'px';
  }
  Chat.autoHeight = autoHeight;

  function bindEvents() {
    els.input.addEventListener('input', () => { autoHeight(); });
    els.input.addEventListener('paste', (e) => Chat.handlePaste(e));
    els.input.addEventListener('keydown', (e) => {
      const ctrlSend = cfg.get('sendKey') === 'ctrl';
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Enter' && !e.isComposing) {
        if (ctrlSend ? mod : !e.shiftKey) {
          e.preventDefault();
          Chat.send(els.input.value);
        }
      }
    });
    els.send.addEventListener('click', () => Chat.send(els.input.value));
    els.stop.addEventListener('click', () => Chat.stop());

    els.title.addEventListener('change', () => Chat.renameCurrent(els.title.value));
    els.title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); els.title.blur(); } });

    const upload = document.getElementById('fileInput');
    document.getElementById('btnUpload').addEventListener('click', () => upload.click());
    upload.addEventListener('change', async () => {
      for (const f of [...upload.files]) await Chat.addUpload(f);
      upload.value = '';
    });

    const modeBtn = document.getElementById('btnMode');
    const paintMode = () => {
      const m = cfg.get('agentMode');
      modeBtn.textContent = m === 'agent' ? 'Agent' : m === 'chat' ? '聊天' : '自动';
      modeBtn.title = '对话模式：' + (m === 'agent' ? '始终启用工具' : m === 'chat' ? '纯聊天，最省 token' : '按消息自动判断');
    };
    modeBtn.addEventListener('click', () => {
      const m = cfg.get('agentMode');
      const next = m === 'auto' ? 'agent' : m === 'agent' ? 'chat' : 'auto';
      cfg.set('agentMode', next);
      paintMode();
      AH.ui.toast('对话模式：' + (next === 'agent' ? '始终 Agent' : next === 'chat' ? '纯聊天' : '自动'), 'ok', 1600);
    });
    paintMode();

    // 消息区：代码复制、链接等委托（所有会话共用一份，事件在 chatBody 上冒泡）
    if (els.chatBody) {
      els.chatBody.addEventListener('click', async (e) => {
        const copy = e.target.closest('.codeblock .copy');
        if (copy) {
          const pre = copy.closest('.codeblock').querySelector('pre');
          AH.ui.copied(await U.copyText(pre ? pre.textContent : ''));
        }
      });

      // 欢迎页示例提示：每个会话一份，走事件委托
      els.chatBody.addEventListener('click', (e) => {
        const tip = e.target.closest('.welcome .tip');
        if (!tip) return;
        const view = tip.closest('.msg-view');
        const sid = view && view.dataset.session;
        if (sid && sid !== Chat.currentId) return;   // 只有当前会话的欢迎页可点
        els.input.value = tip.dataset.prompt || '';
        autoHeight();
        els.input.focus();
        Chat.send(tip.dataset.prompt || '');
      });
    }

    document.getElementById('btnNewChat').addEventListener('click', () => Chat.newSession());
    document.getElementById('btnClearChat').addEventListener('click', () => Chat.clearCurrent());

    // 列表快捷键：Alt + ↑/↓ 在「对话」列表里切上一条 / 下一条（切走不会停止正在生成的）
    document.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        Chat.cycleSession(e.key === 'ArrowDown' ? 1 : -1);
      }
    });

    // 拖拽上传
    let dragDepth = 0;
    const hint = document.getElementById('dropHint');
    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      dragDepth++;
      hint.hidden = false;
    });
    document.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) hint.hidden = true; });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', async (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      dragDepth = 0; hint.hidden = true;
      for (const f of [...e.dataTransfer.files]) await Chat.addUpload(f);
    });
  }

  /* 暴露给 app.js 的初始化入口 */
  Chat.initUI = bindEvents;
})();
