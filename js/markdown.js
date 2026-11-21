/* ============================================================
   markdown.js · 无依赖 Markdown 渲染
   安全策略：先整体转义 HTML，再只生成白名单标签；
   链接只允许 http/https/mailto/#//，图片只允许 http/https/data:image。
   性能策略：流式阶段即按 Markdown 渲染，用自适应间隔节流（60ms 起放宽到 260ms）。
   ============================================================ */
(function () {
  const AH = (window.AH = window.AH || {});
  const U = AH.util;

  const MD = (AH.md = {});

  const SAFE_LINK = /^(https?:|mailto:|#|\/)/i;
  const SAFE_IMG = /^(https?:|data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);base64,)/i;

  function esc(s) { return U.esc(s); }

  function safeUrl(raw, forImg) {
    const url = String(raw || '').trim().replace(/^<|>$/g, '');
    if (forImg ? SAFE_IMG.test(url) : SAFE_LINK.test(url)) return url;
    return '';
  }

  function mathHtml(tex, display) {
    const cls = display ? 'math-display' : 'math-inline';
    return '<span class="' + cls + '" data-tex="' + U.escAttr(tex) + '">' + esc(tex) + '</span>';
  }

  function codeBlock(lang, body) {
    const l = esc((lang || '').trim().split(/\s+/)[0]);
    return '<div class="codeblock"><div class="codeblock-head"><span class="lang">' + (l || 'text') +
      '</span><button type="button" class="copy">复制</button></div><pre><code>' +
      esc(body.replace(/\n$/, '')) + '</code></pre></div>';
  }

  /* ---------- 行内 ---------- */
  function inline(text) {
    let s = esc(text || '');
    const codes = [];
    // 行内代码优先，整体替换成占位符，避免内部内容被继续解析
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (m, ticks, body) => {
      const idx = codes.length;
      codes.push(body.replace(/^\s+|\s+$/g, ''));
      return '\u0000C' + idx + '\u0000';
    });
    // 数学：先抽成占位符，避免 TeX 里的 * _ \ 被后续强调规则改写
    const maths = [];
    s = s.replace(/\$\$([^$]+?)\$\$/g, (m, tex) => {
      const idx = maths.length;
      maths.push({ tex: tex.trim(), display: true });
      return '\u0000M' + idx + '\u0000';
    });
    s = s.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
      const idx = maths.length;
      maths.push({ tex: tex.trim(), display: false });
      return '\u0000M' + idx + '\u0000';
    });
    // 图片 ![alt](url)
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, alt, url, title) => {
      const u = safeUrl(url, true);
      if (!u) return esc(m);
      return '<img src="' + U.escAttr(u) + '" alt="' + U.escAttr(alt) + '"' + (title ? ' title="' + U.escAttr(title) + '"' : '') + ' loading="lazy">';
    });
    // 链接 [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (m, label, url, title) => {
      const u = safeUrl(url, false);
      if (!u) return esc(m);
      return '<a href="' + U.escAttr(u) + '" target="_blank" rel="noopener noreferrer"' + (title ? ' title="' + U.escAttr(title) + '"' : '') + '>' + label + '</a>';
    });
    // 裸链接
    s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (m, pre, url) =>
      pre + '<a href="' + U.escAttr(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a>');
    // 强调
    s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])__([^_\n]+)__(?!_)/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
    // 还原行内代码与数学
    s = s.replace(/\u0000C(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[Number(i)] || '') + '</code>');
    s = s.replace(/\u0000M(\d+)\u0000/g, (m, i) => mathHtml(maths[Number(i)].tex, maths[Number(i)].display));
    return s;
  }

  /* ---------- 表格 ---------- */
  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  }
  function isDelimiter(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  }
  function tableHtml(rows) {
    const head = splitRow(rows[0]);
    const aligns = splitRow(rows[1]).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    let h = '<table><thead><tr>';
    head.forEach((c, i) => { h += '<th' + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '') + '>' + inline(c) + '</th>'; });
    h += '</tr></thead><tbody>';
    for (let i = 2; i < rows.length; i++) {
      const cells = splitRow(rows[i]);
      h += '<tr>';
      for (let j = 0; j < head.length; j++) {
        h += '<td' + (aligns[j] ? ' style="text-align:' + aligns[j] + '"' : '') + '>' + inline(cells[j] || '') + '</td>';
      }
      h += '</tr>';
    }
    return h + '</tbody></table>';
  }

  /* ---------- 列表 ---------- */
  function parseList(lines, start, baseIndent) {
    const ordered = /^\s*\d+[.)]\s+/.test(lines[start]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
      if (!m) break;
      const indent = m[1].replace(/\t/g, '  ').length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) { // 上一项的续行
        if (!items.length) break;
        items[items.length - 1].lines.push(lines[i].slice(Math.min(indent, lines[i].length)));
        i++;
        continue;
      }
      items.push({ lines: [m[3]] });
      i++;
      // 收集续行（缩进更深，或非列表的普通行）
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          // 空行后面若还是 list item，继续；否则结束
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[j])) { i = j; break; }
          i = j; break;
        }
        const m2 = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (m2 && m2[1].replace(/\t/g, '  ').length <= baseIndent) break;
        const ind = line.match(/^\s*/)[0].replace(/\t/g, '  ').length;
        if (ind > baseIndent) {
          items[items.length - 1].lines.push(line.slice(Math.min(ind, line.length)));
          i++;
        } else break;
      }
    }
    const tag = ordered ? 'ol' : 'ul';
    let html = '<' + tag + '>';
    for (const it of items) {
      // 列表项内部的嵌套列表 / 段落
      const body = blocks(it.lines, true);
      html += '<li>' + body.replace(/^<p>/, '').replace(/<\/p>$/, '') + '</li>';
    }
    return { html: html + '</' + tag + '>', next: i };
  }

  /* ---------- 块级 ---------- */
  function isBlockStart(line, prev) {
    return /^\s*(#{1,6})\s+/.test(line) ||
      /^\s*(```|~~~)/.test(line) ||
      /^\s*>\s?/.test(line) ||
      /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
      /^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line) ||
      (line.includes('|') && prev != null && isDelimiter(line));
  }

  function blocks(lines, tight) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // 块级公式：$$ ... $$（支持同一行闭合与跨行）
      if (line.trim().startsWith('$$')) {
        let body = line.trim().slice(2);
        let j = i + 1;
        let closed = false;
        if (body.endsWith('$$')) { body = body.slice(0, -2); closed = true; }
        while (!closed && j < lines.length) {
          const cur = lines[j];
          if (cur.trim().endsWith('$$')) { body += '\n' + cur.replace(/\$\$\s*$/, ''); closed = true; j++; break; }
          body += '\n' + cur; j++;
        }
        out.push(mathHtml(body.trim(), true));
        i = closed ? j : lines.length;
        continue;
      }

      const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/);
      if (fence) {
        const mark = fence[1];
        let body = [];
        i++;
        while (i < lines.length && !new RegExp('^\\s*' + mark[0] + '{' + mark.length + ',}\\s*$').test(lines[i])) {
          body.push(lines[i]); i++;
        }
        i++;
        out.push(codeBlock(fence[2], body.join('\n')));
        continue;
      }

      const h = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); i++; continue; }

      if (/^\s*(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

      if (/^\s*>\s?/.test(line)) {
        const q = [];
        while (i < lines.length && (/^\s*>\s?/.test(lines[i]) || (lines[i].trim() && q.length))) {
          q.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + blocks(q, tight) + '</blockquote>');
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && isDelimiter(lines[i + 1])) {
        const rows = [line, lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(lines[i]); i++; }
        out.push(tableHtml(rows));
        continue;
      }

      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        const res = parseList(lines, i, line.match(/^\s*/)[0].replace(/\t/g, '  ').length);
        out.push(res.html);
        i = res.next;
        continue;
      }

      // 段落：收集到空行或下一块开始
      const p = [line];
      i++;
      while (i < lines.length) {
        if (!lines[i].trim()) break;
        if (isBlockStart(lines[i], lines[i - 1])) break;
        p.push(lines[i]); i++;
      }
      const joined = p.join('\n');
      // Setext 标题
      if (p.length === 2 && /^\s*=+\s*$/.test(p[1])) { out.push('<h1>' + inline(p[0]) + '</h1>'); continue; }
      if (p.length === 2 && /^\s*-+\s*$/.test(p[1])) { out.push('<h2>' + inline(p[0]) + '</h2>'); continue; }
      out.push((tight ? '' : '<p>') + inline(joined).replace(/\n/g, '<br>') + (tight ? '' : '</p>'));
    }
    return out.join('');
  }

  MD.toHtml = function (src) {
    const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';
    return blocks(text.split('\n'), false);
  };

  MD.inline = inline;

  /** 把带 data-tex 的节点渲染成 KaTeX；KaTeX 未加载时保留 TeX 原文。 */
  MD.renderMathIn = function (root) {
    if (!root || !root.querySelectorAll) return;
    const nodes = root.querySelectorAll('[data-tex]:not([data-tex-done])');
    if (!nodes.length) return;
    if (!window.katex || !window.katex.render) return;
    for (const node of nodes) {
      node.dataset.texDone = '1';
      try {
        window.katex.render(node.getAttribute('data-tex') || '', node, {
          displayMode: node.classList.contains('math-display'),
          throwOnError: false,
          strict: false
        });
      } catch (e) { /* 单条公式失败保留原文 */ }
    }
  };

  /** 字数统计（不含代码块与标记） */
  MD.plainLength = function (src) {
    return String(src || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/[#>*_`~\-|]/g, '').length;
  };
})();
