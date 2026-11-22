// ==UserScript==
// @name         Stepik Lesson & Course to Markdown (Universal)
// @namespace    http://tampermonkey.net/
// @version      4.3
// @description  Export a Stepik lesson, single module, or full course to clean Markdown for LLMs (strictly read-only GET API)
// @match        https://stepik.org/*
// @match        https://*.stepik.org/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const PILL_HOST_ID = 'st-md-header-widget';
  const MENU_HOST_ID = 'st-md-menu-portal';
  const PAGE_STYLE_ID = 'st-md-page-style';

  const INTERACTIVE_TYPES = new Set(['choice', 'matching', 'sorting', 'table', 'fill-blanks', 'parsons']);
  const JUNK_LANGS = new Set(['no-highlight', 'nohighlight', 'undefined', 'none', 'plain', 'plaintext', 'text']);
  const VOID_HTML_TAGS = new Set([
    'area', 'base', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
  ]);

  let activeExportAbort = null;
  let activeExportKind = null; // 'module' | 'course' | null
  let lastExportStatus = null; // { text, state }
  let isLessonBusy = false;
  let statusResetTimer = null;
  let syncRafPending = false;
  let lastObservedHref = window.location.href;
  let observedHeaderEl = null;
  let headerObserver = null;
  let discoveryObserver = null;
  let ui = null;

  const modulesCache = {
    courseId: null,
    courseTitle: '',
    sections: [],
    loadingCourseId: null,
    loadingPromise: null,
    lastPreselectedLessonKey: null
  };

  // --- Utilities ---

  const cleanText = (str) =>
    (str || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');

  const sanitizeFilename = (title, fallback) => {
    const safe = cleanText(title)
      .replace(/[\\/:*?"<>|\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, '');
    return safe || fallback;
  };

  const sleep = (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        },
        { once: true }
      );
    });

  const normalizeLang = (lang) => {
    if (!lang) return '';
    const l = lang.toLowerCase().trim();
    if (JUNK_LANGS.has(l)) return '';
    if (/^python/.test(l)) return 'python';
    if (/^(c\+\+|cpp)/.test(l)) return 'cpp';
    if (/^(c#|csharp)/.test(l)) return 'csharp';
    if (/^(sh|shell|bash|zsh)/.test(l)) return 'bash';
    if (/^(js|javascript|node)/.test(l)) return 'javascript';
    if (/^(ts|typescript)/.test(l)) return 'typescript';
    if (/^(postgres|mysql|sqlite|sql)/.test(l)) return 'sql';
    if (/^java\b/.test(l)) return 'java';
    if (/^kotlin/.test(l)) return 'kotlin';
    if (/^rust/.test(l)) return 'rust';
    if (/^go/.test(l)) return 'go';
    return l.replace(/[\d.]+$/, '') || l;
  };

  function makeFence(code, lang = '') {
    const runs = code.match(/`{3,}/g);
    const len = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 3;
    const fence = '`'.repeat(len);
    return `${fence}${lang}\n${code}\n${fence}`;
  }

  function wrapInlineCode(text) {
    const runs = text.match(/`+/g);
    const len = runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1;
    const ticks = '`'.repeat(len);
    const pad = len > 1 || text.startsWith('`') || text.endsWith('`') ? ' ' : '';
    return `${ticks}${pad}${text}${pad}${ticks}`;
  }

  function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec) || sec <= 0) return '';
    const total = Math.floor(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function normalizeBlankLines(md) {
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let inFence = false;
    let fenceChar = '';
    let fenceLen = 0;
    let blankRun = 0;

    for (const line of lines) {
      if (!inFence) {
        const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
        if (m) {
          inFence = true;
          fenceChar = m[1][0];
          fenceLen = m[1].length;
          blankRun = 0;
          out.push(line);
          continue;
        }
        if (line.trim() === '') {
          blankRun++;
          if (blankRun <= 1) out.push('');
        } else {
          blankRun = 0;
          out.push(line);
        }
      } else {
        out.push(line);
        const closeRe = new RegExp(`^[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*$`);
        if (closeRe.test(line)) {
          inFence = false;
        }
      }
    }
    return out.join('\n').trim();
  }

  async function copyToClipboard(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text, 'text');
      return;
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fallback below if clipboard API rejects without focus
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('Clipboard write failed');
  }

  function triggerDownload(md, filename) {
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // --- HTML to Markdown Converter ---

  function serializePreNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'pre' || tag === 'code') {
      return Array.from(node.childNodes).map(serializePreNode).join('');
    }
    if (tag === 'span' && /\b(hljs|token|cm-|ace_|line-number)/.test(node.className || '')) {
      return Array.from(node.childNodes).map(serializePreNode).join('');
    }
    const attrs = Array.from(node.attributes)
      .map((a) => ` ${a.name}="${a.value}"`)
      .join('');
    if (VOID_HTML_TAGS.has(tag)) return `<${tag}${attrs}>`;
    const inner = Array.from(node.childNodes).map(serializePreNode).join('');
    return `<${tag}${attrs}>${inner}</${tag}>`;
  }

  function serializePreChildren(preEl) {
    return Array.from(preEl.childNodes).map(serializePreNode).join('');
  }

  function htmlToMd(html, { minHeadingLevel = 1 } = {}) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.body;

    root.querySelectorAll('.copy-code-btn, script:not([type^="math/tex"]), style, noscript').forEach((el) => el.remove());

    root.querySelectorAll('iframe').forEach((frame) => {
      const src = (frame.getAttribute('src') || '').trim();
      if (src) {
        const title = cleanText(frame.getAttribute('title') || 'Embedded media').trim();
        frame.replaceWith(`\n[${title}](${src})\n`);
      } else {
        frame.remove();
      }
    });

    // 1. Code blocks <pre> (serialize children only, preserving literal unescaped tags & blank lines)
    const codeBlocks = [];
    root.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      const cls = `${codeEl?.className || ''} ${pre.className || ''}`;
      const langMatch = cls.match(/(?:language|lang)-([a-zA-Z0-9_+#.-]+)/);
      const lang = langMatch ? normalizeLang(langMatch[1]) : '';
      const rawCode = cleanText(serializePreChildren(pre))
        .replace(/\r\n?/g, '\n')
        .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
      const token = `___CODE_BLOCK_${codeBlocks.length}___`;
      const inTable = Boolean(pre.closest('td, th'));
      codeBlocks.push({
        inline: inTable,
        content: inTable ? wrapInlineCode(rawCode.replace(/\n+/g, ' ')) : makeFence(rawCode, lang)
      });
      pre.replaceWith(inTable ? token : `\n${token}\n`);
    });

    // 2. LaTeX math
    const mathBlocks = [];
    root.querySelectorAll('.math-tex, script[type^="math/tex"]').forEach((el) => {
      const tex = cleanText(el.textContent).trim();
      if (!tex) {
        el.remove();
        return;
      }
      const inInlineOnly = Boolean(el.closest('td, th, li'));
      let formatted;
      if (tex.startsWith('\\[') && tex.endsWith('\\]')) {
        const inner = tex.slice(2, -2).trim();
        formatted = inInlineOnly ? `$${inner}$` : `\n$$\n${inner}\n$$\n`;
      } else if (tex.startsWith('\\(') && tex.endsWith('\\)')) {
        formatted = `$${tex.slice(2, -2).trim()}$`;
      } else if (tex.startsWith('$$') && tex.endsWith('$$')) {
        const inner = tex.slice(2, -2).trim();
        formatted = inInlineOnly ? `$${inner}$` : `\n$$\n${inner}\n$$\n`;
      } else if (tex.startsWith('$') && tex.endsWith('$')) {
        formatted = tex;
      } else if (el.tagName === 'SCRIPT' && (el.getAttribute('type') || '').includes('display')) {
        formatted = inInlineOnly ? `$${tex}$` : `\n$$\n${tex}\n$$\n`;
      } else {
        formatted = `$${tex}$`;
      }
      const token = `___MATH_BLOCK_${mathBlocks.length}___`;
      mathBlocks.push(formatted);
      el.replaceWith(token);
    });

    // 3. Inline code
    const inlineCodes = [];
    root.querySelectorAll('code').forEach((c) => {
      const txt = cleanText(c.textContent);
      const token = `___INLINE_CODE_${inlineCodes.length}___`;
      inlineCodes.push(txt ? wrapInlineCode(txt) : '');
      c.replaceWith(token);
    });

    // 4. Superscript / subscript
    const subSupBlocks = [];
    Array.from(root.querySelectorAll('sup, sub'))
      .reverse()
      .forEach((el) => {
        const txt = cleanText(el.textContent).trim();
        if (!txt) {
          el.remove();
          return;
        }
        const tag = el.tagName.toLowerCase();
        const token = `___SUBSUP_${subSupBlocks.length}___`;
        subSupBlocks.push(`<${tag}>${txt}</${tag}>`);
        el.replaceWith(token);
      });

    // 5. Images
    root.querySelectorAll('img').forEach((img) => {
      const src = (img.getAttribute('src') || '').trim();
      if (!src) {
        img.remove();
        return;
      }
      const alt = cleanText(img.getAttribute('alt') || img.getAttribute('title') || '').trim();
      const inTable = Boolean(img.closest('td, th'));
      img.replaceWith(inTable ? `![${alt}](${src})` : `\n![${alt}](${src})\n`);
    });

    // 6. Inline formatting (escape boundary asterisks to avoid ***.co** / *****)
    const wrapInline = (selector, marker) => {
      Array.from(root.querySelectorAll(selector))
        .reverse()
        .forEach((el) => {
          const raw = cleanText(el.textContent);
          const lead = raw.match(/^\s*/)[0];
          const trail = raw.match(/\s*$/)[0];
          let txt = raw.trim();
          if (!txt) {
            el.replaceWith(raw);
            return;
          }
          if (marker.includes('*') && (txt.startsWith('*') || txt.endsWith('*'))) {
            txt = txt.replace(/^\*+|\*+$/g, (m) => '\\*'.repeat(m.length));
          }
          el.replaceWith(`${lead}${marker}${txt}${marker}${trail}`);
        });
    };

    wrapInline('em, i', '*');
    wrapInline('strong, b', '**');
    wrapInline('del, s, strike', '~~');

    Array.from(root.querySelectorAll('a'))
      .reverse()
      .forEach((a) => {
        const href = (a.getAttribute('href') || '').trim();
        const raw = cleanText(a.textContent);
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const txt = raw.trim();
        if (!href) {
          a.replaceWith(raw);
        } else if (!txt || txt === href) {
          a.replaceWith(`${lead}${href}${trail}`);
        } else {
          a.replaceWith(`${lead}[${txt}](${href})${trail}`);
        }
      });

    // 7. Tables
    const tableBlocks = [];
    root.querySelectorAll('table').forEach((table) => {
      const rows = Array.from(table.querySelectorAll('tr'))
        .map((tr) =>
          Array.from(tr.querySelectorAll('th, td')).map((cell) => {
            cell.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
            return cleanText(cell.textContent)
              .replace(/\s*\n+\s*/g, ' ')
              .replace(/[ \t]{2,}/g, ' ')
              .replace(/\|/g, '\\|')
              .trim();
          })
        )
        .filter((r) => r.length > 0);

      if (rows.length > 0) {
        const cols = Math.max(...rows.map((r) => r.length));
        const pad = (r) => [...r, ...Array(cols - r.length).fill('')];
        const header = `| ${pad(rows[0]).join(' | ')} |`;
        const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
        const body = rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`).join('\n');
        const token = `___TABLE_BLOCK_${tableBlocks.length}___`;
        tableBlocks.push(`\n${header}\n${sep}${body ? `\n${body}` : ''}\n`);
        table.replaceWith(token);
      } else {
        table.remove();
      }
    });

    // 8. Details/summary, headings (shifted under step heading), blockquotes, hr
    root.querySelectorAll('summary').forEach((s) => {
      const txt = cleanText(s.textContent).replace(/\*\*/g, '').replace(/[ \t]{2,}/g, ' ').trim();
      s.replaceWith(txt ? `\n**${txt}**\n` : '\n');
    });

    const headingEls = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    if (headingEls.length > 0) {
      const lowestFound = Math.min(...headingEls.map((h) => Number(h.tagName.slice(1))));
      headingEls.forEach((h) => {
        const orig = Number(h.tagName.slice(1));
        const shifted = Math.min(6, Math.max(orig, minHeadingLevel + (orig - lowestFound)));
        const txt = cleanText(h.textContent).replace(/\s+/g, ' ').trim();
        h.replaceWith(txt ? `\n${'#'.repeat(shifted)} ${txt}\n` : '');
      });
    }

    root.querySelectorAll('blockquote').forEach((bq) => {
      bq.querySelectorAll('br').forEach((br) => {
        if (br.nextSibling?.nodeType === Node.TEXT_NODE) {
          br.nextSibling.nodeValue = br.nextSibling.nodeValue.replace(/^[ \t]*\r?\n/, '');
        }
        br.replaceWith('\n');
      });
      const lines = cleanText(bq.textContent)
        .replace(/\r\n?/g, '\n')
        .trim()
        .split('\n')
        .map((l) => `> ${l.replace(/[ \t]{2,}/g, ' ').trim()}`)
        .join('\n');
      bq.replaceWith(lines ? `\n${lines}\n` : '');
    });

    root.querySelectorAll('hr').forEach((hr) => hr.replaceWith('\n---\n'));

    // 9. Nested lists (document-order traversal preserving mid-item sublists, paragraphs & code blocks)
    const listBlocks = [];

    const extractInlineText = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return cleanText(node.nodeValue || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      if (node.tagName === 'BR') return '\n';
      return Array.from(node.childNodes).map(extractInlineText).join('');
    };

    const normalizeListParagraph = (raw) =>
      cleanText(raw)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean);

    const renderList = (listEl, indent = '') => {
      const isOrdered = listEl.tagName === 'OL';
      let index = Number(listEl.getAttribute('start')) || 1;
      const outLines = [];

      Array.from(listEl.children).forEach((li) => {
        if (li.tagName !== 'LI') return;
        const marker = isOrdered ? `${index++}.` : '*';
        const childIndent = indent + ' '.repeat(marker.length + 1);
        const segments = [];
        let inlineBuf = '';

        const flushInline = () => {
          const lines = normalizeListParagraph(inlineBuf);
          inlineBuf = '';
          for (const line of lines) {
            segments.push({ type: 'text', content: line });
          }
        };

        const walkLiChild = (node) => {
          if (node.nodeType === Node.TEXT_NODE) {
            inlineBuf += cleanText(node.nodeValue || '');
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName;
          if (tag === 'UL' || tag === 'OL') {
            flushInline();
            const sub = renderList(node, childIndent);
            if (sub) segments.push({ type: 'list', content: sub });
          } else if (tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE') {
            flushInline();
            if (node.querySelector('ul, ol')) {
              Array.from(node.childNodes).forEach(walkLiChild);
              flushInline();
            } else {
              inlineBuf += extractInlineText(node);
              flushInline();
            }
          } else {
            inlineBuf += extractInlineText(node);
          }
        };

        Array.from(li.childNodes).forEach(walkLiChild);
        flushInline();

        if (!segments.length) return;

        let emittedMarker = false;
        for (const seg of segments) {
          if (seg.type === 'list') {
            if (!emittedMarker) {
              outLines.push(`${indent}${marker}`);
              emittedMarker = true;
            }
            outLines.push(seg.content);
            continue;
          }

          let text = seg.content;
          if (!emittedMarker) {
            text = text.replace(/^[·•▪◦]\s*/, '');
            if (/^___CODE_BLOCK_\d+___$/.test(text)) {
              outLines.push(`${indent}${marker}`);
              outLines.push(`${childIndent}${text}`);
            } else {
              outLines.push(`${indent}${marker} ${text}`);
            }
            emittedMarker = true;
          } else {
            outLines.push(`${childIndent}${text}`);
          }
        }
      });

      return outLines.join('\n');
    };

    root.querySelectorAll('ul, ol').forEach((list) => {
      if (list.isConnected && !list.parentElement?.closest('ul, ol')) {
        const rendered = renderList(list, '');
        if (rendered) {
          const token = `___LIST_BLOCK_${listBlocks.length}___`;
          listBlocks.push(`\n${rendered}\n`);
          list.replaceWith(token);
        } else {
          list.remove();
        }
      }
    });

    // 10. Line breaks & paragraphs (strip single trailing newline after <br>)
    root.querySelectorAll('br').forEach((br) => {
      if (br.nextSibling?.nodeType === Node.TEXT_NODE) {
        br.nextSibling.nodeValue = br.nextSibling.nodeValue.replace(/^[ \t]*\r?\n/, '');
      }
      br.replaceWith('\n');
    });

    root.querySelectorAll('p').forEach((p) => {
      const txt = cleanText(p.textContent).trim();
      p.replaceWith(txt ? `\n${txt}\n` : '\n');
    });

    // 11. Prose cleanup before restoring protected blocks
    let result = cleanText(root.textContent)
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]+/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    listBlocks.forEach((b, i) => { result = result.replace(`___LIST_BLOCK_${i}___`, () => b); });
    tableBlocks.forEach((b, i) => { result = result.replace(`___TABLE_BLOCK_${i}___`, () => b); });

    // Restore code blocks with indentation awareness for lists
    codeBlocks.forEach((block, i) => {
      const token = `___CODE_BLOCK_${i}___`;
      if (block.inline) {
        result = result.replace(token, () => block.content);
        return;
      }
      const lineRe = new RegExp(`^([ \\t]*)(.*)${token}(.*)$`, 'm');
      result = result.replace(lineRe, (_, leadIndent, before, after) => {
        const listMatch = before.match(/^((?:[*+-]|\d+\.)[ \t]+)(.*)$/);
        if (listMatch) {
          const markerPart = listMatch[1];
          const textBefore = listMatch[2].trim();
          const contIndent = leadIndent + ' '.repeat(markerPart.length);
          const indentedFence = block.content
            .split('\n')
            .map((l) => (l.length ? `${contIndent}${l}` : ''))
            .join('\n');
          const tail = after.trim() ? `\n${contIndent}${after.trim()}` : '';
          if (textBefore) {
            return `${leadIndent}${markerPart}${textBefore}\n${indentedFence}${tail}`;
          }
          return `${leadIndent}${markerPart.trimEnd()}\n${indentedFence}${tail}`;
        }

        if (leadIndent && !before.trim() && !after.trim()) {
          return block.content
            .split('\n')
            .map((l) => (l.length ? `${leadIndent}${l}` : ''))
            .join('\n');
        }

        const prePart = before.trim() ? `${leadIndent}${before.trim()}\n\n` : '\n';
        const postPart = after.trim() ? `\n\n${leadIndent}${after.trim()}` : '\n';
        return `${prePart}${block.content}${postPart}`;
      });
    });

    mathBlocks.forEach((b, i) => { result = result.replace(`___MATH_BLOCK_${i}___`, () => b); });
    inlineCodes.forEach((b, i) => { result = result.replace(`___INLINE_CODE_${i}___`, () => b); });
    subSupBlocks.forEach((b, i) => { result = result.replace(`___SUBSUP_${i}___`, () => b); });

    return normalizeBlankLines(result);
  }

  // --- Read-Only Network Layer (Strictly GET, 429/5xx Backoff, Chunked ids[], Max 3 Workers) ---

  function parseRetryAfterMs(headerVal, attempt) {
    if (headerVal) {
      const secs = Number(headerVal);
      if (Number.isFinite(secs) && secs > 0) return secs * 1000;
      const dateMs = Date.parse(headerVal);
      if (Number.isFinite(dateMs)) {
        const diff = dateMs - Date.now();
        if (diff > 0) return Math.min(diff, 60000);
      }
    }
    const base = Math.min(30000, 3000 * Math.pow(2, attempt));
    return base + Math.floor(Math.random() * 500);
  }

  async function fetchJsonWithRetry(url, { signal, onRateLimit } = {}, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, { method: 'GET', credentials: 'same-origin', signal });
      if (res.status === 429) {
        if (attempt === retries) throw new Error('HTTP 429: Stepik API rate limit exceeded');
        const waitMs = parseRetryAfterMs(res.headers.get('Retry-After'), attempt);
        if (onRateLimit) onRateLimit(Math.ceil(waitMs / 1000));
        await sleep(waitMs, signal);
        continue;
      }
      if ((res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
        await sleep(1500 * (attempt + 1), signal);
        continue;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} (${url})`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
  }

  async function fetchBatchedByIds(endpoint, resourceKey, ids, opts = {}) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    const results = [];
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const chunk = uniqueIds.slice(i, i + 50);
      const query = chunk.map((id) => `ids[]=${id}`).join('&');
      try {
        const data = await fetchJsonWithRetry(`/api/${endpoint}?${query}`, opts);
        results.push(...(data[resourceKey] || []));
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        if (opts.allowPartial && (e.status === 403 || e.status === 404)) {
          console.warn(`[Stepik MD] Skipped restricted ${endpoint} chunk (${e.status})`);
        } else {
          throw e;
        }
      }
      if (opts.onChunk) {
        opts.onChunk(Math.min(i + 50, uniqueIds.length), uniqueIds.length);
      }
      if (i + 50 < uniqueIds.length) {
        await sleep(150, opts.signal);
      }
    }
    return results;
  }

  async function runWithConcurrency(items, concurrency, fn, signal) {
    let idx = 0;
    const workerCount = Math.min(concurrency, items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (idx < items.length) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const current = items[idx++];
        await fn(current);
      }
    });
    await Promise.all(workers);
  }

  async function fetchAttemptDataset(stepId, opts = {}) {
    try {
      const data = await fetchJsonWithRetry(`/api/attempts?step=${stepId}`, opts);
      const attempts = data.attempts || [];
      if (!attempts.length) return null;
      const active = attempts.find((a) => a.status === 'active') || attempts[attempts.length - 1];
      return active?.dataset || null;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return null;
    }
  }

  // --- Step Markdown Renderer ---

  function renderOptionText(raw, isHtmlEnabled) {
    if (raw == null) return '';
    if (isHtmlEnabled === false) return cleanText(String(raw)).trim();
    return htmlToMd(String(raw)).replace(/\n+/g, ' ');
  }

  function needsAttemptDataset(step) {
    const t = step.block?.name;
    const o = step.block?.options || {};
    return INTERACTIVE_TYPES.has(t) && !o.options && !o.pairs && !o.rows && !o.components && !o.lines;
  }

  function renderStepMarkdown(step, dataset, headingLevel = 2) {
    const block = step.block || {};
    const type = block.name || 'unknown';
    const opts = block.options || {};
    const ds = dataset || {};
    const hashes = '#'.repeat(headingLevel);
    const isHtmlEnabled = ds.is_html_enabled ?? opts.is_html_enabled;

    let md = `${hashes} Шаг ${step.position} [${type}]\n\n`;

    if (step.has_submissions_restrictions && step.max_submissions_count) {
      md += `*Ограничение попыток: ${step.max_submissions_count}*\n\n`;
    }

    if (type === 'video' && block.video) {
      const urls = [...(block.video.urls || [])].sort((a, b) => Number(b.quality) - Number(a.quality));
      const best = urls[0];
      const dur = formatDuration(block.video.duration);
      const filename = cleanText(block.video.filename || '').trim();

      if (best?.url) {
        md += `*Видео (${best.quality}p${dur ? `, ${dur}` : ''}):* ${best.url}\n`;
      } else {
        md += `*Видео${dur ? ` (${dur})` : ''}*\n`;
      }
      if (/^https?:\/\//i.test(filename)) {
        md += `*Источник:* ${filename}\n`;
      } else if (filename && !/^video\./i.test(filename)) {
        md += `*Файл:* ${filename}\n`;
      }
      if (Array.isArray(block.subtitle_files) && block.subtitle_files.length) {
        const subs = block.subtitle_files
          .map((sub) => (typeof sub === 'string' ? sub : sub?.url ? `${sub.language || 'sub'}: ${sub.url}` : ''))
          .filter(Boolean);
        if (subs.length) md += `*Субтитры:* ${subs.join(', ')}\n`;
      }
      md += '\n';
    }

    if (block.text) {
      const bodyMd = htmlToMd(block.text, { minHeadingLevel: Math.min(6, headingLevel + 1) });
      if (bodyMd) md += `${bodyMd}\n\n`;
    }

    if (type === 'choice') {
      const options = ds.options || opts.options;
      const isMulti = ds.is_multiple_choice ?? opts.is_multiple_choice;
      const mode = isMulti === true ? 'несколько' : isMulti === false ? 'один' : '';
      if (options?.length) {
        md += `**Варианты ответа${mode ? ` (${mode})` : ''}:**\n`;
        for (const opt of options) {
          if (typeof opt === 'string') {
            md += `* [ ] ${renderOptionText(opt, isHtmlEnabled)}\n`;
          } else {
            const mark = opt.is_correct ? '[x]' : '[ ]';
            md += `* ${mark} ${renderOptionText(opt.text, isHtmlEnabled)}\n`;
          }
        }
        md += '\n';
      } else {
        md += `*Варианты ответа${mode ? ` (${mode})` : ''}: не загружены (попытка ещё не создавалась).*\n\n`;
      }
    }

    if (type === 'matching') {
      const pairs = ds.pairs || opts.pairs;
      if (pairs?.length) {
        md += `**Сопоставление (правый столбец перемешан):**\n\n`;
        md += `*Левый столбец:*\n`;
        pairs.forEach((pair, idx) => {
          md += `${idx + 1}. ${renderOptionText(pair.first, isHtmlEnabled)}\n`;
        });
        md += `\n*Правый столбец:*\n`;
        pairs.forEach((pair, idx) => {
          md += `${idx + 1}. ${renderOptionText(pair.second, isHtmlEnabled)}\n`;
        });
        md += '\n';
      } else {
        md += `*Пары для сопоставления не загружены (попытка ещё не создавалась).*\n\n`;
      }
    }

    if (type === 'sorting' || type === 'parsons') {
      const items = ds.options || ds.lines || opts.options || opts.lines;
      if (items?.length) {
        md += `**Элементы для сортировки:**\n`;
        items.forEach((item, idx) => {
          const text = typeof item === 'string'
            ? renderOptionText(item, isHtmlEnabled)
            : renderOptionText(item?.text, isHtmlEnabled);
          md += `${idx + 1}. ${text}\n`;
        });
        md += '\n';
      } else {
        md += `*Элементы для сортировки не загружены (попытка ещё не создавалась).*\n\n`;
      }
    }

    if (type === 'table') {
      const rows = ds.rows || opts.rows;
      const columns = ds.columns || opts.columns;
      const isCheckbox = ds.is_checkbox ?? opts.is_checkbox;
      if (rows?.length && columns?.length) {
        const desc = ds.description ? renderOptionText(ds.description, isHtmlEnabled).replace(/\|/g, '\\|') : '';
        md += `**Таблица выбора${isCheckbox ? ' (несколько в строке)' : ''}:**\n`;
        md += `| ${desc} | ${columns.map((c) => renderOptionText(c, isHtmlEnabled).replace(/\|/g, '\\|')).join(' | ')} |\n`;
        md += `| --- | ${columns.map(() => '---').join(' | ')} |\n`;
        for (const r of rows) {
          md += `| ${renderOptionText(r, isHtmlEnabled).replace(/\|/g, '\\|')} | ${columns.map(() => ' ').join(' | ')} |\n`;
        }
        md += '\n';
      } else {
        md += `*Таблица выбора не загружена (попытка ещё не создавалась).*\n\n`;
      }
    }

    if (type === 'fill-blanks') {
      const components = ds.components || opts.components;
      if (components?.length) {
        md += `**Шаблон с пропусками${ds.is_case_sensitive ? ' (учитывается регистр)' : ''}:**\n`;
        const line = components
          .map((c) => {
            if (c.type === 'text') return renderOptionText(c.text, isHtmlEnabled);
            if (c.type === 'select') return `[Выбор: ${(c.options || []).map((o) => cleanText(o)).join(' / ')}]`;
            return '[____]';
          })
          .join(' ');
        md += `${line}\n\n`;
      } else {
        md += `*Шаблон с пропусками не загружен (попытка ещё не создавалась).*\n\n`;
      }
    }

    if (type === 'number') {
      md += `*Формат ответа: число*\n\n`;
    } else if (type === 'string') {
      const notes = [];
      if (ds.is_case_sensitive ?? opts.is_case_sensitive) notes.push('учитывается регистр');
      md += `*Формат ответа: строка${notes.length ? ` (${notes.join(', ')})` : ''}*\n\n`;
    } else if (type === 'math') {
      const vars = Array.isArray(opts.variables) && opts.variables.length
        ? ` (переменные: ${opts.variables.join(', ')})`
        : '';
      md += `*Формат ответа: математическое выражение${vars}*\n\n`;
    } else if (type === 'free-answer') {
      const notes = [];
      if (opts.is_attachments_enabled) notes.push('допускаются вложения');
      md += `*Формат ответа: свободный ответ${notes.length ? ` (${notes.join(', ')})` : ''}*\n\n`;
    }

    if (type === 'code' || type === 'sql' || opts.limits || opts.execution_time_limit || opts.execution_memory_limit) {
      const limitEntries = opts.limits && typeof opts.limits === 'object' ? Object.entries(opts.limits) : [];
      if (limitEntries.length > 0 && limitEntries.length <= 5) {
        const formattedLimits = limitEntries
          .map(([lang, lim]) => `${lang} (${lim.time ?? opts.execution_time_limit ?? '?'}с, ${lim.memory ?? opts.execution_memory_limit ?? '?'} МБ)`)
          .join('; ');
        md += `*Ограничения:* ${formattedLimits}\n\n`;
      } else if (limitEntries.length > 5) {
        const langs = limitEntries.map(([lang]) => lang).join(', ');
        const defStr = [
          opts.execution_time_limit ? `${opts.execution_time_limit}с` : '',
          opts.execution_memory_limit ? `${opts.execution_memory_limit} МБ` : ''
        ].filter(Boolean).join(', ');
        md += `*Языки:* ${langs}${defStr ? ` (базовые лимиты: ${defStr})` : ''}\n\n`;
      } else if (opts.execution_time_limit || opts.execution_memory_limit) {
        const defStr = [
          opts.execution_time_limit ? `время: ${opts.execution_time_limit}с` : '',
          opts.execution_memory_limit ? `память: ${opts.execution_memory_limit} МБ` : ''
        ].filter(Boolean).join(', ');
        md += `*Ограничения:* ${defStr}\n\n`;
      }
      if (type === 'sql' && opts.database) {
        md += `*СУБД:* ${opts.database}\n\n`;
      }
    }

    if (Array.isArray(opts.samples) && opts.samples.length) {
      md += `**Примеры:**\n`;
      opts.samples.forEach(([inp, out], idx) => {
        const cleanIn = cleanText(inp).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
        const cleanOut = cleanText(out).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
        const sampleBody = `Вход:\n${cleanIn || '(пусто)'}\nВыход:\n${cleanOut || '(пусто)'}`;
        md += `*Тест ${idx + 1}:*\n${makeFence(sampleBody, 'text')}\n`;
      });
      md += '\n';
    }

    const headerCounts = opts.code_templates_header_lines_count || {};
    const footerCounts = opts.code_templates_footer_lines_count || {};
    if (opts.code_templates && typeof opts.code_templates === 'object') {
      const hiddenMeta = [];
      for (const [lang, tpl] of Object.entries(opts.code_templates)) {
        const cleanedTpl = cleanText(tpl)
          .replace(/\r\n?/g, '\n')
          .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
        const hCount = Number(headerCounts[lang]) || 0;
        const fCount = Number(footerCounts[lang]) || 0;
        const metaParts = [];
        if (hCount > 0) metaParts.push(`скрытый header: ${hCount} стр.`);
        if (fCount > 0) metaParts.push(`скрытый footer: ${fCount} стр.`);

        if (cleanedTpl) {
          const fenceLang = normalizeLang(lang);
          const suffix = metaParts.length ? ` — ${metaParts.join(', ')}` : '';
          md += `**Шаблон кода (${lang}${suffix}):**\n${makeFence(cleanedTpl, fenceLang)}\n\n`;
        } else if (metaParts.length) {
          hiddenMeta.push(`${lang}: ${metaParts.join(', ')}`);
        }
      }
      if (hiddenMeta.length) {
        md += `*Скрытый код окружения:* ${hiddenMeta.join('; ')}\n\n`;
      }
    }

    return md;
  }

  // --- Course / Module / Lesson Resolution & Builders ---

  async function resolveCourseContext(signal) {
    let courseId = null;
    let currentSectionId = null;

    const courseMatch = window.location.pathname.match(/\/course\/(\d+)/);
    if (courseMatch) {
      return { courseId: courseMatch[1], currentSectionId: null };
    }

    const scopedSelectors = [
      '.lesson-sidebar__course-title[href*="/course/"]',
      '.lesson-sidebar a[href*="/course/"]',
      'nav a[href*="/course/"]'
    ];
    for (const sel of scopedSelectors) {
      const link = document.querySelector(sel);
      const m = link?.getAttribute('href')?.match(/\/course\/(\d+)/);
      if (m) {
        courseId = m[1];
        break;
      }
    }

    const unitParam = new URLSearchParams(window.location.search).get('unit');
    if (unitParam && /^\d+$/.test(unitParam)) {
      try {
        const unitData = await fetchJsonWithRetry(`/api/units/${unitParam}`, { signal });
        const sectionId = unitData.units?.[0]?.section;
        if (sectionId) {
          currentSectionId = sectionId;
          if (!courseId) {
            const secData = await fetchJsonWithRetry(`/api/sections/${sectionId}`, { signal });
            const resolved = secData.sections?.[0]?.course;
            if (resolved) courseId = String(resolved);
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    const lessonMatch = window.location.pathname.match(/\/lesson\/(\d+)/);
    if (lessonMatch && (!courseId || !currentSectionId)) {
      const lessonId = lessonMatch[1];
      try {
        const unitsData = await fetchJsonWithRetry(`/api/units?lesson=${lessonId}`, { signal });
        const unit = unitsData.units?.[0];
        if (unit?.section) {
          currentSectionId = currentSectionId || unit.section;
          if (!courseId) {
            const secData = await fetchJsonWithRetry(`/api/sections/${unit.section}`, { signal });
            const resolved = secData.sections?.[0]?.course;
            if (resolved) courseId = String(resolved);
          }
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }

      if (!courseId) {
        const lessonData = await fetchJsonWithRetry(`/api/lessons/${lessonId}`, { signal });
        const fallbackCourse = lessonData.lessons?.[0]?.courses?.[0];
        if (fallbackCourse) courseId = String(fallbackCourse);
      }
    }

    if (!courseId) throw new Error('Could not resolve course ID');
    return { courseId, currentSectionId };
  }

  async function fetchCourseSectionsCached(signal) {
    const { courseId, currentSectionId } = await resolveCourseContext(signal);

    if (modulesCache.courseId === courseId && modulesCache.sections.length > 0) {
      return {
        courseId,
        courseTitle: modulesCache.courseTitle,
        sections: modulesCache.sections,
        currentSectionId
      };
    }

    if (modulesCache.loadingCourseId === courseId && modulesCache.loadingPromise) {
      const loaded = await modulesCache.loadingPromise;
      return { ...loaded, currentSectionId };
    }

    const loadPromise = (async () => {
      const courseData = await fetchJsonWithRetry(`/api/courses/${courseId}`, { signal });
      const course = courseData.courses?.[0];
      if (!course) throw new Error('Course not found');

      const sections = await fetchBatchedByIds('sections', 'sections', course.sections || [], {
        signal,
        allowPartial: true
      });
      sections.sort((a, b) => a.position - b.position);

      const courseTitle = cleanText(course.title || `Курс ${courseId}`).trim();
      modulesCache.courseId = courseId;
      modulesCache.courseTitle = courseTitle;
      modulesCache.sections = sections;
      return { courseId, courseTitle, sections };
    })();

    modulesCache.loadingCourseId = courseId;
    modulesCache.loadingPromise = loadPromise;

    try {
      const loaded = await loadPromise;
      return { ...loaded, currentSectionId };
    } finally {
      if (modulesCache.loadingPromise === loadPromise) {
        modulesCache.loadingCourseId = null;
        modulesCache.loadingPromise = null;
      }
    }
  }

  async function buildLessonMarkdown() {
    const match = window.location.pathname.match(/\/lesson\/(\d+)/);
    if (!match) throw new Error('Lesson ID not found in URL');
    const lessonId = match[1];

    const dataLesson = await fetchJsonWithRetry(`/api/lessons/${lessonId}`);
    const lesson = dataLesson.lessons?.[0];
    if (!lesson) throw new Error('Unable to load lesson metadata');

    const allSteps = await fetchBatchedByIds('steps', 'steps', lesson.steps || [], { allowPartial: true });
    allSteps.sort((a, b) => a.position - b.position);

    const datasets = new Map();
    const quizSteps = allSteps.filter(needsAttemptDataset);

    await runWithConcurrency(quizSteps, 3, async (s) => {
      const ds = await fetchAttemptDataset(s.id);
      if (ds) datasets.set(s.id, ds);
    });

    const courseTitle = document.querySelector('.lesson-sidebar__course-title')?.textContent?.trim();
    const lessonHeader = document.querySelector('.top-tools__lesson-name')?.textContent?.replace(/\s+/g, ' ').trim();
    const title = cleanText(lessonHeader || lesson.title || `Урок ${lessonId}`).trim();

    let md = `# ${title}\n`;
    if (courseTitle) md += `*Курс: ${cleanText(courseTitle).trim()}*\n`;
    md += '\n';

    for (const step of allSteps) {
      md += renderStepMarkdown(step, datasets.get(step.id), 2);
    }

    return {
      md: normalizeBlankLines(md) + '\n',
      lessonId,
      title,
      count: allSteps.length
    };
  }

  async function fetchSectionsContent(sectionsToExport, { onProgress, signal }) {
    const onRateLimit = (sec) => onProgress(`Rate limit ${sec}s...`, 'warn');
    const netOpts = { signal, onRateLimit, allowPartial: true };

    onProgress('Units...', 'busy');
    const allUnitIds = sectionsToExport.flatMap((s) => s.units || []);
    const units = await fetchBatchedByIds('units', 'units', allUnitIds, netOpts);
    const unitsBySection = new Map();
    for (const u of units) {
      if (!unitsBySection.has(u.section)) unitsBySection.set(u.section, []);
      unitsBySection.get(u.section).push(u);
    }
    for (const list of unitsBySection.values()) {
      list.sort((a, b) => a.position - b.position);
    }

    onProgress('Lessons...', 'busy');
    const allLessonIds = units.map((u) => u.lesson).filter(Boolean);
    const lessons = await fetchBatchedByIds('lessons', 'lessons', allLessonIds, netOpts);
    const lessonsMap = new Map(lessons.map((l) => [l.id, l]));

    const allStepIds = lessons.flatMap((l) => l.steps || []);
    const uniqueStepCount = new Set(allStepIds.filter(Boolean)).size;
    onProgress(`Steps 0/${uniqueStepCount}...`, 'busy');

    const allSteps = await fetchBatchedByIds('steps', 'steps', allStepIds, {
      ...netOpts,
      onChunk: (done, total) => onProgress(`Steps ${done}/${total}...`, 'busy')
    });
    const stepsMap = new Map(allSteps.map((s) => [s.id, s]));

    // Strictly passive GET lookup for already-created quiz attempts
    const quizSteps = allSteps.filter(needsAttemptDataset);
    const datasets = new Map();
    if (quizSteps.length > 0) {
      let doneQuizzes = 0;
      onProgress(`Quizzes 0/${quizSteps.length}...`, 'busy');
      await runWithConcurrency(
        quizSteps,
        3,
        async (s) => {
          const ds = await fetchAttemptDataset(s.id, netOpts);
          if (ds) datasets.set(s.id, ds);
          doneQuizzes++;
          if (doneQuizzes % 5 === 0 || doneQuizzes === quizSteps.length) {
            onProgress(`Quizzes ${doneQuizzes}/${quizSteps.length}...`, 'busy');
          }
          await sleep(160, signal);
        },
        signal
      );
    }

    return { unitsBySection, lessonsMap, stepsMap, datasets };
  }

  function renderSectionBlock(sec, sectionNum, { unitsBySection, lessonsMap, stepsMap, datasets }) {
    const secTitle = cleanText(sec.title || `Модуль ${sectionNum}`).trim();
    let tocLines = `* **Модуль ${sectionNum}. ${secTitle}**\n`;
    let body = `## Модуль ${sectionNum}. ${secTitle}\n\n`;
    let exportedLessons = 0;

    const secUnits = unitsBySection.get(sec.id) || [];
    if (!secUnits.length) {
      body += `*Модуль пуст или закрыт автором курса.*\n\n`;
      return { tocLines, body, exportedLessons };
    }

    secUnits.forEach((unit, uIdx) => {
      const lesson = lessonsMap.get(unit.lesson);
      const lessonNum = `${sectionNum}.${uIdx + 1}`;
      if (!lesson) {
        tocLines += `  * ${lessonNum} *[Урок недоступен]*\n`;
        body += `### Урок ${lessonNum} [Недоступен]\n\n*Урок закрыт автором курса или ещё не открыт по расписанию.*\n\n`;
        return;
      }

      const lessonTitle = cleanText(lesson.title || `Урок ${lesson.id}`).trim();
      tocLines += `  * ${lessonNum} ${lessonTitle}\n`;
      body += `### Урок ${lessonNum}. ${lessonTitle}\n\n`;
      exportedLessons++;

      const lessonSteps = (lesson.steps || [])
        .map((id) => stepsMap.get(id))
        .filter(Boolean)
        .sort((a, b) => a.position - b.position);

      if (!lessonSteps.length) {
        body += `*В уроке нет доступных шагов.*\n\n`;
      } else {
        for (const step of lessonSteps) {
          body += renderStepMarkdown(step, datasets.get(step.id), 4);
        }
      }
    });

    return { tocLines, body, exportedLessons };
  }

  async function buildModuleMarkdown(sectionId, { onProgress, signal }) {
    onProgress('Modules...', 'busy');
    const { courseId, courseTitle, sections } = await fetchCourseSectionsCached(signal);

    const idx = sections.findIndex((s) => String(s.id) === String(sectionId));
    if (idx === -1) throw new Error('Selected module not found');
    const sec = sections[idx];
    const sectionNum = idx + 1;
    const secTitle = cleanText(sec.title || `Модуль ${sectionNum}`).trim();

    const contentData = await fetchSectionsContent([sec], { onProgress, signal });
    const rendered = renderSectionBlock(sec, sectionNum, contentData);

    const fullMd = normalizeBlankLines(`# ${courseTitle}\n\n${rendered.body}`) + '\n';
    return {
      md: fullMd,
      courseId,
      sectionId: sec.id,
      sectionNum,
      title: `${sectionNum}. ${secTitle}`,
      lessonsCount: rendered.exportedLessons
    };
  }

  async function buildCourseMarkdown({ onProgress, signal }) {
    onProgress('Modules...', 'busy');
    const { courseId, courseTitle, sections } = await fetchCourseSectionsCached(signal);
    const contentData = await fetchSectionsContent(sections, { onProgress, signal });

    let toc = `## Оглавление\n\n`;
    let body = '';
    let exportedLessons = 0;

    sections.forEach((sec, idx) => {
      const rendered = renderSectionBlock(sec, idx + 1, contentData);
      toc += rendered.tocLines;
      body += rendered.body;
      exportedLessons += rendered.exportedLessons;
    });

    const fullMd = normalizeBlankLines(`# ${courseTitle}\n\n${toc}\n---\n\n${body}`) + '\n';
    return { md: fullMd, courseId, title: courseTitle, lessonsCount: exportedLessons };
  }

  // --- Native Header Pill + Body-Portal Dropdown UI (Dual Shadow DOM, Zero Emojis) ---

  const isLessonPage = () => /\/lesson\/\d+/.test(window.location.pathname);
  const isCoursePage = () => /\/course\/\d+/.test(window.location.pathname);
  const isSupportedPage = () => isLessonPage() || isCoursePage();

  const PAGE_CSS = `
    .player-topbar__user-controls {
      position: relative !important;
      z-index: 100 !important;
      pointer-events: auto !important;
    }
    #${PILL_HOST_ID} {
      position: relative !important;
      z-index: 2147483600 !important;
      display: inline-flex !important;
      align-items: center !important;
      align-self: center !important;
      flex: 0 0 auto !important;
      pointer-events: auto !important;
      isolation: isolate !important;
      list-style: none !important;
      visibility: visible !important;
      opacity: 1 !important;
    }
    #${PILL_HOST_ID}[data-mode="fixed"] {
      position: fixed !important;
      top: 12px !important;
      right: 16px !important;
      z-index: 2147483646 !important;
    }
    #${MENU_HOST_ID} {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 0 !important;
      height: 0 !important;
      overflow: visible !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
      isolation: isolate !important;
    }
  `;

  const PILL_STYLES = `
    :host {
      all: initial;
      position: relative !important;
      z-index: 2147483600 !important;
      display: inline-flex !important;
      align-items: center !important;
      flex: 0 0 auto !important;
      pointer-events: auto !important;
      isolation: isolate !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      color: #eceff4;
      color-scheme: dark;
    }

    .pill {
      position: relative;
      z-index: 1;
      pointer-events: auto !important;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 30px;
      padding: 0 10px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.16);
      color: rgba(243, 244, 246, 0.9);
      font-family: inherit;
      font-size: 12px;
      font-weight: 500;
      letter-spacing: 0.01em;
      line-height: 1;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
    }

    :host([data-mode="fixed"]) .pill {
      background: rgba(24, 26, 32, 0.88);
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.28);
    }

    .pill:hover,
    .pill:focus-visible,
    .pill.open,
    .pill.active {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.28);
      color: #ffffff;
      outline: none;
    }

    :host([data-mode="fixed"]) .pill:hover,
    :host([data-mode="fixed"]) .pill.open {
      background: rgba(24, 26, 32, 0.96);
    }

    .icon {
      width: 13px;
      height: 13px;
      flex-shrink: 0;
      opacity: 0.82;
      pointer-events: none;
    }

    .pill-label {
      pointer-events: none;
    }

    .chevron {
      width: 11px;
      height: 11px;
      flex-shrink: 0;
      opacity: 0.6;
      pointer-events: none;
      transition: transform 140ms ease, opacity 140ms ease;
    }

    .pill.open .chevron {
      transform: rotate(180deg);
      opacity: 0.95;
    }

    .dot {
      display: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
      pointer-events: none;
    }

    .pill[data-state="busy"] .dot {
      display: inline-block;
      background: #93c5fd;
      animation: st-pulse 1.15s ease-in-out infinite;
    }
    .pill[data-state="ok"] .dot {
      display: inline-block;
      background: #6ee7b7;
    }
    .pill[data-state="warn"] .dot {
      display: inline-block;
      background: #fcd34d;
    }
    .pill[data-state="err"] .dot {
      display: inline-block;
      background: #fca5a5;
    }

    @keyframes st-pulse {
      0%, 100% { opacity: 0.35; }
      50% { opacity: 1; }
    }
  `;

  const MENU_STYLES = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      color: #eceff4;
      color-scheme: dark;
    }

    .menu {
      position: fixed;
      top: 48px;
      right: 16px;
      width: 252px;
      padding: 6px;
      border-radius: 8px;
      background: rgba(24, 26, 32, 0.97);
      border: 1px solid rgba(255, 255, 255, 0.15);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.48);
      display: flex;
      flex-direction: column;
      gap: 3px;
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
      transform-origin: top right;
      visibility: hidden;
      pointer-events: none;
      z-index: 2147483647;
      transition: opacity 120ms ease, transform 120ms ease, visibility 120ms ease;
    }

    .menu.open {
      opacity: 1;
      transform: translateY(0) scale(1);
      visibility: visible;
      pointer-events: auto !important;
    }

    .section-label {
      padding: 4px 8px 2px;
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: rgba(209, 213, 219, 0.48);
      user-select: none;
    }

    .item {
      pointer-events: auto !important;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      padding: 7px 8px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: rgba(243, 244, 246, 0.92);
      font-family: inherit;
      font-size: 12px;
      font-weight: 450;
      text-align: left;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: pointer;
      transition: background 110ms ease, color 110ms ease;
    }

    .item:hover:not(:disabled),
    .item:focus-visible:not(:disabled) {
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
      outline: none;
    }

    .item:disabled {
      opacity: 0.42;
      cursor: default;
    }

    .item.running {
      color: #fcd34d;
      background: rgba(252, 211, 77, 0.09);
    }

    .item.running:hover {
      background: rgba(252, 211, 77, 0.16);
    }

    .lbl {
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }

    .hint {
      font-size: 10.5px;
      color: rgba(209, 213, 219, 0.48);
      flex-shrink: 0;
      pointer-events: none;
    }

    .select-wrap {
      padding: 2px 4px 3px;
    }

    .module-select {
      pointer-events: auto !important;
      width: 100%;
      height: 29px;
      padding: 0 24px 0 8px;
      border-radius: 5px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      background: rgba(255, 255, 255, 0.06);
      color: rgba(243, 244, 246, 0.92);
      font-family: inherit;
      font-size: 11.5px;
      cursor: pointer;
      outline: none;
      text-overflow: ellipsis;
      color-scheme: dark;
    }

    .module-select:hover:not(:disabled),
    .module-select:focus {
      border-color: rgba(255, 255, 255, 0.28);
      background: rgba(255, 255, 255, 0.1);
    }

    .module-select:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .module-select option {
      background: #1a1d24;
      color: #eceff4;
    }

    .divider {
      height: 1px;
      margin: 4px 4px;
      background: rgba(255, 255, 255, 0.09);
    }

    .hidden {
      display: none !important;
    }
  `;

  function ensurePageStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    style.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function setWidgetStatus(text, state = 'idle', resetMs = 0) {
    if (!ui) return;
    if (statusResetTimer) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }

    if (state === 'idle' || !text) {
      ui.pill.removeAttribute('data-state');
      ui.pill.classList.remove('active');
      ui.pillText.textContent = 'MD';
      return;
    }

    ui.pill.setAttribute('data-state', state);
    ui.pill.classList.add('active');
    ui.pillText.textContent = text;

    if (resetMs > 0) {
      statusResetTimer = setTimeout(() => {
        if (activeExportAbort && lastExportStatus) {
          setWidgetStatus(lastExportStatus.text, lastExportStatus.state);
        } else if (!activeExportAbort && !isLessonBusy) {
          setWidgetStatus('', 'idle');
        }
      }, resetMs);
    }
  }

  function positionMenu() {
    if (!ui || !ui.isOpen) return;
    const rect = ui.pill.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setMenuOpen(false);
      return;
    }
    const menuWidth = 252;
    const gap = 6;
    const margin = 8;
    let right = Math.max(margin, window.innerWidth - rect.right);
    if (window.innerWidth - right - menuWidth < margin) {
      right = Math.max(margin, window.innerWidth - menuWidth - margin);
    }
    const top = Math.max(margin, Math.min(rect.bottom + gap, window.innerHeight - 60));
    ui.menu.style.top = `${Math.round(top)}px`;
    ui.menu.style.right = `${Math.round(right)}px`;
  }

  function setMenuOpen(open) {
    if (!ui) return;
    ui.isOpen = open;
    ui.pill.classList.toggle('open', open);
    ui.menu.classList.toggle('open', open);
    ui.pill.setAttribute('aria-expanded', String(open));
    if (open) {
      positionMenu();
      populateModuleSelector();
    }
  }

  async function populateModuleSelector() {
    if (!ui) return;
    const sel = ui.moduleSelect;
    const modBtn = ui.moduleBtn;

    const currentUrlKey = `${window.location.pathname}${window.location.search}`;
    const alreadyLoadedForPage =
      sel.options.length > 0 &&
      sel.dataset.courseId &&
      sel.dataset.courseId === modulesCache.courseId &&
      !sel.disabled;

    if (!alreadyLoadedForPage) {
      sel.disabled = true;
      sel.innerHTML = '';
      const loadingOpt = document.createElement('option');
      loadingOpt.textContent = 'Loading modules...';
      loadingOpt.value = '';
      sel.appendChild(loadingOpt);
      if (!activeExportAbort) modBtn.disabled = true;
    }

    try {
      const { courseId, sections, currentSectionId } = await fetchCourseSectionsCached();
      if (!ui) return;

      if (sel.dataset.courseId !== courseId || sel.disabled) {
        sel.innerHTML = '';
        if (!sections.length) {
          const emptyOpt = document.createElement('option');
          emptyOpt.textContent = 'No modules available';
          emptyOpt.value = '';
          sel.appendChild(emptyOpt);
          sel.disabled = true;
          modBtn.disabled = true;
          return;
        }

        sections.forEach((sec, idx) => {
          const opt = document.createElement('option');
          opt.value = String(sec.id);
          const title = cleanText(sec.title || `Module ${idx + 1}`).trim();
          const suffix = !sec.units?.length
            ? ' (empty)'
            : sec.is_active === false
              ? ' (locked)'
              : '';
          opt.textContent = `${idx + 1}. ${title}${suffix}`;
          sel.appendChild(opt);
        });

        sel.dataset.courseId = courseId;
        sel.disabled = false;
      }

      if (currentSectionId && modulesCache.lastPreselectedLessonKey !== currentUrlKey) {
        const target = String(currentSectionId);
        if (Array.from(sel.options).some((o) => o.value === target)) {
          sel.value = target;
        }
        modulesCache.lastPreselectedLessonKey = currentUrlKey;
      }

      if (!activeExportAbort) {
        modBtn.disabled = !sel.value;
      }
    } catch (e) {
      console.error('[Stepik MD Modules]', e);
      if (!ui) return;
      sel.innerHTML = '';
      const errOpt = document.createElement('option');
      errOpt.textContent = 'Failed to load modules';
      errOpt.value = '';
      sel.appendChild(errOpt);
      sel.disabled = true;
      modBtn.disabled = true;
    }
  }

  function createWidget() {
    // 1. Pill Host (lives in navbar or fixed fallback)
    const pillHost = document.createElement('div');
    pillHost.id = PILL_HOST_ID;
    const pillShadow = pillHost.attachShadow({ mode: 'open' });

    const pillStyle = document.createElement('style');
    pillStyle.textContent = PILL_STYLES;

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'pill';
    pill.title = 'Export Markdown (Alt+M)';
    pill.setAttribute('aria-haspopup', 'menu');
    pill.setAttribute('aria-expanded', 'false');
    pill.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 2.5v7.5m0 0-2.8-2.8M8 10l2.8-2.8"/>
        <path d="M3 12.5h10"/>
      </svg>
      <span class="pill-label">MD</span>
      <svg class="chevron" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 4.5 6 7.5 9 4.5"/>
      </svg>
    `;

    pillShadow.append(pillStyle, pill);

    // 2. Menu Portal Host (mounted directly on document.body, immune to header overflow/z-index/Ember listeners)
    const menuHost = document.createElement('div');
    menuHost.id = MENU_HOST_ID;
    const menuShadow = menuHost.attachShadow({ mode: 'open' });

    const menuStyle = document.createElement('style');
    menuStyle.textContent = MENU_STYLES;

    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');

    // Section 1: Current Lesson
    const lessonGroup = document.createElement('div');
    lessonGroup.className = 'lesson-group';

    const lessonHeading = document.createElement('div');
    lessonHeading.className = 'section-label';
    lessonHeading.textContent = 'Current Lesson';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'item';
    copyBtn.setAttribute('role', 'menuitem');
    copyBtn.innerHTML = `<span class="lbl">Copy Lesson</span><span class="hint">Alt+C</span>`;

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'item';
    dlBtn.setAttribute('role', 'menuitem');
    dlBtn.innerHTML = `<span class="lbl">Download Lesson (.md)</span>`;

    const lessonDivider = document.createElement('div');
    lessonDivider.className = 'divider';

    lessonGroup.append(lessonHeading, copyBtn, dlBtn, lessonDivider);

    // Section 2: Single Module
    const moduleHeading = document.createElement('div');
    moduleHeading.className = 'section-label';
    moduleHeading.textContent = 'Single Module';

    const selectWrap = document.createElement('div');
    selectWrap.className = 'select-wrap';

    const moduleSelect = document.createElement('select');
    moduleSelect.className = 'module-select';
    moduleSelect.setAttribute('aria-label', 'Select module to export');
    moduleSelect.disabled = true;
    moduleSelect.innerHTML = `<option value="">Loading modules...</option>`;
    selectWrap.appendChild(moduleSelect);

    const moduleBtn = document.createElement('button');
    moduleBtn.type = 'button';
    moduleBtn.className = 'item';
    moduleBtn.setAttribute('role', 'menuitem');
    moduleBtn.disabled = true;
    moduleBtn.title = 'Export selected module as Markdown (click again to cancel)';
    moduleBtn.innerHTML = `<span class="lbl">Download Module (.md)</span>`;

    const courseDivider = document.createElement('div');
    courseDivider.className = 'divider';

    // Section 3: Full Course
    const courseHeading = document.createElement('div');
    courseHeading.className = 'section-label';
    courseHeading.textContent = 'Full Course';

    const courseBtn = document.createElement('button');
    courseBtn.type = 'button';
    courseBtn.className = 'item';
    courseBtn.setAttribute('role', 'menuitem');
    courseBtn.title = 'Export all accessible modules as a single Markdown file (click again to cancel)';
    courseBtn.innerHTML = `<span class="lbl">Download Full Course (.md)</span>`;

    menu.append(
      lessonGroup,
      moduleHeading,
      selectWrap,
      moduleBtn,
      courseDivider,
      courseHeading,
      courseBtn
    );

    menuShadow.append(menuStyle, menu);

    ui = {
      isOpen: false,
      pillHost,
      menuHost,
      pill,
      pillText: pill.querySelector('.pill-label'),
      menu,
      lessonGroup,
      copyBtn,
      copyLabel: copyBtn.querySelector('.lbl'),
      dlBtn,
      dlLabel: dlBtn.querySelector('.lbl'),
      moduleSelect,
      moduleBtn,
      moduleLabel: moduleBtn.querySelector('.lbl'),
      courseBtn,
      courseLabel: courseBtn.querySelector('.lbl')
    };

    // Bulletproof pill toggle: activate immediately on primary pointerdown (immune to click suppression),
    // and support keyboard activation via click (e.detail === 0) without double-toggling.
    let lastPointerToggleAt = 0;

    pill.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || e.button !== 0) return;
      e.stopPropagation();
      lastPointerToggleAt = performance.now();
      setMenuOpen(!ui.isOpen);
    });

    pill.addEventListener('mousedown', (e) => {
      e.stopPropagation();
    });

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.detail > 0 && performance.now() - lastPointerToggleAt < 500) {
        return;
      }
      setMenuOpen(!ui.isOpen);
    });

    // Keep menu portal events isolated from page/Ember bubble handlers without breaking native <select>
    menu.addEventListener('pointerdown', (e) => e.stopPropagation());
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => e.stopPropagation());

    moduleSelect.addEventListener('change', () => {
      if (!activeExportAbort) {
        moduleBtn.disabled = !moduleSelect.value;
      }
    });

    copyBtn.addEventListener('click', () => handleCopyLesson());
    dlBtn.addEventListener('click', () => handleDownloadLesson());
    moduleBtn.addEventListener('click', () => handleDownloadModule());
    courseBtn.addEventListener('click', () => handleDownloadCourse());
  }

  // --- Action Handlers ---

  async function handleCopyLesson() {
    if (!ui || isLessonBusy || !isLessonPage()) return;
    isLessonBusy = true;
    ui.copyBtn.disabled = true;
    ui.copyLabel.textContent = 'Copying...';
    setWidgetStatus('Copying...', 'busy');

    try {
      const { md, count } = await buildLessonMarkdown();
      await copyToClipboard(md);
      const doneText = `Copied (${count})`;
      ui.copyLabel.textContent = doneText;
      setWidgetStatus(doneText, 'ok', 2200);
      setMenuOpen(false);
    } catch (e) {
      console.error('[Stepik MD]', e);
      ui.copyLabel.textContent = 'Copy failed';
      setWidgetStatus('Error', 'err', 2400);
    } finally {
      isLessonBusy = false;
      setTimeout(() => {
        if (ui) {
          ui.copyBtn.disabled = false;
          ui.copyLabel.textContent = 'Copy Lesson';
        }
      }, 1800);
    }
  }

  async function handleDownloadLesson() {
    if (!ui || isLessonBusy || !isLessonPage()) return;
    isLessonBusy = true;
    ui.dlBtn.disabled = true;
    ui.dlLabel.textContent = 'Exporting...';
    setWidgetStatus('Exporting...', 'busy');

    try {
      const { md, lessonId, title } = await buildLessonMarkdown();
      triggerDownload(md, `${sanitizeFilename(title, `lesson-${lessonId}`)}.md`);
      ui.dlLabel.textContent = 'Saved';
      setWidgetStatus('Saved', 'ok', 2200);
      setMenuOpen(false);
    } catch (e) {
      console.error('[Stepik MD]', e);
      ui.dlLabel.textContent = 'Export failed';
      setWidgetStatus('Error', 'err', 2400);
    } finally {
      isLessonBusy = false;
      setTimeout(() => {
        if (ui) {
          ui.dlBtn.disabled = false;
          ui.dlLabel.textContent = 'Download Lesson (.md)';
        }
      }, 1800);
    }
  }

  async function runAbortableExport({ kind, button, labelEl, idleLabel, otherButton, run }) {
    if (!ui) return;

    if (activeExportAbort && activeExportKind === kind) {
      activeExportAbort.abort();
      activeExportAbort = null;
      activeExportKind = null;
      lastExportStatus = null;
      button.classList.remove('running');
      labelEl.textContent = 'Cancelled';
      if (otherButton) otherButton.disabled = kind === 'course' && !ui.moduleSelect.value;
      setWidgetStatus('Cancelled', 'warn', 1800);
      setTimeout(() => {
        if (ui && !activeExportAbort) labelEl.textContent = idleLabel;
      }, 1800);
      return;
    }

    if (activeExportAbort) return;

    const controller = new AbortController();
    activeExportAbort = controller;
    activeExportKind = kind;
    button.classList.add('running');
    if (otherButton) otherButton.disabled = true;

    const updateProgress = (msg, state = 'busy') => {
      if (!ui || activeExportAbort !== controller) return;
      lastExportStatus = { text: msg, state };
      labelEl.textContent = `${msg} (Cancel)`;
      setWidgetStatus(msg, state);
    };

    try {
      const doneText = await run(controller.signal, updateProgress);
      labelEl.textContent = doneText;
      lastExportStatus = null;
      setWidgetStatus(doneText, 'ok', 2600);
      setMenuOpen(false);
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error(`[Stepik MD ${kind}]`, e);
      labelEl.textContent = 'Export failed';
      lastExportStatus = null;
      setWidgetStatus('Error', 'err', 2600);
    } finally {
      if (activeExportAbort === controller) {
        activeExportAbort = null;
        activeExportKind = null;
        lastExportStatus = null;
        button.classList.remove('running');
        if (otherButton) {
          otherButton.disabled = otherButton === ui.moduleBtn ? !ui.moduleSelect.value : false;
        }
        setTimeout(() => {
          if (ui && !activeExportAbort) labelEl.textContent = idleLabel;
        }, 2600);
      }
    }
  }

  function handleDownloadModule() {
    if (!ui) return;
    const sectionId = ui.moduleSelect.value;
    if (!sectionId && activeExportKind !== 'module') return;

    runAbortableExport({
      kind: 'module',
      button: ui.moduleBtn,
      labelEl: ui.moduleLabel,
      idleLabel: 'Download Module (.md)',
      otherButton: ui.courseBtn,
      run: async (signal, onProgress) => {
        const { md, sectionId: secId, title, lessonsCount } = await buildModuleMarkdown(sectionId, {
          signal,
          onProgress
        });
        triggerDownload(md, `${sanitizeFilename(title, `module-${secId}`)}.md`);
        return `Done (${lessonsCount} lessons)`;
      }
    });
  }

  function handleDownloadCourse() {
    if (!ui) return;

    runAbortableExport({
      kind: 'course',
      button: ui.courseBtn,
      labelEl: ui.courseLabel,
      idleLabel: 'Download Full Course (.md)',
      otherButton: ui.moduleBtn,
      run: async (signal, onProgress) => {
        const { md, courseId, title, lessonsCount } = await buildCourseMarkdown({
          signal,
          onProgress
        });
        triggerDownload(md, `${sanitizeFilename(title, `course-${courseId}`)}.md`);
        return `Done (${lessonsCount} lessons)`;
      }
    });
  }

  // --- Native Navbar Slot Resolution & Non-Looping Mount ---

  function isOwnNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    return node.id === PILL_HOST_ID || node.id === MENU_HOST_ID || node.id === PAGE_STYLE_ID;
  }

  function hasExternalMutations(records) {
    for (const rec of records) {
      for (const n of rec.addedNodes) {
        if (!isOwnNode(n)) return true;
      }
      for (const n of rec.removedNodes) {
        if (!isOwnNode(n)) return true;
      }
    }
    return false;
  }

  function resolveMountTarget() {
    if (isLessonPage()) {
      const userControls = document.querySelector('.player-topbar__user-controls');
      if (userControls) {
        return {
          parent: userControls,
          position: 'first',
          before: null,
          mode: 'navbar',
          marginCss: '0 8px 0 0'
        };
      }
      const playerBar =
        document.querySelector('nav.player-navbar') ||
        document.querySelector('.player-topbar__panel');
      if (playerBar) {
        return {
          parent: playerBar,
          position: 'last',
          before: null,
          mode: 'navbar',
          marginCss: '0 8px 0 auto'
        };
      }
    }

    if (isCoursePage()) {
      const mainNavbar = document.querySelector('#main-navbar');
      if (mainNavbar) {
        const anchor =
          mainNavbar.querySelector('.language-selector') ||
          mainNavbar.querySelector('.navbar__activity') ||
          mainNavbar.querySelector('.navbar__profile-toggler') ||
          mainNavbar.querySelector('.navbar__auth');
        if (anchor?.parentElement && anchor !== ui?.pillHost) {
          return {
            parent: anchor.parentElement,
            position: 'before',
            before: anchor,
            mode: 'navbar',
            marginCss: '0 8px'
          };
        }
        return {
          parent: mainNavbar,
          position: 'last',
          before: null,
          mode: 'navbar',
          marginCss: '0 8px 0 auto'
        };
      }
    }

    return {
      parent: document.body,
      position: 'last',
      before: null,
      mode: 'fixed',
      marginCss: '0'
    };
  }

  function ensureObservers() {
    const headerEl = document.getElementById('main-header');

    if (headerEl !== observedHeaderEl) {
      if (headerObserver) {
        headerObserver.disconnect();
        headerObserver = null;
      }
      observedHeaderEl = headerEl;
      if (headerEl) {
        headerObserver = new MutationObserver((records) => {
          if (hasExternalMutations(records)) scheduleSync();
        });
        headerObserver.observe(headerEl, { childList: true, subtree: true });
      }
    }

    // Use a temporary body subtree observer only while waiting for #main-header / navbar hydration
    const needsDiscovery =
      isSupportedPage() &&
      (!observedHeaderEl || !observedHeaderEl.isConnected || ui?.pillHost?.getAttribute('data-mode') === 'fixed');

    if (needsDiscovery && !discoveryObserver && document.body) {
      discoveryObserver = new MutationObserver((records) => {
        if (hasExternalMutations(records)) scheduleSync();
      });
      discoveryObserver.observe(document.body, { childList: true, subtree: true });
    } else if (!needsDiscovery && discoveryObserver) {
      discoveryObserver.disconnect();
      discoveryObserver = null;
    }
  }

  function syncWidgetMount() {
    ensurePageStyle();

    const supported = isSupportedPage();
    if (!supported) {
      document.querySelectorAll(`#${PILL_HOST_ID}, #${MENU_HOST_ID}`).forEach((el) => el.remove());
      ui = null;
      ensureObservers();
      return;
    }

    if (!ui) {
      document.querySelectorAll(`#${PILL_HOST_ID}, #${MENU_HOST_ID}`).forEach((el) => el.remove());
      createWidget();
    } else {
      // Remove any stray duplicates while preserving our active instances
      document.querySelectorAll(`#${PILL_HOST_ID}`).forEach((el) => {
        if (el !== ui.pillHost) el.remove();
      });
      document.querySelectorAll(`#${MENU_HOST_ID}`).forEach((el) => {
        if (el !== ui.menuHost) el.remove();
      });
    }

    // Ensure menu portal stays mounted directly on document.body
    if (document.body && ui.menuHost.parentElement !== document.body) {
      document.body.appendChild(ui.menuHost);
    }

    const { parent, position, before, mode, marginCss } = resolveMountTarget();
    if (!parent) return;

    if (ui.pillHost.getAttribute('data-mode') !== mode) {
      ui.pillHost.setAttribute('data-mode', mode);
    }
    if (ui.pillHost.style.margin !== marginCss) {
      ui.pillHost.style.margin = marginCss;
    }

    let alreadyInPlace = false;
    if (ui.pillHost.parentElement === parent) {
      if (position === 'first') {
        alreadyInPlace = parent.firstElementChild === ui.pillHost;
      } else if (position === 'before' && before) {
        alreadyInPlace = ui.pillHost.nextElementSibling === before;
      } else {
        alreadyInPlace = true;
      }
    }

    if (!alreadyInPlace) {
      if (position === 'first') {
        parent.prepend(ui.pillHost);
      } else if (position === 'before' && before && before.parentElement === parent) {
        parent.insertBefore(ui.pillHost, before);
      } else {
        parent.appendChild(ui.pillHost);
      }
    }

    const onLesson = isLessonPage();
    ui.lessonGroup.classList.toggle('hidden', !onLesson);

    if (ui.isOpen) {
      positionMenu();
      populateModuleSelector();
    }

    ensureObservers();
  }

  function scheduleSync() {
    if (syncRafPending) return;
    syncRafPending = true;
    requestAnimationFrame(() => {
      syncRafPending = false;
      syncWidgetMount();
    });
  }

  // --- SPA Navigation, Viewport Repositioning & Keyboard Shortcuts ---

  if (!window.__stMdHooked) {
    window.__stMdHooked = true;

    const onRouteChange = () => {
      if (window.location.href !== lastObservedHref) {
        lastObservedHref = window.location.href;
        modulesCache.lastPreselectedLessonKey = null;
        if (ui?.isOpen) setMenuOpen(false);
      }
      scheduleSync();
    };

    window.addEventListener('popstate', onRouteChange);

    const origPush = history.pushState;
    history.pushState = function (...args) {
      const ret = origPush.apply(this, args);
      onRouteChange();
      return ret;
    };

    const origReplace = history.replaceState;
    history.replaceState = function (...args) {
      const ret = origReplace.apply(this, args);
      onRouteChange();
      return ret;
    };

    // Lightweight URL/mount check for Chrome MV3 isolated worlds (where history monkey-patch won't intercept main-world Ember calls)
    setInterval(() => {
      if (window.location.href !== lastObservedHref) {
        onRouteChange();
      } else if (isSupportedPage() && (!ui?.pillHost?.isConnected || !ui?.menuHost?.isConnected)) {
        scheduleSync();
      }
    }, 750);

    // Close menu on outside interaction in capture phase (works even if Stepik elements stop propagation)
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!ui || !ui.isOpen) return;
        const path = e.composedPath();
        if (!path.includes(ui.pillHost) && !path.includes(ui.menuHost)) {
          setMenuOpen(false);
        }
      },
      true
    );

    window.addEventListener('resize', () => {
      if (ui?.isOpen) positionMenu();
    }, { passive: true });

    window.addEventListener('scroll', () => {
      if (ui?.isOpen) positionMenu();
    }, { passive: true, capture: true });

    document.addEventListener('keydown', (e) => {
      if (!isSupportedPage()) return;
      if (e.key === 'Escape' && ui?.isOpen) {
        setMenuOpen(false);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (e.code === 'KeyM') {
          e.preventDefault();
          if (ui) setMenuOpen(!ui.isOpen);
        } else if (e.code === 'KeyC' && isLessonPage()) {
          e.preventDefault();
          handleCopyLesson();
        }
      }
    });
  }

  syncWidgetMount();
})();