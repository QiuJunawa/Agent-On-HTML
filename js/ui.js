/* ============================================================
   ui.js · 图标 / Toast / 确认框 / 右键菜单
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;

  /* 图标：Lucide 风格的 path 数据，统一 24×24 视口 */
  const ICONS = {
    chat: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'],
    activity: ['M22 12h-4l-3 9L9 3l-3 9H2'],
    moon: ['M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 9.8 9.8z'],
    sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'M4.2 4.2l1.4 1.4', 'M18.4 18.4l1.4 1.4', 'M1 12h2', 'M21 12h2', 'M4.2 19.8l1.4-1.4', 'M18.4 5.6l1.4-1.4'],
    settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'],
    more: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
    'file-plus': ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M12 13v6', 'M9 16h6'],
    'folder-plus': ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z', 'M12 11v6', 'M9 14h6'],
    upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
    download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
    archive: ['M21 8v13H3V8', 'M1 3h22v5H1z', 'M10 12h4'],
    eraser: ['M20 20H7L3 16a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-7 7', 'M6 11l5 5'],
    checklist: ['M9 6h12', 'M9 12h12', 'M9 18h12', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    'panel-left': ['M3 3h18v18H3z', 'M9 3v18'],
    'panel-right': ['M3 3h18v18H3z', 'M15 3v18'],
    plus: ['M12 5v14', 'M5 12h14'],
    trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    paperclip: ['M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48'],
    stop: ['M6 6h12v12H6z'],
    send: ['M22 2L11 13', 'M22 2l-7 20-4-9-9-4z'],
    'file-text': ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M16 13H8', 'M16 17H8', 'M10 9H8'],
    file: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6'],
    folder: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
    'chevron-right': ['M9 6l6 6-6 6'],
    'chevron-down': ['M6 9l6 6 6-6'],
    check: ['M20 6L9 17l-5-5'],
    alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L14.2 3.9a2 2 0 0 0-3.4 0z'],
    sparkles: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z'],
    copy: ['M8 8h11v13H8z', 'M5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1'],
    refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10', 'M1 14l4.6 3.4A9 9 0 0 0 20.5 15'],
    edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
    external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
    brain: ['M9.5 2A2.5 2.5 0 0 0 7 4.5v.5a2.5 2.5 0 0 0-2 2.5v1a2.5 2.5 0 0 0-1 2v2a2.5 2.5 0 0 0 1 2v1a2.5 2.5 0 0 0 2 2.5v.5a2.5 2.5 0 0 0 5 0v-.5a2.5 2.5 0 0 0 2-2.5v-1a2.5 2.5 0 0 0 1-2v-2a2.5 2.5 0 0 0-1-2v-1a2.5 2.5 0 0 0-2-2.5v-.5a2.5 2.5 0 0 0-5 0z'],
    terminal: ['M4 17l6-6-6-6', 'M12 19h8'],
    chart: ['M3 3v18h18', 'M7 16v-5', 'M12 16v-9', 'M17 16v-3'],
    question: ['M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4', 'M12 17h.01'],
    box: ['M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z', 'M3.3 7L12 12l8.7-5', 'M12 22V12'],
    clock: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 6v6l4 2'],
    search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
    dollar: ['M12 1v22', 'M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6']
  };

  function icon(name, cls) {
    const paths = ICONS[name] || ICONS.box;
    return '<svg viewBox="0 0 24 24" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : '') + '>' +
      paths.map((d) => '<path d="' + d + '"/>').join('') + '</svg>';
  }

  const UI = (AH.ui = {
    icon,
    allowedConfirms: new Set()
  });

  /* 把 data-icon 属性填成真实 SVG（只跑一次） */
  UI.mountIcons = function (root) {
    const scope = root || document;
    scope.querySelectorAll('[data-icon]').forEach((el) => {
      if (el.dataset.iconDone === '1') return;
      el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
      el.dataset.iconDone = '1';
    });
  };

  /* ---------- Toast ---------- */
  UI.toast = function (msg, type, ms) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(() => {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(4px)';
      setTimeout(() => el.remove(), 240);
    }, Math.max(1200, ms || 2400));
  };

  UI.error = (msg) => UI.toast(String(msg && msg.message ? msg.message : msg), 'err', 4000);

  /* ---------- 确认框 ---------- */
  let confirmResolver = null;
  UI.confirm = function (opts) {
    const o = Object.assign({ title: '确认操作', text: '', danger: true, rememberKey: '' }, opts || {});
    if (o.rememberKey && UI.allowedConfirms.has(o.rememberKey)) return Promise.resolve(true);
    if (confirmResolver) { const prev = confirmResolver; confirmResolver = null; prev(false); }
    const modal = document.getElementById('confirmModal');
    const title = document.getElementById('confirmTitle');
    const text = document.getElementById('confirmText');
    const rememberWrap = document.getElementById('confirmRememberWrap');
    const remember = document.getElementById('confirmRemember');
    const ok = document.getElementById('confirmOk');
    title.textContent = o.title;
    text.textContent = o.text;
    remember.checked = false;
    rememberWrap.hidden = !o.rememberKey;
    ok.textContent = o.okText || '确认';
    ok.className = 'chip-btn ' + (o.danger ? 'danger' : 'primary');
    modal.hidden = false;
    remember.dataset.key = o.rememberKey || '';
    return new Promise((resolve) => {
      confirmResolver = (val) => {
        if (val && remember.checked && o.rememberKey) UI.allowedConfirms.add(o.rememberKey);
        confirmResolver = null;
        modal.hidden = true;
        resolve(val);
      };
    });
  };
  UI.initConfirm = function () {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmOk').addEventListener('click', () => confirmResolver && confirmResolver(true));
    document.getElementById('confirmCancel').addEventListener('click', () => confirmResolver && confirmResolver(false));
    modal.addEventListener('click', (e) => { if (e.target === modal) confirmResolver && confirmResolver(false); });
    document.addEventListener('keydown', (e) => {
      if (!confirmResolver) return;
      if (e.key === 'Escape') { e.preventDefault(); confirmResolver(false); }
      if (e.key === 'Enter') { e.preventDefault(); confirmResolver(true); }
    });
  };

  /* ---------- 通用弹窗 ---------- */
  UI.openModal = (id) => { const m = document.getElementById(id); if (m) m.hidden = false; };
  UI.closeModal = (id) => { const m = document.getElementById(id); if (m) m.hidden = true; };

  /* ---------- 右键菜单 ---------- */
  let ctxOpen = false;
  UI.contextMenu = function (x, y, items) {
    const menu = document.getElementById('ctxMenu');
    menu.innerHTML = '';
    for (const it of items) {
      if (it.sep) { menu.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); continue; }
      const b = document.createElement('button');
      if (it.danger) b.className = 'danger';
      b.innerHTML = (it.icon ? icon(it.icon) : '') + '<span>' + U.esc(it.label) + '</span>';
      if (it.icon) b.firstChild.style.width = '14px';
      b.addEventListener('click', () => { UI.hideContextMenu(); it.onClick && it.onClick(); });
      menu.appendChild(b);
    }
    menu.hidden = false;
    menu.style.left = '0px'; menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';
    ctxOpen = true;
  };
  UI.hideContextMenu = function () {
    if (!ctxOpen) return;
    document.getElementById('ctxMenu').hidden = true;
    ctxOpen = false;
  };

  document.addEventListener('mousedown', (e) => {
    if (ctxOpen && !e.target.closest('#ctxMenu')) UI.hideContextMenu();
  });
  window.addEventListener('blur', UI.hideContextMenu);
  document.addEventListener('scroll', UI.hideContextMenu, true);

  /* ---------- 小工具 ---------- */
  UI.attachIcon = (el, name) => { el.innerHTML = icon(name) + el.innerHTML; };
  UI.copied = (ok) => UI.toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err', 1400);
})();
