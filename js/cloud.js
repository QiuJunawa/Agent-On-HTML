/* ============================================================
   cloud.js · 跨设备云端同步
   支持 WebDAV / GitHub Gist / Gitee 代码片段 / 自定义 HTTP 备份
   快照与本地备份同形：{ app, version, exportedAt, files, sessions, memory, todos, config? }
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;
  const cfg = AH.cfg;
  const $ = (id) => document.getElementById(id);

  const C = (AH.cloud = {});
  const REQ_TIMEOUT = 45000;
  let busy = false;

  function s(key, fallback) {
    const v = cfg.get(key);
    return v == null ? (fallback || '') : String(v);
  }

  function backend() { return s('cloudBackend', 'webdav'); }
  function fileName() { return s('cloudFile', 'xiaohe-cloud.json').trim() || 'xiaohe-cloud.json'; }

  function basicAuth(user, pass) {
    const bytes = new TextEncoder().encode(String(user || '') + ':' + String(pass || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'Basic ' + btoa(bin);
  }

  async function request(url, opts, label) {
    const o = Object.assign({}, opts || {});
    const timeout = o.timeout || REQ_TIMEOUT;
    delete o.timeout;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      return await fetch(url, Object.assign({ signal: ac.signal }, o));
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(label + '：请求超时（' + Math.round(timeout / 1000) + ' 秒）');
      throw new Error(label + '：网络请求失败，可能是跨域限制、证书或地址不可达（' + (e && e.message ? e.message : e) + '）');
    } finally {
      clearTimeout(timer);
    }
  }

  async function textOf(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  function httpError(res, text, label) {
    let msg = 'HTTP ' + res.status;
    if (res.status === 401) msg += '（凭据无效或没有权限）';
    else if (res.status === 403) msg += '（被拒绝，检查 Token 权限 / 仓库范围）';
    else if (res.status === 404) msg += '（地址或资源不存在）';
    else if (res.status === 413) msg += '（云端拒绝：备份太大）';
    else if (res.status === 422) msg += '（参数被拒绝，检查文件名或接口格式）';
    const body = String(text || '').replace(/\s+/g, ' ').slice(0, 180);
    return new Error(label + ' 返回 ' + msg + (body ? '：' + body : ''));
  }

  async function jsonOf(res, label) {
    const text = await textOf(res);
    try { return JSON.parse(text); }
    catch (e) { throw httpError(res, text, label); }
  }

  function parseSnapshot(text, label) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new Error(label + '不是合法 JSON：' + e.message); }
    if (!data || data.app !== 'xiaohe' || !data.files || !Array.isArray(data.files.files)) {
      throw new Error(label + '不是小匣备份（缺少 files 数组）');
    }
    return data;
  }

  /* ============================ 后端 ============================ */
  function webdavProvider() {
    const url = s('cloudUrl').trim();
    if (!url) throw new Error('请先填写 WebDAV 文件地址');
    const user = s('cloudUser');
    const pass = s('cloudPass');
    const baseHeaders = {};
    if (user || pass) baseHeaders.Authorization = basicAuth(user, pass);

    return {
      id: 'webdav',
      label: 'WebDAV',
      async get() {
        const res = await request(url, { method: 'GET', headers: baseHeaders }, 'WebDAV 读取');
        if (res.status === 404) return null;
        if (!res.ok) throw httpError(res, await textOf(res), 'WebDAV 读取');
        return parseSnapshot(await textOf(res), 'WebDAV 备份');
      },
      async put(data) {
        const body = JSON.stringify(data, null, 2);
        const res = await request(url, {
          method: 'PUT',
          headers: Object.assign({}, baseHeaders, { 'Content-Type': 'application/json; charset=utf-8' }),
          body,
          timeout: 120000
        }, 'WebDAV 上传');
        if (!res.ok) throw httpError(res, await textOf(res), 'WebDAV 上传');
        return {};
      },
      async test() {
        const res = await request(url, { method: 'GET', headers: baseHeaders }, 'WebDAV 测试');
        if (res.status === 404) return '连接正常，云端还没有备份（首次上传会创建）';
        if (!res.ok) throw httpError(res, await textOf(res), 'WebDAV 测试');
        parseSnapshot(await textOf(res), 'WebDAV 备份');
        return '连接正常，云端已有备份';
      }
    };
  }

  function gistProvider() {
    const token = s('cloudToken').trim();
    if (!token) throw new Error('请先填写 GitHub Token');
    const file = fileName();
    const api = 'https://api.github.com';
    const headers = {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };

    async function readGist(id) {
      const res = await request(api + '/gists/' + encodeURIComponent(id), { headers }, 'Gist 读取');
      if (res.status === 404) {
        cfg.set('cloudGistId', '');
        return null;
      }
      if (!res.ok) throw httpError(res, await textOf(res), 'Gist 读取');
      const j = await jsonOf(res, 'Gist 读取');
      const f = j.files && (j.files[file] || Object.values(j.files)[0]);
      if (!f) throw new Error('Gist 里没有备份文件');
      let content = f.content;
      if (!content || f.truncated) {
        const raw = await request(f.raw_url, { headers }, 'Gist 原文');
        if (!raw.ok) throw httpError(raw, await textOf(raw), 'Gist 原文');
        content = await textOf(raw);
      }
      return parseSnapshot(content, 'Gist 备份');
    }

    async function writeGist(id, data) {
      const content = JSON.stringify(data, null, 2);
      const payload = {
        description: '小匣 v2 云端备份',
        files: { [file]: { content } }
      };
      let res;
      if (id) {
        res = await request(api + '/gists/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
          timeout: 120000
        }, 'Gist 更新');
        if (res.status === 404) {
          cfg.set('cloudGistId', '');
          id = '';
        }
      }
      if (!id) {
        res = await request(api + '/gists', {
          method: 'POST',
          headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
          body: JSON.stringify(Object.assign({ public: false }, payload)),
          timeout: 120000
        }, 'Gist 创建');
      }
      if (!res.ok) throw httpError(res, await textOf(res), 'Gist 写入');
      const j = await jsonOf(res, 'Gist 写入');
      if (j.id && j.id !== id) cfg.set('cloudGistId', j.id);
      return { gistId: j.id || id };
    }

    return {
      id: 'gist',
      label: 'GitHub Gist',
      async get() {
        const id = s('cloudGistId').trim();
        return id ? readGist(id) : null;
      },
      async put(data) {
        return writeGist(s('cloudGistId').trim(), data);
      },
      async test() {
        const id = s('cloudGistId').trim();
        if (id) {
          const data = await readGist(id);
          return data ? '连接正常，云端已有备份' : '令牌有效，原 Gist 不存在，上传时会重新创建';
        }
        const res = await request(api + '/user', { headers }, 'GitHub 测试');
        if (!res.ok) throw httpError(res, await textOf(res), 'GitHub 测试');
        const j = await jsonOf(res, 'GitHub 测试');
        return '令牌有效（' + (j.login || 'GitHub 用户') + '），上传时会自动创建 Gist';
      }
    };
  }

  function giteeProvider() {
    const token = s('cloudToken').trim();
    if (!token) throw new Error('请先填写 Gitee Token');
    const file = fileName();
    const api = 'https://gitee.com/api/v5';

    async function readGist(id) {
      const url = api + '/gists/' + encodeURIComponent(id) + '?access_token=' + encodeURIComponent(token);
      const res = await request(url, { method: 'GET' }, 'Gitee 读取');
      if (res.status === 404) {
        cfg.set('cloudGistId', '');
        return null;
      }
      if (!res.ok) throw httpError(res, await textOf(res), 'Gitee 读取');
      const j = await jsonOf(res, 'Gitee 读取');
      const f = j.files && (j.files[file] || Object.values(j.files)[0]);
      if (!f) throw new Error('Gitee 代码片段里没有备份文件');
      let content = f.content;
      if (!content || f.truncated) {
        const raw = await request(f.raw_url, { method: 'GET' }, 'Gitee 原文');
        if (!raw.ok) throw httpError(raw, await textOf(raw), 'Gitee 原文');
        content = await textOf(raw);
      }
      return parseSnapshot(content, 'Gitee 备份');
    }

    async function writeGist(id, data) {
      const content = JSON.stringify(data, null, 2);
      const form = new URLSearchParams();
      form.set('access_token', token);
      form.set('description', '小匣 v2 云端备份');
      form.set('files[' + file + '][content]', content);
      let res;
      if (id) {
        res = await request(api + '/gists/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          timeout: 120000
        }, 'Gitee 更新');
        if (res.status === 404) {
          cfg.set('cloudGistId', '');
          id = '';
        }
      }
      if (!id) {
        res = await request(api + '/gists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          timeout: 120000
        }, 'Gitee 创建');
      }
      if (!res.ok) throw httpError(res, await textOf(res), 'Gitee 写入');
      const j = await jsonOf(res, 'Gitee 写入');
      if (j.id && j.id !== id) cfg.set('cloudGistId', j.id);
      return { gistId: j.id || id };
    }

    return {
      id: 'gitee',
      label: 'Gitee',
      async get() {
        const id = s('cloudGistId').trim();
        return id ? readGist(id) : null;
      },
      async put(data) {
        return writeGist(s('cloudGistId').trim(), data);
      },
      async test() {
        const id = s('cloudGistId').trim();
        if (id) {
          const data = await readGist(id);
          return data ? '连接正常，云端已有备份' : '令牌有效，原代码片段不存在，上传时会重新创建';
        }
        const res = await request(api + '/user?access_token=' + encodeURIComponent(token), { method: 'GET' }, 'Gitee 测试');
        if (!res.ok) throw httpError(res, await textOf(res), 'Gitee 测试');
        const j = await jsonOf(res, 'Gitee 测试');
        return '令牌有效（' + (j.login || j.name || 'Gitee 用户') + '），上传时会自动创建代码片段';
      }
    };
  }

  function customProvider() {
    const url = s('cloudUrl').trim();
    if (!url) throw new Error('请先填写自定义备份接口 URL');
    const token = s('cloudToken').trim();
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    return {
      id: 'custom',
      label: '自定义备份',
      async get() {
        const res = await request(url, { method: 'GET', headers }, '备份读取');
        if (res.status === 404) return null;
        if (!res.ok) throw httpError(res, await textOf(res), '备份读取');
        return parseSnapshot(await textOf(res), '云端备份');
      },
      async put(data) {
        const body = JSON.stringify(data, null, 2);
        const res = await request(url, {
          method: 'PUT',
          headers: Object.assign({}, headers, { 'Content-Type': 'application/json; charset=utf-8' }),
          body,
          timeout: 120000
        }, '备份上传');
        if (!res.ok) throw httpError(res, await textOf(res), '备份上传');
        return {};
      },
      async test() {
        const res = await request(url, { method: 'GET', headers }, '备份测试');
        if (res.status === 404) return '连接正常，云端还没有备份（首次上传会创建）';
        if (!res.ok) throw httpError(res, await textOf(res), '备份测试');
        parseSnapshot(await textOf(res), '云端备份');
        return '连接正常，云端已有备份';
      }
    };
  }

  function provider() {
    const b = backend();
    if (b === 'gist') return gistProvider();
    if (b === 'gitee') return giteeProvider();
    if (b === 'custom') return customProvider();
    return webdavProvider();
  }
  C.provider = provider;

  /* ============================ 快照 ============================ */
  function safeConfig() {
    const copy = JSON.parse(JSON.stringify(cfg.data));
    // 云端凭据本身不要写进云端快照，避免一个云端文件里再放它自己的钥匙
    delete copy.cloudToken;
    delete copy.cloudPass;
    delete copy.cloudUser;
    delete copy.cloudGistId;
    delete copy.cloudLastAt;
    return copy;
  }

  C.snapshot = async function () {
    if (AH.chat.isRunning && AH.chat.isRunning()) throw new Error('当前对话正在生成，先停止或等完成再同步');
    const files = await AH.vfs.exportFiles();
    const sessions = [];
    if (cfg.get('cloudIncludeSessions') !== false) {
      for (const meta of AH.chat.sessions) {
        let conv = AH.chat.snapshotConv ? AH.chat.snapshotConv(meta.id) : null;
        if (!conv) conv = await AH.chat.loadConv(meta.id);
        sessions.push({ meta: JSON.parse(JSON.stringify(meta)), conv: conv || [] });
      }
    }
    if (!AH.todos.loaded && AH.todos.load) await AH.todos.load();
    const data = {
      app: 'xiaohe',
      version: 2,
      exportedAt: Date.now(),
      files,
      memory: await AH.memory.load(),
      todos: (AH.todos.items || []).slice()
    };
    if (cfg.get('cloudIncludeSessions') !== false) data.sessions = sessions;
    if (cfg.get('cloudIncludeConfig')) data.config = safeConfig();
    return data;
  };

  /* ============================ 合并 ============================ */
  function newer(a, b) { return (Number(a) || 0) > (Number(b) || 0); }

  function mergeFiles(local, remote) {
    const dirs = new Set([].concat((local && local.dirs) || [], (remote && remote.dirs) || []));
    const files = new Map();
    for (const f of (local && local.files) || []) {
      if (f && f.path) files.set(f.path, Object.assign({}, f));
    }
    for (const f of (remote && remote.files) || []) {
      if (!f || !f.path) continue;
      const old = files.get(f.path);
      if (!old || newer(f.mtime, old.mtime)) files.set(f.path, Object.assign({}, f));
    }
    return { dirs: [...dirs], files: [...files.values()] };
  }

  function mergeSessions(local, remote) {
    if (!Array.isArray(local) && !Array.isArray(remote)) return undefined;
    const list = new Map();
    for (const item of (local || [])) {
      if (item && item.meta && item.meta.id) list.set(item.meta.id, item);
    }
    for (const item of (remote || [])) {
      if (!item || !item.meta || !item.meta.id) continue;
      const old = list.get(item.meta.id);
      if (!old || newer(item.meta.updatedAt, old.meta.updatedAt)) list.set(item.meta.id, item);
    }
    return [...list.values()].sort((a, b) => (b.meta.updatedAt || 0) - (a.meta.updatedAt || 0));
  }

  function mergeMemory(local, remote) {
    const list = new Map();
    for (const item of (local || [])) {
      if (!item || !item.text) continue;
      list.set(item.text, item);
    }
    for (const item of (remote || [])) {
      if (!item || !item.text) continue;
      const old = list.get(item.text);
      if (!old || newer(item.at, old.at)) list.set(item.text, item);
      else if (old && !newer(item.at, old.at) && item.tags && item.tags.length) {
        old.tags = Array.from(new Set([].concat(old.tags || [], item.tags || [])));
      }
    }
    return [...list.values()].sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 120);
  }

  function mergeTodos(local, remote) {
    const list = new Map();
    for (const item of (local || [])) {
      if (!item || !item.id) continue;
      list.set(item.id, Object.assign({}, item));
    }
    for (const item of (remote || [])) {
      if (!item || !item.id) continue;
      const old = list.get(item.id);
      if (!old || newer(item.at, old.at)) list.set(item.id, Object.assign({}, item));
      else if (old && item.done) old.done = true; // 已完成的待办不因时间戳旧而回退
    }
    return [...list.values()];
  }

  C.merge = function (local, remote) {
    if (!local || !remote) return local || remote;
    const data = {
      app: 'xiaohe',
      version: 2,
      exportedAt: Math.max(local.exportedAt || 0, remote.exportedAt || 0, Date.now()),
      files: mergeFiles(local.files, remote.files),
      memory: mergeMemory(local.memory, remote.memory),
      todos: mergeTodos(local.todos, remote.todos)
    };
    const sessions = mergeSessions(local.sessions, remote.sessions);
    if (sessions !== undefined) data.sessions = sessions;
    const config = local.config || remote.config;
    if (config) data.config = config;
    return data;
  };

  /* ============================ 应用 ============================ */
  C.apply = async function (data, opts) {
    const o = Object.assign({ replace: false, restoreConfig: false, reload: true }, opts || {});
    if (!data || data.app !== 'xiaohe' || !data.files || !Array.isArray(data.files.files)) {
      throw new Error('云端备份格式不正确');
    }
    if (AH.chat.isRunning && AH.chat.isRunning()) throw new Error('当前对话正在生成，先停止再恢复');

    await AH.vfs.importFiles(data.files, { replace: true });
    if (cfg.get('cloudIncludeSessions') !== false && Array.isArray(data.sessions)) {
      const old = AH.chat.sessions.slice();
      const ids = new Set(data.sessions.map((x) => x && x.meta && x.meta.id).filter(Boolean));
      if (o.replace) {
        for (const meta of old) if (!ids.has(meta.id)) await AH.db.del('kv', 'conv:' + meta.id);
      }
      const index = [];
      for (const item of data.sessions) {
        if (!item || !item.meta || !item.meta.id) continue;
        index.push(item.meta);
        await AH.db.put('kv', { k: 'conv:' + item.meta.id, v: item.conv || [] });
      }
      AH.chat.sessions = index;
      await AH.db.put('kv', { k: 'session_index', v: index });
    }
    if (Array.isArray(data.memory)) await AH.db.put('kv', { k: 'memory', v: data.memory });
    if (Array.isArray(data.todos)) await AH.db.put('kv', { k: 'todos', v: data.todos });
    AH.memory.items = null;
    AH.todos.loaded = false;

    if (o.restoreConfig && data.config) {
      const oldCloud = {
        cloudBackend: cfg.get('cloudBackend'),
        cloudUrl: cfg.get('cloudUrl'),
        cloudUser: cfg.get('cloudUser'),
        cloudPass: cfg.get('cloudPass'),
        cloudToken: cfg.get('cloudToken'),
        cloudGistId: cfg.get('cloudGistId'),
        cloudFile: cfg.get('cloudFile'),
        cloudIncludeSessions: cfg.get('cloudIncludeSessions'),
        cloudIncludeConfig: cfg.get('cloudIncludeConfig'),
        cloudLastAt: cfg.get('cloudLastAt')
      };
      cfg.data = Object.assign({}, cfg.defaults, data.config, oldCloud);
      cfg.save();
    }
    if (o.reload) setTimeout(() => location.reload(), 900);
  };

  /* ============================ 状态与 UI ============================ */
  C.status = function () {
    const el = $('cloudStatus');
    if (!el) return;
    const st = AH.vfs.stats ? AH.vfs.stats() : { files: 0, chars: 0 };
    const last = Number(cfg.get('cloudLastAt')) || 0;
    el.textContent = '本机 ' + st.files + ' 个文件 / ' + U.fmtChars(st.chars) +
      ' · 上次同步 ' + (last ? U.fmtTime(last) : '从未') +
      ' · 凭据只存本机';
  };

  function syncFields() {
    const b = backend();
    document.querySelectorAll('[data-cloud-for]').forEach((el) => {
      const list = String(el.dataset.cloudFor || '').split(/\s+/).filter(Boolean);
      el.hidden = list.indexOf(b) === -1;
    });
    const urlLabel = $('cloudUrlLabel');
    if (urlLabel) urlLabel.textContent = b === 'custom' ? '备份接口 URL' : 'WebDAV 文件 URL';
    const tokenLabel = $('cloudTokenLabel');
    if (tokenLabel) tokenLabel.textContent = b === 'gitee' ? 'Gitee Token' : (b === 'gist' ? 'GitHub Token' : 'Bearer Token（可选）');
    const fileLabel = $('cloudFileLabel');
    if (fileLabel) fileLabel.textContent = b === 'gitee' ? '代码片段文件名' : 'Gist 文件名';
    C.status();
  }

  C.fillForm = function () {
    if (!$('cfgCloudBackend')) return;
    $('cfgCloudBackend').value = backend();
    $('cfgCloudUrl').value = s('cloudUrl');
    $('cfgCloudUser').value = s('cloudUser');
    $('cfgCloudPass').value = s('cloudPass');
    $('cfgCloudToken').value = s('cloudToken');
    $('cfgCloudGistId').value = s('cloudGistId');
    $('cfgCloudFile').value = fileName();
    $('cfgCloudIncludeSessions').checked = cfg.get('cloudIncludeSessions') !== false;
    $('cfgCloudIncludeConfig').checked = !!cfg.get('cloudIncludeConfig');
    syncFields();
  };

  function setBusy(v) {
    busy = v;
    ['btnCloudTest', 'btnCloudUpload', 'btnCloudDownload', 'btnCloudSync'].forEach((id) => {
      const b = $(id);
      if (b) b.disabled = v;
    });
  }

  function ensureIdle() {
    if (busy) { AH.ui.toast('云端操作正在进行，稍等', 'warn', 1800); return false; }
    if (AH.chat.isRunning && AH.chat.isRunning()) { AH.ui.toast('当前对话正在生成，先停止再同步', 'warn', 2200); return false; }
    return true;
  }

  async function run(label, task) {
    if (!ensureIdle()) return;
    setBusy(true);
    AH.ui.toast(label + '…', 'ok', 1400);
    try { await task(); }
    catch (e) { AH.ui.error(label + '失败：' + e.message); }
    finally { setBusy(false); C.status(); }
  }

  function confirmBox(title, text, okText, danger) {
    return AH.ui.confirm({ title, text, okText: okText, danger: !!danger });
  }

  C.test = function () {
    return run('测试连接', async () => {
      const p = provider();
      const msg = await p.test();
      AH.ui.toast(msg, 'ok', 3000);
    });
  };

  C.upload = function () {
    return run('上传到云端', async () => {
      const ok = await confirmBox('上传到云端', '将用本机的文件、对话、记忆和待办覆盖云端备份。另一台设备上的较新改动可能被覆盖；跨设备建议用「双向同步」。', '上传');
      if (!ok) return;
      const p = provider();
      const data = await C.snapshot();
      await p.put(data);
      cfg.set('cloudLastAt', Date.now());
      AH.ui.toast('已上传云端（' + U.fmtChars(JSON.stringify(data).length) + '）', 'ok', 3000);
    });
  };

  C.download = function () {
    return run('从云端恢复', async () => {
      const p = provider();
      const data = await p.get();
      if (!data) { AH.ui.toast('云端还没有备份，先上传一次', 'warn', 3000); return; }
      const ok = await confirmBox('从云端恢复', '将用云端备份覆盖本机的文件、对话、记忆和待办' +
        (data.config ? '与设置' : '') + '。本机未上传的改动会丢失，建议先导出备份。', '覆盖本机', true);
      if (!ok) return;
      await C.apply(data, { replace: true, restoreConfig: !!data.config, reload: false });
      cfg.set('cloudLastAt', Date.now());
      AH.ui.toast('已从云端恢复，正在刷新…', 'ok', 2200);
      setTimeout(() => location.reload(), 900);
    });
  };

  C.sync = function () {
    return run('双向同步', async () => {
      const p = provider();
      const remote = await p.get();
      if (!remote) {
        const ok = await confirmBox('云端还没有备份', '将把本机数据作为第一份快照上传到云端。', '上传');
        if (!ok) return;
        const data = await C.snapshot();
        await p.put(data);
        cfg.set('cloudLastAt', Date.now());
        AH.ui.toast('已创建云端备份', 'ok', 3000);
        return;
      }
      const local = await C.snapshot();
      const merged = C.merge(local, remote);
      const ok = await confirmBox('双向同步', '将按文件修改时间和对话更新时间合并：较新的版本优先，云端独有的文件会保留，本机独有的文件不会删除。合并结果会写回两端，完成后刷新页面。', '同步');
      if (!ok) return;
      await C.apply(merged, { replace: true, restoreConfig: false, reload: false });
      await p.put(merged);
      cfg.set('cloudLastAt', Date.now());
      AH.ui.toast('双向同步完成，正在刷新…', 'ok', 2200);
      setTimeout(() => location.reload(), 900);
    });
  };

  C.init = function () {
    const pane = document.querySelector('[data-pane="cloud"]');
    if (!pane) return;
    C.fillForm();

    const bindText = (id, key, trim) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        let v = el.value;
        if (trim) v = v.trim();
        cfg.set(key, v);
        if (key === 'cloudGistId') C.status();
      });
    };
    bindText('cfgCloudUrl', 'cloudUrl', true);
    bindText('cfgCloudUser', 'cloudUser', true);
    bindText('cfgCloudPass', 'cloudPass', false);
    bindText('cfgCloudToken', 'cloudToken', true);
    bindText('cfgCloudGistId', 'cloudGistId', true);
    bindText('cfgCloudFile', 'cloudFile', true);

    const backendEl = $('cfgCloudBackend');
    if (backendEl) backendEl.addEventListener('change', () => {
      cfg.set('cloudBackend', backendEl.value);
      syncFields();
    });
    const sessionsEl = $('cfgCloudIncludeSessions');
    if (sessionsEl) sessionsEl.addEventListener('change', () => cfg.set('cloudIncludeSessions', sessionsEl.checked));
    const configEl = $('cfgCloudIncludeConfig');
    if (configEl) configEl.addEventListener('change', () => cfg.set('cloudIncludeConfig', configEl.checked));

    const map = {
      btnCloudTest: C.test,
      btnCloudUpload: C.upload,
      btnCloudDownload: C.download,
      btnCloudSync: C.sync
    };
    Object.keys(map).forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('click', (e) => { e.preventDefault(); map[id](); });
    });
    syncFields();
  };

  C.isBusy = () => busy;
})();
