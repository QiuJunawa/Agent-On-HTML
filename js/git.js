/* ============================================================
   git.js · GitHub / Gitee / GitLab 仓库读写
   配置来自「设置 → Git 仓库」：platform / repo / token / branch。
   所有写操作都会产生真实 commit，调用前必须由上层确认。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const cfg = AH.cfg;

  const G = (AH.git = {});

  function enc(s) {
    const bytes = new TextEncoder().encode(String(s == null ? '' : s));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function dec(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function cleanPath(p) {
    return String(p || '').replace(/^\/+|\/+$/g, '');
  }
  function cfgVal(k) { return String(cfg.get(k) || '').trim(); }

  G.config = function (a) {
    const platform = String((a && a.platform) || cfgVal('gitPlatform') || 'github').toLowerCase();
    const repo = String((a && a.repo) || cfgVal('gitRepo') || '').trim();
    const token = String((a && a.token) || cfgVal('gitToken') || '').trim();
    const branch = String((a && (a.ref || a.branch)) || cfgVal('gitBranch') || '').trim();
    if (!repo || !/^[^\s/]+\/[^\s/]+$/.test(repo)) throw new Error('Git 仓库未配置：请到「设置 → Git 仓库」填写 owner/name');
    if (!token) throw new Error('Git 访问令牌未配置：请到「设置 → Git 仓库」填写 Token');
    return { platform, repo, token, branch };
  };

  async function req(url, opts) {
    const o = opts || {};
    const headers = Object.assign({}, o.headers || {});
    let resp;
    try {
      resp = await fetch(url, { method: o.method || 'GET', headers, body: o.body, signal: o.signal });
    } catch (e) {
      throw new Error('Git 请求失败（网络/CORS）：' + (e && e.message ? e.message : e));
    }
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!resp.ok) {
      const msg = (data && (data.message || data.error || data.error_description)) || text.slice(0, 200) || ('HTTP ' + resp.status);
      throw new Error('Git ' + resp.status + '：' + msg);
    }
    return { data, text, status: resp.status, headers: resp.headers };
  }

  function ghHeaders(t) {
    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + t,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  function glHeaders(t) { return { 'PRIVATE-TOKEN': t }; }
  function giteeUrl(path, token, extra) {
    const q = new URLSearchParams(Object.assign({ access_token: token }, extra || {}));
    return 'https://gitee.com/api/v5' + path + '?' + q.toString();
  }

  /* ---------- 默认分支 ---------- */
  async function defaultBranch(c) {
    if (c.branch) return c.branch;
    if (c.platform === 'github') {
      const r = await req('https://api.github.com/repos/' + c.repo, { headers: ghHeaders(c.token) });
      const d = asObj(r);
      c.branch = (d && d.default_branch) || 'main';
    } else if (c.platform === 'gitlab') {
      const r = await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo), { headers: glHeaders(c.token) });
      const d = asObj(r);
      c.branch = (d && d.default_branch) || 'main';
    } else {
      const r = await req(giteeUrl('/repos/' + c.repo, c.token));
      const d = asObj(r);
      c.branch = (d && d.default_branch) || 'master';
    }
    return c.branch;
  }

  /* 把 contents 接口结果归一成数组；空响应/非 JSON 不再产生 [null] 元素 */
  function asArr(r, what) {
    if (Array.isArray(r.data)) return r.data;
    const d = asObj(r);
    if (!d) {
      if (r && r.text) throw new Error('Git 响应异常：' + what + ' 返回了非 JSON 内容（HTTP ' + ((r && r.status) || 200) + '）：' + String(r.text).slice(0, 120));
      return [];
    }
    return [d];
  }

  /* ---------- 列目录 ---------- */
  G.list = async function (a, ctx) {
    const c = G.config(a);
    const ref = a.ref || await defaultBranch(c);
    const path = cleanPath(a.path);
    if (c.platform === 'github') {
      const r = await req('https://api.github.com/repos/' + c.repo + '/contents' + (path ? '/' + path : '') + '?ref=' + encodeURIComponent(ref), { headers: ghHeaders(c.token) });
      const arr = asArr(r, '列目录 ' + (path || '/'));
      return arr.map((x) => (x.type === 'dir' ? '[目录] ' : '[文件] ') + x.path + (x.size ? '  ' + x.size + ' B' : '')).join('\n') || '目录为空';
    }
    if (c.platform === 'gitlab') {
      const r = await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo) + '/repository/tree?path=' + encodeURIComponent(path) + '&ref=' + encodeURIComponent(ref) + '&per_page=100', { headers: glHeaders(c.token) });
      const arr = Array.isArray(r.data) ? r.data : [];
      return arr.map((x) => (x.type === 'tree' ? '[目录] ' : '[文件] ') + x.path).join('\n') || '目录为空';
    }
    const r = await req(giteeUrl('/repos/' + c.repo + '/contents' + (path ? '/' + path : ''), c.token, { ref }));
    const arr = asArr(r, '列目录 ' + (path || '/'));
    return arr.map((x) => (x.type === 'dir' ? '[目录] ' : '[文件] ') + x.path + (x.size ? '  ' + x.size + ' B' : '')).join('\n') || '目录为空';
  };

  /* ---------- 读文件 ---------- */
  G.read = async function (a, ctx) {
    const c = G.config(a);
    const ref = a.ref || await defaultBranch(c);
    const path = cleanPath(a.path);
    if (!path) throw new Error('path 不能为空');
    let content = '';
    if (c.platform === 'github') {
      const r = await req('https://api.github.com/repos/' + c.repo + '/contents/' + path + '?ref=' + encodeURIComponent(ref), { headers: Object.assign(ghHeaders(c.token), { 'Accept': 'application/vnd.github.raw' }) });
      content = r.text;
    } else if (c.platform === 'gitlab') {
      const r = await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo) + '/repository/files/' + encodeURIComponent(path) + '/raw?ref=' + encodeURIComponent(ref), { headers: glHeaders(c.token) });
      content = r.text;
    } else {
      const r = await req(giteeUrl('/repos/' + c.repo + '/contents' + (path ? '/' + path : ''), c.token, { ref }));
      if (Array.isArray(r.data)) throw new Error('目标路径是目录，不能按文件读取：' + path);
      content = dec(pick(r, ['content'], '读取文件内容（' + path + '）'));
    }
    const lines = content.split('\n');
    const s = Math.max(1, Number(a.start_line) || 1);
    const e = Math.min(lines.length, Number(a.end_line) || lines.length);
    return lines.slice(s - 1, e).map((l, i) => String(s + i).padStart(4) + ' | ' + l).join('\n');
  };

  /* 安全取对象：接口返回空体、HTML 或数组时不让调用方崩在 .sha 上 */
  function asObj(r) {
    const d = r && r.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    return d;
  }

  /* 按路径取必需字段；取不到就抛出带上下文和响应片段的错误，而不是 TypeError */
  function pick(r, keys, what) {
    let cur = asObj(r);
    for (const k of keys) cur = cur && cur[k];
    if (!cur) {
      throw new Error('Git 响应异常：' + what + ' 未返回 ' + keys.join('.') +
        '（HTTP ' + ((r && r.status) || 200) + '）' +
        (r && r.text ? '，响应片段：' + String(r.text).slice(0, 120) : '，响应为空'));
    }
    return cur;
  }

  /* ---------- 取文件 sha（更新/删除需要） ---------- */
  async function shaOf(c, path, ref) {
    try {
      if (c.platform === 'github') {
        const r = await req('https://api.github.com/repos/' + c.repo + '/contents' + (path ? '/' + path : '') + '?ref=' + encodeURIComponent(ref), { headers: ghHeaders(c.token) });
        // path 指向目录时 GitHub 返回数组：没有 sha，且不能当文件写
        if (Array.isArray(r.data)) throw new Error('目标路径是目录，不能按文件写入：' + path);
        if (!r.data && r.text) throw new Error('GitHub 返回了非 JSON 响应（HTTP ' + (r.status || 200) + '）：' + r.text.slice(0, 120));
        const d = asObj(r);
        return (d && d.sha) || null;
      }
      if (c.platform === 'gitlab') {
        try {
          const r = await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo) + '/repository/files/' + encodeURIComponent(path) + '?ref=' + encodeURIComponent(ref), { headers: glHeaders(c.token) });
          const d = asObj(r);
          return d && d.file_path ? 'exists' : null;
        } catch (e) {
          if (/Git 404/.test(e.message)) return null;
          throw e;
        }
      }
      const r = await req(giteeUrl('/repos/' + c.repo + '/contents' + (path ? '/' + path : ''), c.token, { ref }));
      if (Array.isArray(r.data)) throw new Error('目标路径是目录，不能按文件写入：' + path);
      const d = asObj(r);
      return (d && d.sha) || null;
    } catch (e) {
      if (/Git 404/.test(e.message)) return null;
      throw e;
    }
  }

  /* ---------- 写单个文件 ---------- */
  G.write = async function (a, ctx) {
    const c = G.config(a);
    const ref = a.ref || await defaultBranch(c);
    const path = cleanPath(a.path);
    if (!path) throw new Error('path 不能为空');
    const content = String(a.content == null ? '' : a.content);
    const message = String(a.message || ('update ' + path));
    const ok = await ctx.confirm({
      title: '写入 Git 仓库',
      text: c.platform + ' · ' + c.repo + ' · ' + path + '\n将产生一次真实 commit，无法用 undo_last 撤销。',
      rememberKey: 'git-write'
    });
    if (!ok) return '用户取消了 Git 写入：' + path;

    const sha = await shaOf(c, path, ref);
    if (c.platform === 'github') {
      const body = { message, content: enc(content), branch: ref };
      if (sha) body.sha = sha;
      const r = await req('https://api.github.com/repos/' + c.repo + '/contents/' + path, {
        method: 'PUT', headers: Object.assign(ghHeaders(c.token), { 'Content-Type': 'application/json' }), body: JSON.stringify(body)
      });
      const d = asObj(r);
      return '已提交 ' + path + ' → ' + ((d && d.commit && d.commit.sha) || 'ok（响应无 commit 字段）');
    }
    if (c.platform === 'gitlab') {
      const body = { branch: ref, content, commit_message: message };
      const r = await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo) + '/repository/files/' + encodeURIComponent(path), {
        method: sha ? 'PUT' : 'POST', headers: Object.assign(glHeaders(c.token), { 'Content-Type': 'application/json' }), body: JSON.stringify(body)
      });
      const d = asObj(r);
      return '已提交 ' + path + ' → ' + ((d && d.file_path) || 'ok');
    }
    const body = { access_token: c.token, content: enc(content), message, branch: ref };
    if (sha) body.sha = sha;
    const r = await req('https://gitee.com/api/v5/repos/' + c.repo + '/contents/' + path, {
      method: sha ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const d = asObj(r);
    return '已提交 ' + path + ' → ' + ((d && d.commit && d.commit.sha) || 'ok');
  };

  /* ---------- 删除 ---------- */
  G.remove = async function (a, ctx) {
    const c = G.config(a);
    const ref = a.ref || await defaultBranch(c);
    const path = cleanPath(a.path);
    const sha = await shaOf(c, path, ref);
    if (!sha) throw new Error('远端文件不存在：' + path);
    const ok = await ctx.confirm({
      title: '删除 Git 仓库文件',
      text: c.platform + ' · ' + c.repo + ' · ' + path + '\n删除会留下 commit 历史，无法恢复文件内容。',
      rememberKey: 'git-delete'
    });
    if (!ok) return '用户取消了 Git 删除：' + path;
    const message = String(a.message || ('delete ' + path));
    if (c.platform === 'github') {
      await req('https://api.github.com/repos/' + c.repo + '/contents/' + path, {
        method: 'DELETE', headers: Object.assign(ghHeaders(c.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message, sha, branch: ref })
      });
    } else if (c.platform === 'gitlab') {
      await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo) + '/repository/files/' + encodeURIComponent(path), {
        method: 'DELETE', headers: Object.assign(glHeaders(c.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ branch: ref, commit_message: message })
      });
    } else {
      await req('https://gitee.com/api/v5/repos/' + c.repo + '/contents/' + path, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: c.token, sha, message, branch: ref })
      });
    }
    return '已删除并提交：' + path;
  };

  /* ---------- 批量提交（GitHub 一次 commit；GitLab 一次 commit；Gitee 顺序提交） ---------- */
  G.batch = async function (a, ctx) {
    const c = G.config(a);
    const ref = a.ref || await defaultBranch(c);
    const actions = Array.isArray(a.actions) ? a.actions : [];
    if (!actions.length) throw new Error('actions 不能为空');
    const ok = await ctx.confirm({
      title: '批量提交 Git 仓库',
      text: c.platform + ' · ' + c.repo + ' · ' + actions.length + ' 个文件\n目标分支：' + ref + '\n将产生真实 commit。',
      rememberKey: 'git-batch'
    });
    if (!ok) return '用户取消了批量提交';

    const message = String(a.message || ('batch update ' + actions.length + ' files'));
    if (c.platform === 'github') {
      const head = await req('https://api.github.com/repos/' + c.repo + '/git/ref/heads/' + encodeURIComponent(ref), { headers: ghHeaders(c.token) });
      const parent = pick(head, ['object', 'sha'], '读取分支 ' + ref + ' 的头指针');
      const commit = await req('https://api.github.com/repos/' + c.repo + '/git/commits/' + parent, { headers: ghHeaders(c.token) });
      const baseTree = pick(commit, ['tree', 'sha'], '读取父提交树');
      const entries = [];
      for (const act of actions) {
        const path = cleanPath(act.path);
        if (!path) continue;
        if (String(act.action || '').toLowerCase() === 'delete') {
          entries.push({ path, mode: '100644', type: 'blob', sha: null });
          continue;
        }
        const blob = await req('https://api.github.com/repos/' + c.repo + '/git/blobs', {
          method: 'POST', headers: Object.assign(ghHeaders(c.token), { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ content: enc(String(act.content == null ? '' : act.content)), encoding: 'base64' })
        });
        entries.push({ path, mode: '100644', type: 'blob', sha: pick(blob, ['sha'], '创建 blob（' + path + '）') });
      }
      const tree = await req('https://api.github.com/repos/' + c.repo + '/git/trees', {
        method: 'POST', headers: Object.assign(ghHeaders(c.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ base_tree: baseTree, tree: entries })
      });
      const newCommit = await req('https://api.github.com/repos/' + c.repo + '/git/commits', {
        method: 'POST', headers: Object.assign(ghHeaders(c.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message, tree: pick(tree, ['sha'], '创建 tree'), parents: [parent] })
      });
      const newSha = pick(newCommit, ['sha'], '创建 commit');
      await req('https://api.github.com/repos/' + c.repo + '/git/refs/heads/' + encodeURIComponent(ref), {
        method: 'PATCH', headers: Object.assign(ghHeaders(c.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ sha: newSha })
      });
      return '已批量提交 ' + entries.length + ' 项 → ' + newSha;
    }
    if (c.platform === 'gitlab') {
      const acts = actions.map((x) => ({
        action: String(x.action || 'update').toLowerCase(),
        file_path: cleanPath(x.path),
        content: String(x.content == null ? '' : x.content)
      }));
      const r = await req('https://gitlab.com/api/v4/projects/' + encodeURIComponent(c.repo) + '/repository/commits', {
        method: 'POST', headers: Object.assign(glHeaders(c.token), { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ branch: ref, commit_message: message, actions: acts })
      });
      const d = asObj(r);
      return '已批量提交 ' + acts.length + ' 项 → ' + ((d && d.id) || 'ok');
    }
    // Gitee 没有 batch API：顺序执行，失败即停并报告已完成部分
    let done = 0;
    for (const act of actions) {
      if (String(act.action || '').toLowerCase() === 'delete') await G.remove(Object.assign({}, a, { path: act.path, message }), { confirm: async () => true });
      else await G.write(Object.assign({}, a, { path: act.path, content: act.content, message }), { confirm: async () => true });
      done++;
    }
    return 'Gitee 不支持单次批量提交，已顺序提交 ' + done + ' 项（产生 ' + done + ' 个 commit）';
  };

  G.test = async function () {
    const c = G.config({});
    await defaultBranch(c);
    return '连接成功：' + c.platform + ' · ' + c.repo;
  };
})();
