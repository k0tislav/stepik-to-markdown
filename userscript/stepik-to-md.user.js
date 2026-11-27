// ==UserScript==
// @name            Stepik Lesson & Course to Markdown (Universal)
// @name:ru         Stepik РІ Markdown вЂ” СЃРєР°С‡РёРІР°РЅРёРµ РєСѓСЂСЃРѕРІ Рё СѓСЂРѕРєРѕРІ
// @namespace       https://github.com/k0tislav/stepik-to-markdown
// @version         2.1
// @description     Export a Stepik lesson, single module, or full course to clean Markdown for LLMs (strictly read-only GET API)
// @description:ru  Р­РєСЃРїРѕСЂС‚ РєСѓСЂСЃРѕРІ, РјРѕРґСѓР»РµР№ Рё СѓСЂРѕРєРѕРІ СЃРѕ Stepik РІ С‡РёСЃС‚С‹Р№ С„РѕСЂРјР°С‚ Markdown (.md) РґР»СЏ РЅРµР№СЂРѕСЃРµС‚РµР№ Рё РєРѕРЅСЃРїРµРєС‚РѕРІ
// @author          k0tislav
// @license         MIT
// @homepageURL     https://github.com/k0tislav/stepik-to-markdown
// @match           https://stepik.org/*
// @match           https://*.stepik.org/*
// @icon            https://stepik.org/favicon.ico
// @grant           GM_setClipboard
// @run-at          document-idle
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
  const STEPIK_ORIGIN = 'https://stepik.org';
  const LESSON_PATH_RE = /\/lesson\/(?:[^/]+-)?(\d+)/;
  const COURSE_PATH_RE = /\/course\/(?:[^/]+-)?(\d+)/;
  const INLINE_HTML_TAG_RE = /(^|[\s([{"'«,:;>])(<!--[\s\S]*?-->|<!DOCTYPE\b[^>]*>|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s+(?:[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?\s*)*)?\/?>)/g;
  const DEFAULT_REQUEST_TIMEOUT_MS = 25000;

  let activeExportAbort = null;
  let activeExportKind = null; // 'module' | 'course' | null
  let lastExportStatus = null; // { text, state }
  let isLessonBusy = false;
  let lessonResetTimer = null;
  let statusResetTimer = null;
  let globalRateLimitUntil = 0;
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
    if (/^(?:mono\s+)?(c#|csharp)/.test(l)) return 'csharp';
    if (/^(sh|shell|bash|zsh)/.test(l)) return 'bash';
    if (/^(js|javascript|node)/.test(l)) return 'javascript';
    if (/^(ts|typescript)/.test(l)) return 'typescript';
    if (/^(postgres|mysql|sqlite|sql)/.test(l)) return 'sql';
    if (/^java(?:\d|\b)/.test(l)) return 'java';
    if (/^kotlin/.test(l)) return 'kotlin';
    if (/^haskell/.test(l)) return 'haskell';
    if (/^rust/.test(l)) return 'rust';
    if (/^go(?:\d|\b)/.test(l)) return 'go';
    if (/^asm/.test(l)) return 'asm';
    return l.replace(/[\s\d.]+$/, '') || l;
  };

  function resolveStepikUrl(url) {
    const trimmed = (url || '').trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    if (trimmed.startsWith('/')) return `${STEPIK_ORIGIN}${trimmed}`;
    return trimmed;
  }

  function escapeMdUrl(url) {
    return url.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  }

  function escapeHtmlAttr(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function protectInlineHtmlTags(text, pushInlineCode) {
    if (!text || !text.includes('<')) return text;
    return text.replace(INLINE_HTML_TAG_RE, (full, lead, tag) => `${lead}${pushInlineCode(tag)}`);
  }

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
    if (
      tag === 'span' &&
      !node.hasAttribute('style') &&
      /\b(hljs|token|cm-|ace_|line-number)/.test(node.className || '')
    ) {
      return Array.from(node.childNodes).map(serializePreNode).join('');
    }
    const attrs = Array.from(node.attributes)
      .map((a) => ` ${a.name}="${escapeHtmlAttr(a.value)}"`)
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

    // Remove Stepik UI copy buttons before extracting code blocks
    root.querySelectorAll('.copy-code-btn').forEach((el) => el.remove());

    const TOK = '\uE000';
    const END = '\uE001';
    const makeTok = (kind, idx) => `${TOK}${kind}_${idx}${END}`;

    const codeBlocks = [];
    const mathBlocks = [];
    const inlineCodes = [];
    const subSupBlocks = [];
    const tableBlocks = [];
    const listBlocks = [];
    const quoteBlocks = [];

    const pushInlineCode = (rawText) => {
      const token = makeTok('ICODE', inlineCodes.length);
      inlineCodes.push(rawText ? wrapInlineCode(rawText) : '');
      return token;
    };

    const restoreTokens = (str, opts = {}) => {
      let out = str;
      quoteBlocks.forEach((b, i) => { out = out.replaceAll(makeTok('QUOTE', i), () => b); });
      listBlocks.forEach((b, i) => { out = out.replaceAll(makeTok('LIST', i), () => b); });
      tableBlocks.forEach((b, i) => { out = out.replaceAll(makeTok('TBL', i), () => b); });
      if (!opts.skipBlockCode) {
        codeBlocks.forEach((block, i) => {
          const token = makeTok('CODE', i);
          if (!out.includes(token)) return;
          if (block.inline) {
            out = out.replaceAll(token, () => block.content);
            return;
          }
          const lineRe = new RegExp(`^([ \\t]*)(.*)${token}(.*)$`, 'gm');
          out = out.replace(lineRe, (_, leadIndent, before, after) => {
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
      }
      mathBlocks.forEach((b, i) => { out = out.replaceAll(makeTok('MATH', i), () => b); });
      inlineCodes.forEach((b, i) => { out = out.replaceAll(makeTok('ICODE', i), () => b); });
      subSupBlocks.forEach((b, i) => { out = out.replaceAll(makeTok('SUB', i), () => b); });
      return out;
    };

    // 1. Extract <pre> BEFORE removing <script>/<style>/<iframe> so unescaped HTML/CSS/JS examples stay intact
    root.querySelectorAll('pre').forEach((pre) => {
      if (!pre.isConnected) return;
      const codeEl = pre.querySelector('code');
      const cls = [
        codeEl?.className || '',
        codeEl?.getAttribute('data-language') || '',
        pre.className || '',
        pre.getAttribute('data-language') || ''
      ].join(' ');
      const langMatch = cls.match(/(?:language|lang)-([a-zA-Z0-9_+#.-]+)/);
      const lang = langMatch ? normalizeLang(langMatch[1]) : '';
      const rawCode = cleanText(serializePreChildren(pre))
        .replace(/\r\n?/g, '\n')
        .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
      const token = makeTok('CODE', codeBlocks.length);
      const inTable = Boolean(pre.closest('td, th'));
      codeBlocks.push({
        inline: inTable,
        content: inTable ? wrapInlineCode(rawCode.replace(/\n+/g, ' ')) : makeFence(rawCode, lang)
      });
      pre.replaceWith(inTable ? token : `\n${token}\n`);
    });

    // 2. Extract inline <code> BEFORE removing <script>/<style> so <code><style></code> or <code><br></code> stays intact
    root.querySelectorAll('code').forEach((c) => {
      if (!c.isConnected) return;
      const txt = cleanText(serializePreChildren(c)).replace(/\r\n?/g, '\n').replace(/\n+/g, ' ');
      c.replaceWith(pushInlineCode(txt));
    });

    // 3. Remove non-math scripts, styles, noscript outside code blocks
    root.querySelectorAll('script:not([type^="math/tex"]), style, noscript').forEach((el) => el.remove());

    // 4. Embedded iframes, video, audio inside text blocks
    root.querySelectorAll('iframe').forEach((frame) => {
      const src = resolveStepikUrl(frame.getAttribute('src'));
      if (src) {
        const title = cleanText(frame.getAttribute('title') || 'Embedded media').trim();
        frame.replaceWith(`\n[${title}](${escapeMdUrl(src)})\n`);
      } else {
        frame.remove();
      }
    });

    root.querySelectorAll('video, audio').forEach((mediaEl) => {
      const rawSrc =
        mediaEl.getAttribute('src') ||
        mediaEl.querySelector('source[src]')?.getAttribute('src') ||
        '';
      const src = resolveStepikUrl(rawSrc);
      if (src) {
        const label = mediaEl.tagName === 'AUDIO' ? 'Audio' : 'Video';
        mediaEl.replaceWith(`\n[${label}](${escapeMdUrl(src)})\n`);
      } else {
        mediaEl.remove();
      }
    });

    // 5. LaTeX math
    root.querySelectorAll('.math-tex, script[type^="math/tex"]').forEach((el) => {
      let tex = cleanText(el.textContent).trim();
      if (!tex) {
        el.remove();
        return;
      }
      const inInlineOnly = Boolean(el.closest('td, th, li'));
      if (inInlineOnly) {
        tex = tex.replace(/\s*\n+\s*/g, ' ');
      }
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
      const token = makeTok('MATH', mathBlocks.length);
      mathBlocks.push(formatted);
      el.replaceWith(token);
    });

    // 6. Protect HTML/CSS tag literals decoded from &lt;...&gt; entities in prose text nodes
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let currNode;
    while ((currNode = walker.nextNode())) {
      textNodes.push(currNode);
    }
    for (const tNode of textNodes) {
      if (tNode.nodeValue && tNode.nodeValue.includes('<')) {
        tNode.nodeValue = protectInlineHtmlTags(tNode.nodeValue, pushInlineCode);
      }
    }

    const headingEls = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const lowestHeading = headingEls.length
      ? Math.min(...headingEls.map((h) => Number(h.tagName.slice(1))))
      : 1;

    const EM_START = `${TOK}M1${END}`;
    const STRONG_START = `${TOK}M2${END}`;

    const wrapMdInline = (el, tokMarker, ctx) => {
      const raw = cleanText(serializeChildren(el, ctx));
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      let txt = raw.trim();
      if (!txt) return raw;
      if (txt.startsWith('*') || txt.endsWith('*')) {
        txt = txt.replace(/^\*+|\*+$/g, (m) => '\\*'.repeat(m.length));
      }
      return `${lead}${tokMarker}${txt}${tokMarker}${trail}`;
    };

    const serializeTable = (table, ctx) => {
      const ownRows = Array.from(table.querySelectorAll('tr')).filter(
        (tr) => tr.closest('table') === table
      );
      const rows = ownRows
        .map((tr) =>
          Array.from(tr.children)
            .filter((cell) => cell.tagName === 'TD' || cell.tagName === 'TH')
            .map((cell) => {
              const rawCell = cleanText(serializeChildren(cell, { ...ctx, inTable: true }));
              const resolved = restoreTokens(rawCell)
                .replaceAll(EM_START, '*')
                .replaceAll(STRONG_START, '**');
              return resolved
                .replace(/\s*\n+\s*/g, ' ')
                .replace(/[ \t]{2,}/g, ' ')
                .replace(/\\\|/g, '|')
                .replace(/\|/g, '\\|')
                .trim();
            })
        )
        .filter((r) => r.length > 0);

      if (!rows.length) return '';
      const cols = Math.max(...rows.map((r) => r.length));
      const pad = (r) => [...r, ...Array(cols - r.length).fill('')];
      const header = `| ${pad(rows[0]).join(' | ')} |`;
      const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
      const body = rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`).join('\n');
      const token = makeTok('TBL', tableBlocks.length);
      tableBlocks.push(`\n${header}\n${sep}${body ? `\n${body}` : ''}\n`);
      return `\n${token}\n`;
    };

    const normalizeListParagraph = (raw) =>
      cleanText(raw)
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
        .filter(Boolean);

    const renderList = (listEl, indent = '', ctx = {}) => {
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
            const sub = renderList(node, childIndent, ctx);
            if (sub) segments.push({ type: 'list', content: sub });
          } else if (tag === 'BLOCKQUOTE' || tag === 'DETAILS') {
            flushInline();
            const rendered = serializeElement(node, ctx).trim();
            if (rendered) segments.push({ type: 'text', content: rendered });
          } else if (tag === 'P' || tag === 'DIV') {
            flushInline();
            if (node.querySelector('ul, ol, blockquote, details, table')) {
              Array.from(node.childNodes).forEach(walkLiChild);
              flushInline();
            } else {
              inlineBuf += serializeChildren(node, ctx);
              flushInline();
            }
          } else if (tag === 'TABLE') {
            flushInline();
            const tbl = serializeTable(node, ctx).trim();
            if (tbl) segments.push({ type: 'text', content: tbl });
          } else {
            inlineBuf += serializeElement(node, ctx);
          }
        };

        Array.from(li.childNodes).forEach(walkLiChild);
        flushInline();

        if (!segments.length) return;

        let emittedMarker = false;
        const codeTokenRe = new RegExp(`^${TOK}CODE_\\d+${END}$`);
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
            if (codeTokenRe.test(text)) {
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

    const formatBlockquoteString = (innerRaw) => {
      let resolved = restoreTokens(innerRaw)
        .replaceAll(EM_START, '*')
        .replaceAll(STRONG_START, '**');
      resolved = cleanText(resolved)
        .replace(/\r\n?/g, '\n')
        .replace(/^[ \t]+/gm, (m) => m) // keep code/list indentation inside blockquote
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (!resolved) return '';
      const quoted = resolved
        .split('\n')
        .map((line) => {
          const trimmedEnd = line.replace(/[ \t]+$/, '');
          return trimmedEnd ? `> ${trimmedEnd}` : '>';
        })
        .join('\n');
      const token = makeTok('QUOTE', quoteBlocks.length);
      quoteBlocks.push(`\n${quoted}\n`);
      return `\n${token}\n`;
    };

    const serializeChildren = (el, ctx = {}) =>
      Array.from(el.childNodes)
        .map((child) => serializeNode(child, ctx))
        .join('');

    const serializeNode = (node, ctx = {}) => {
      if (node.nodeType === Node.TEXT_NODE) return cleanText(node.nodeValue || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      return serializeElement(node, ctx);
    };

    const serializeElement = (el, ctx = {}) => {
      const tag = el.tagName.toUpperCase();
      if (tag === 'BR') {
        if (el.nextSibling?.nodeType === Node.TEXT_NODE) {
          el.nextSibling.nodeValue = el.nextSibling.nodeValue.replace(/^[ \t]*\r?\n/, '');
        }
        return '\n';
      }
      if (tag === 'HR') return '\n---\n';
      if (tag === 'IMG') {
        const src = resolveStepikUrl(el.getAttribute('src'));
        if (!src) return '';
        const alt = cleanText(el.getAttribute('alt') || el.getAttribute('title') || '')
          .trim()
          .replace(/[\[\]]/g, '\\$&');
        return ctx.inTable
          ? `![${alt}](${escapeMdUrl(src)})`
          : `\n![${alt}](${escapeMdUrl(src)})\n`;
      }
      if (tag === 'SUP' || tag === 'SUB') {
        const inner = cleanText(serializeChildren(el, ctx)).trim();
        if (!inner) return '';
        const token = makeTok('SUB', subSupBlocks.length);
        subSupBlocks.push(`<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`);
        return token;
      }
      if (tag === 'EM' || tag === 'I') return wrapMdInline(el, EM_START, ctx);
      if (tag === 'STRONG' || tag === 'B') return wrapMdInline(el, STRONG_START, ctx);
      if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return wrapMdInline(el, '~~', ctx);
      if (tag === 'A') {
        const href = resolveStepikUrl(el.getAttribute('href'));
        const raw = serializeChildren(el, ctx);
        const lead = raw.match(/^\s*/)[0];
        const trail = raw.match(/\s*$/)[0];
        const txt = raw.trim();
        if (!href) return raw;
        if (!txt || txt === href) return `${lead}${escapeMdUrl(href)}${trail}`;
        return `${lead}[${txt}](${escapeMdUrl(href)})${trail}`;
      }
      if (/^H[1-6]$/.test(tag)) {
        const orig = Number(tag.slice(1));
        const shifted = Math.min(6, Math.max(orig, minHeadingLevel + (orig - lowestHeading)));
        const txt = cleanText(serializeChildren(el, ctx))
          .replace(/\s+/g, ' ')
          .trim();
        return txt ? `\n${'#'.repeat(shifted)} ${txt}\n` : '\n';
      }
      if (tag === 'SUMMARY') {
        const txt = cleanText(serializeChildren(el, ctx))
          .replaceAll(STRONG_START, '')
          .replace(/\*\*/g, '')
          .replace(/[ \t]{2,}/g, ' ')
          .trim();
        return txt ? `\n**${txt}**\n` : '\n';
      }
      if (tag === 'DETAILS') {
        const summaryEl = Array.from(el.children).find((c) => c.tagName === 'SUMMARY');
        const summaryTxt = summaryEl
          ? cleanText(serializeChildren(summaryEl, ctx))
              .replaceAll(STRONG_START, '')
              .replace(/\*\*/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          : '';
        const bodyRaw = Array.from(el.childNodes)
          .filter((c) => c !== summaryEl)
          .map((c) => serializeNode(c, ctx))
          .join('');
        const bodyResolved = normalizeBlankLines(
          restoreTokens(bodyRaw).replaceAll(EM_START, '*').replaceAll(STRONG_START, '**')
        );
        const headingLine = `**${summaryTxt || 'Спойлер'}**`;
        const combined = bodyResolved ? `${headingLine}\n\n${bodyResolved}` : headingLine;
        return formatBlockquoteString(combined);
      }
      if (tag === 'BLOCKQUOTE') {
        return formatBlockquoteString(serializeChildren(el, ctx));
      }
      if (tag === 'TABLE') {
        return serializeTable(el, ctx);
      }
      if (tag === 'UL' || tag === 'OL') {
        const rendered = renderList(el, '', ctx);
        if (!rendered) return '';
        const token = makeTok('LIST', listBlocks.length);
        listBlocks.push(`\n${rendered}\n`);
        return `\n${token}\n`;
      }
      if (
        tag === 'P' ||
        tag === 'DIV' ||
        tag === 'SECTION' ||
        tag === 'ARTICLE' ||
        tag === 'HEADER' ||
        tag === 'FOOTER' ||
        tag === 'FIGURE' ||
        tag === 'FIGCAPTION'
      ) {
        const inner = serializeChildren(el, ctx);
        if (ctx.inTable) return ` ${inner} `;
        return inner.trim() ? `\n${inner}\n` : '\n';
      }
      return serializeChildren(el, ctx);
    };

    const rawSerialized = cleanText(serializeChildren(root, {}));
    let result = rawSerialized
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]+/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    result = restoreTokens(result)
      .replaceAll(EM_START, '*')
      .replaceAll(STRONG_START, '**');

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

  async function fetchJsonWithRetry(
    url,
    { signal, onRateLimit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {},
    retries = 4
  ) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const now = Date.now();
      if (globalRateLimitUntil > now) {
        await sleep(globalRateLimitUntil - now, signal);
      }

      const reqCtrl = new AbortController();
      let timedOut = false;
      const onParentAbort = () => reqCtrl.abort();
      signal?.addEventListener('abort', onParentAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        reqCtrl.abort();
      }, timeoutMs);

      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'same-origin',
          signal: reqCtrl.signal
        });

        if (res.status === 429) {
          if (attempt === retries) {
            const err = new Error('HTTP 429: Stepik API rate limit exceeded');
            err.status = 429;
            throw err;
          }
          const waitMs = parseRetryAfterMs(res.headers.get('Retry-After'), attempt);
          globalRateLimitUntil = Math.max(globalRateLimitUntil, Date.now() + waitMs);
          if (onRateLimit) onRateLimit(Math.ceil((globalRateLimitUntil - Date.now()) / 1000));
          await sleep(Math.max(0, globalRateLimitUntil - Date.now()), signal);
          continue;
        }

        if ((res.status === 408 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) && attempt < retries) {
          await sleep(1500 * (attempt + 1) + Math.floor(Math.random() * 400), signal);
          continue;
        }

        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} (${url})`);
          err.status = res.status;
          throw err;
        }

        return await res.json();
      } catch (e) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const isRetryableNet = timedOut || e.name === 'TypeError' || e.name === 'AbortError';
        if (isRetryableNet && attempt < retries) {
          await sleep(1200 * (attempt + 1) + Math.floor(Math.random() * 400), signal);
          continue;
        }
        if (timedOut) {
          const err = new Error(`Request timeout (${url})`);
          err.status = 408;
          throw err;
        }
        throw e;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onParentAbort);
      }
    }
    throw new Error(`Exhausted retries (${url})`);
  }

  async function fetchIdChunkWithBisection(endpoint, resourceKey, chunk, opts) {
    const query = chunk.map((id) => `ids[]=${id}`).join('&');
    try {
      const collected = [];
      let page = 1;
      while (true) {
        const pageSuffix = page > 1 ? `&page=${page}` : '';
        const data = await fetchJsonWithRetry(`/api/${endpoint}?${query}${pageSuffix}`, opts);
        collected.push(...(data[resourceKey] || []));
        if (!data.meta?.has_next) break;
        page++;
      }
      return collected;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (opts.allowPartial && (e.status === 403 || e.status === 404)) {
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          const left = await fetchIdChunkWithBisection(endpoint, resourceKey, chunk.slice(0, mid), opts);
          const right = await fetchIdChunkWithBisection(endpoint, resourceKey, chunk.slice(mid), opts);
          return [...left, ...right];
        }
        console.warn(`[Stepik MD] Skipped restricted ${endpoint} id=${chunk[0]} (${e.status})`);
        return [];
      }
      throw e;
    }
  }

  async function fetchBatchedByIds(endpoint, resourceKey, ids, opts = {}) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    const results = [];
    for (let i = 0; i < uniqueIds.length; i += 50) {
      const chunk = uniqueIds.slice(i, i + 50);
      const chunkItems = await fetchIdChunkWithBisection(endpoint, resourceKey, chunk, opts);
      results.push(...chunkItems);
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
      const active =
        attempts.find((a) => a.status === 'active') ||
        attempts.reduce((best, cur) => ((cur.id || 0) >= (best?.id || 0) ? cur : best), attempts[0]);
      if (active?.dataset && typeof active.dataset === 'object') {
        return active.dataset;
      }
      if (active?.dataset_url) {
        const dsUrl = resolveStepikUrl(active.dataset_url);
        if (dsUrl.startsWith(STEPIK_ORIGIN) || dsUrl.startsWith('/')) {
          return await fetchJsonWithRetry(dsUrl, opts);
        }
      }
      return null;
    } catch (e) {
      if (e.name === 'AbortError' || e.status === 429 || e.status === 401 || e.status === 403) {
        throw e;
      }
      return null;
    }
  }

  // --- Step Markdown Renderer ---

  function decodeHtmlEntities(str) {
    const doc = new DOMParser().parseFromString(str, 'text/html');
    return cleanText(doc.body.textContent || '');
  }

  function looksLikeStandaloneHtmlSnippet(raw) {
    if (!raw || /<[a-zA-Z!/]/.test(raw)) return false;
    if (!/&lt;\/?[a-zA-Z!]/.test(raw)) return false;
    const decoded = decodeHtmlEntities(raw).trim();
    return decoded.startsWith('<') && decoded.endsWith('>') && /<\/?[a-zA-Z!]/.test(decoded);
  }

  function wrapTagTextIfNeeded(txt) {
    if (!txt || !txt.includes('<')) return txt;
    if (/^(?:<!--[\s\S]*-->|<!DOCTYPE\b[^>]*>|<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>)$/.test(txt)) {
      return wrapInlineCode(txt);
    }
    return txt.replace(INLINE_HTML_TAG_RE, (full, lead, tag) => `${lead}${wrapInlineCode(tag)}`);
  }

  function renderOptionText(raw, isHtmlEnabled) {
    if (raw == null) return '';
    const str = String(raw);
    if (isHtmlEnabled === false) {
      return wrapTagTextIfNeeded(cleanText(str).trim());
    }
    if (looksLikeStandaloneHtmlSnippet(str)) {
      return wrapInlineCode(decodeHtmlEntities(str).trim().replace(/\s*\n+\s*/g, ' '));
    }
    return htmlToMd(str).replace(/\n+/g, ' ');
  }

  function renderFillBlankText(raw, isHtmlEnabled) {
    if (raw == null) return '';
    const str = String(raw);
    if (isHtmlEnabled === false) {
      return wrapTagTextIfNeeded(cleanText(str).replace(/\r\n?/g, '\n'));
    }
    const parts = str.split(/<br\s*\/?>/gi);
    return parts
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return '';
        return htmlToMd(part).replace(/\n+/g, ' ');
      })
      .join('\n');
  }

  function isGenericCodeStub(tpl) {
    const nonEmpty = tpl
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (!nonEmpty.length) return true;
    return nonEmpty.every((line) =>
      /^(?:\/\/|#|;;|--|%|\/\*|\*\/|<!--)\s*put your .*code here\s*(?:\*\/|-->)?$/i.test(line)
    );
  }

  function needsAttemptDataset(step) {
    const t = step.block?.name;
    const o = step.block?.options || {};
    return INTERACTIVE_TYPES.has(t) && !o.options && !o.pairs && !o.rows && !o.components && !o.lines;
  }

  function renderStepMarkdown(step, dataset, headingLevel = 2, { quizAbortedByRateLimit = false } = {}) {
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

    if (type === 'video') {
      if (block.video) {
        const urls = [...(block.video.urls || [])].sort((a, b) => {
          const qa = parseInt(a.quality, 10) || 0;
          const qb = parseInt(b.quality, 10) || 0;
          return qb - qa;
        });
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
      } else {
        md += `*Видео недоступно.*\n\n`;
      }
    }

    if (block.text) {
      const bodyMd = htmlToMd(block.text, { minHeadingLevel: Math.min(6, headingLevel + 1) });
      if (bodyMd) md += `${bodyMd}\n\n`;
    }

    const notLoadedReason = quizAbortedByRateLimit
      ? 'не загружены (превышен лимит запросов Stepik API 429)'
      : 'не загружены (попытка ещё не создавалась)';

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
        md += `*Варианты ответа${mode ? ` (${mode})` : ''}: ${notLoadedReason}.*\n\n`;
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
        md += `*Пары для сопоставления ${notLoadedReason}.*\n\n`;
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
        md += `*Элементы для сортировки ${notLoadedReason}.*\n\n`;
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
        md += `*Таблица выбора ${notLoadedReason}.*\n\n`;
      }
    }

    if (type === 'fill-blanks') {
      const components = ds.components || opts.components;
      if (components?.length) {
        md += `**Шаблон с пропусками${ds.is_case_sensitive ? ' (учитывается регистр)' : ''}:**\n`;
        const parts = components.map((c) => {
          if (c.type === 'text') return renderFillBlankText(c.text, isHtmlEnabled);
          if (c.type === 'select') {
            const choices = (c.options || []).map((o) => wrapTagTextIfNeeded(cleanText(o).trim()));
            return `[Выбор: ${choices.join(' / ')}]`;
          }
          return '[____]';
        });
        let templateText = '';
        for (const p of parts) {
          if (!p) continue;
          if (!templateText || templateText.endsWith('\n') || p.startsWith('\n')) {
            templateText += p;
          } else {
            templateText += ` ${p}`;
          }
        }
        md += `${templateText.replace(/\n{2,}/g, '\n').trim()}\n\n`;
      } else {
        md += `*Шаблон с пропусками ${notLoadedReason}.*\n\n`;
      }
    }

    if (type === 'html') {
      const htmlTpl = cleanText(opts.html_template || '')
        .replace(/\r\n?/g, '\n')
        .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
      const cssTpl = cleanText(opts.css_template || '')
        .replace(/\r\n?/g, '\n')
        .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
      if (htmlTpl) {
        md += `**Шаблон HTML:**\n${makeFence(htmlTpl, 'html')}\n\n`;
      }
      if (cssTpl) {
        md += `**Шаблон CSS:**\n${makeFence(cssTpl, 'css')}\n\n`;
      }
      if (Array.isArray(opts.checklist) && opts.checklist.length) {
        const items = opts.checklist
          .map((item) => wrapTagTextIfNeeded(cleanText(item?.name || '').replace(/\s+/g, ' ').trim()))
          .filter(Boolean);
        if (items.length) {
          md += `**Критерии проверки:**\n${items.map((x) => `* ${x}`).join('\n')}\n\n`;
        }
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
    } else if (type === 'dataset') {
      const dsUrl = ds.dataset_url || opts.dataset_url;
      md += dsUrl
        ? `*Формат ответа: файл данных (${resolveStepikUrl(dsUrl)})*\n\n`
        : `*Формат ответа: файл данных (dataset)*\n\n`;
    }

    if (type === 'code' || type === 'sql' || opts.limits || opts.execution_time_limit || opts.execution_memory_limit) {
      const limitEntries = opts.limits && typeof opts.limits === 'object' ? Object.entries(opts.limits) : [];
      if (limitEntries.length > 0 && limitEntries.length <= 5) {
        const formattedLimits = limitEntries
          .map(([lang, lim]) => `${lang} (${lim?.time ?? opts.execution_time_limit ?? '?'}с, ${lim?.memory ?? opts.execution_memory_limit ?? '?'} МБ)`)
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
      const validSamples = opts.samples.filter((s) => Array.isArray(s));
      if (validSamples.length) {
        md += `**Примеры:**\n`;
        validSamples.forEach(([inp, out], idx) => {
          const cleanIn = cleanText(inp).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
          const cleanOut = cleanText(out).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
          const sampleBody = `Вход:\n${cleanIn || '(пусто)'}\nВыход:\n${cleanOut || '(пусто)'}`;
          md += `*Тест ${idx + 1}:*\n${makeFence(sampleBody, 'text')}\n`;
        });
        md += '\n';
      }
    }

    const headerCounts = opts.code_templates_header_lines_count || {};
    const footerCounts = opts.code_templates_footer_lines_count || {};
    if (opts.code_templates && typeof opts.code_templates === 'object') {
      const hiddenMeta = [];
      const groupedTemplates = new Map();

      for (const [lang, tpl] of Object.entries(opts.code_templates)) {
        const cleanedTpl = cleanText(tpl)
          .replace(/\r\n?/g, '\n')
          .replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '');
        const hCount = Number(headerCounts[lang]) || 0;
        const fCount = Number(footerCounts[lang]) || 0;
        const metaParts = [];
        if (hCount > 0) metaParts.push(`скрытый header: ${hCount} стр.`);
        if (fCount > 0) metaParts.push(`скрытый footer: ${fCount} стр.`);

        if (cleanedTpl && !isGenericCodeStub(cleanedTpl)) {
          const fenceLang = normalizeLang(lang);
          const suffix = metaParts.length ? ` — ${metaParts.join(', ')}` : '';
          const groupKey = `${fenceLang}\u0000${suffix}\u0000${cleanedTpl}`;
          if (!groupedTemplates.has(groupKey)) {
            groupedTemplates.set(groupKey, { langs: [lang], fenceLang, suffix, code: cleanedTpl });
          } else {
            groupedTemplates.get(groupKey).langs.push(lang);
          }
        } else if (metaParts.length) {
          hiddenMeta.push(`${lang}: ${metaParts.join(', ')}`);
        }
      }

      for (const item of groupedTemplates.values()) {
        md += `**Шаблон кода (${item.langs.join(', ')}${item.suffix}):**\n${makeFence(item.code, item.fenceLang)}\n\n`;
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

    const courseMatch = window.location.pathname.match(COURSE_PATH_RE);
    if (courseMatch) {
      return { courseId: courseMatch[1], currentSectionId: null };
    }

    const unitParam = new URLSearchParams(window.location.search).get('unit');
    if (unitParam && /^\d+$/.test(unitParam)) {
      try {
        const unitData = await fetchJsonWithRetry(`/api/units/${unitParam}`, { signal });
        const sectionId = unitData.units?.[0]?.section;
        if (sectionId) {
          currentSectionId = sectionId;
          const secData = await fetchJsonWithRetry(`/api/sections/${sectionId}`, { signal });
          const resolved = secData.sections?.[0]?.course;
          if (resolved) courseId = String(resolved);
        }
      } catch (e) {
        if (e.name === 'AbortError') throw e;
      }
    }

    const lessonMatch = window.location.pathname.match(LESSON_PATH_RE);
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

    if (!courseId) {
      const scopedSelectors = [
        '.lesson-sidebar__course-title[href*="/course/"]',
        '.lesson-sidebar a[href*="/course/"]'
      ];
      for (const sel of scopedSelectors) {
        const link = document.querySelector(sel);
        const m = link?.getAttribute('href')?.match(COURSE_PATH_RE);
        if (m) {
          courseId = m[1];
          break;
        }
      }
    }

    if (!courseId) throw new Error('Could not resolve course ID');
    return { courseId, currentSectionId };
  }

  function raceWithAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (val) => {
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
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
      const loaded = await raceWithAbort(modulesCache.loadingPromise, signal);
      return { ...loaded, currentSectionId };
    }

    const loadPromise = (async () => {
      const courseData = await fetchJsonWithRetry(`/api/courses/${courseId}`);
      const course = courseData.courses?.[0];
      if (!course) throw new Error('Course not found');

      const sections = await fetchBatchedByIds('sections', 'sections', course.sections || [], {
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
      const loaded = await raceWithAbort(loadPromise, signal);
      return { ...loaded, currentSectionId };
    } finally {
      if (modulesCache.loadingPromise === loadPromise) {
        modulesCache.loadingCourseId = null;
        modulesCache.loadingPromise = null;
      }
    }
  }

  async function buildLessonMarkdown({ onProgress, signal } = {}) {
    const match = window.location.pathname.match(LESSON_PATH_RE);
    if (!match) throw new Error('Lesson ID not found in URL');
    const lessonId = match[1];

    const netOpts = {
      signal,
      onRateLimit: onProgress ? (sec) => onProgress(`Rate ${sec}s...`, 'warn') : undefined,
      allowPartial: true
    };

    const dataLesson = await fetchJsonWithRetry(`/api/lessons/${lessonId}`, netOpts);
    const lesson = dataLesson.lessons?.[0];
    if (!lesson) throw new Error('Unable to load lesson metadata');

    const allSteps = await fetchBatchedByIds('steps', 'steps', lesson.steps || [], netOpts);
    allSteps.sort((a, b) => a.position - b.position);

    const datasets = new Map();
    const quizSteps = allSteps.filter(needsAttemptDataset);
    let quizAbortedByRateLimit = false;

    if (quizSteps.length > 0) {
      await runWithConcurrency(
        quizSteps,
        3,
        async (s) => {
          if (quizAbortedByRateLimit) return;
          try {
            const ds = await fetchAttemptDataset(s.id, netOpts);
            if (ds) datasets.set(s.id, ds);
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (e.status === 429) quizAbortedByRateLimit = true;
          }
        },
        signal
      );
    }

    const courseTitle = document.querySelector('.lesson-sidebar__course-title')?.textContent?.trim();
    const lessonHeader = document.querySelector('.top-tools__lesson-name')?.textContent?.replace(/\s+/g, ' ').trim();
    const title = cleanText(lessonHeader || lesson.title || `Урок ${lessonId}`).trim();

    let md = `# ${title}\n`;
    if (courseTitle) md += `*Курс: ${cleanText(courseTitle).trim()}*\n`;
    md += '\n';

    for (const step of allSteps) {
      const needsQuiz = needsAttemptDataset(step) && !datasets.has(step.id);
      md += renderStepMarkdown(step, datasets.get(step.id), 2, {
        quizAbortedByRateLimit: quizAbortedByRateLimit && needsQuiz
      });
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

    // Strictly passive GET lookup for already-created quiz attempts (with 429 circuit-breaker)
    const quizSteps = allSteps.filter(needsAttemptDataset);
    const datasets = new Map();
    let quizAbortedByRateLimit = false;
    if (quizSteps.length > 0) {
      let doneQuizzes = 0;
      onProgress(`Quizzes 0/${quizSteps.length}...`, 'busy');
      await runWithConcurrency(
        quizSteps,
        2,
        async (s) => {
          if (quizAbortedByRateLimit) return;
          try {
            const ds = await fetchAttemptDataset(s.id, netOpts);
            if (ds) datasets.set(s.id, ds);
          } catch (e) {
            if (e.name === 'AbortError') throw e;
            if (e.status === 429) {
              quizAbortedByRateLimit = true;
              onProgress('Quizzes skipped (429)...', 'warn');
              return;
            }
          }
          doneQuizzes++;
          if (doneQuizzes % 5 === 0 || doneQuizzes === quizSteps.length) {
            onProgress(`Quizzes ${doneQuizzes}/${quizSteps.length}...`, 'busy');
          }
          await sleep(180, signal);
        },
        signal
      );
    }

    return { unitsBySection, lessonsMap, stepsMap, datasets, quizAbortedByRateLimit };
  }

  function renderSectionBlock(
    sec,
    sectionNum,
    { unitsBySection, lessonsMap, stepsMap, datasets, quizAbortedByRateLimit }
  ) {
    const secTitle = cleanText(sec.title || `Модуль ${sectionNum}`).trim();
    const examBadge = sec.is_exam ? ' [Экзамен]' : '';
    let tocLines = `* **Модуль ${sectionNum}. ${secTitle}${examBadge}**\n`;
    let body = `## Модуль ${sectionNum}. ${secTitle}${examBadge}\n\n`;
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
      const lessonSteps = (lesson.steps || [])
        .map((id) => stepsMap.get(id))
        .filter(Boolean)
        .sort((a, b) => a.position - b.position);

      if (!lessonSteps.length && lesson.is_public === false) {
        tocLines += `  * ${lessonNum} ${lessonTitle} *[Закрыт]*\n`;
        body += `### Урок ${lessonNum}. ${lessonTitle} [Закрыт]\n\n*Урок закрыт (требуется запись на курс или оплата).*\n\n`;
        return;
      }

      tocLines += `  * ${lessonNum} ${lessonTitle}\n`;
      body += `### Урок ${lessonNum}. ${lessonTitle}\n\n`;
      exportedLessons++;

      if (!lessonSteps.length) {
        body += `*В уроке нет доступных шагов.*\n\n`;
      } else {
        for (const step of lessonSteps) {
          const needsQuiz = needsAttemptDataset(step) && !datasets.has(step.id);
          body += renderStepMarkdown(step, datasets.get(step.id), 4, {
            quizAbortedByRateLimit: quizAbortedByRateLimit && needsQuiz
          });
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

  const isLessonPage = () => LESSON_PATH_RE.test(window.location.pathname);
  const isCoursePage = () => COURSE_PATH_RE.test(window.location.pathname);
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
      max-height: calc(100vh - 64px);
      overflow-y: auto;
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
    const routeCourseMatch = window.location.pathname.match(COURSE_PATH_RE);
    const courseChanged = Boolean(routeCourseMatch && sel.dataset.courseId && sel.dataset.courseId !== routeCourseMatch[1]);
    const alreadyLoadedForPage =
      !courseChanged &&
      sel.options.length > 0 &&
      sel.dataset.courseId &&
      sel.dataset.courseId === modulesCache.courseId &&
      sel.dataset.urlKey === currentUrlKey &&
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
            : sec.is_active === false || sec.is_requirement_satisfied === false
              ? ' (locked)'
              : sec.is_exam
                ? ' (exam)'
                : '';
          opt.textContent = `${idx + 1}. ${title}${suffix}`;
          sel.appendChild(opt);
        });

        sel.dataset.courseId = courseId;
        sel.disabled = false;
      }

      sel.dataset.urlKey = currentUrlKey;

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
    if (lessonResetTimer) {
      clearTimeout(lessonResetTimer);
      lessonResetTimer = null;
    }
    ui.copyBtn.disabled = true;
    ui.dlBtn.disabled = true;
    ui.copyLabel.textContent = 'Copying...';
    setWidgetStatus('Copying...', 'busy');

    try {
      const { md, count } = await buildLessonMarkdown({
        onProgress: (msg, state) => setWidgetStatus(msg, state)
      });
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
      lessonResetTimer = setTimeout(() => {
        lessonResetTimer = null;
        if (ui && !isLessonBusy) {
          ui.copyBtn.disabled = false;
          ui.dlBtn.disabled = false;
          ui.copyLabel.textContent = 'Copy Lesson';
        }
      }, 1800);
    }
  }

  async function handleDownloadLesson() {
    if (!ui || isLessonBusy || !isLessonPage()) return;
    isLessonBusy = true;
    if (lessonResetTimer) {
      clearTimeout(lessonResetTimer);
      lessonResetTimer = null;
    }
    ui.copyBtn.disabled = true;
    ui.dlBtn.disabled = true;
    ui.dlLabel.textContent = 'Exporting...';
    setWidgetStatus('Exporting...', 'busy');

    try {
      const { md, lessonId, title } = await buildLessonMarkdown({
        onProgress: (msg, state) => setWidgetStatus(msg, state)
      });
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
      lessonResetTimer = setTimeout(() => {
        lessonResetTimer = null;
        if (ui && !isLessonBusy) {
          ui.copyBtn.disabled = false;
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

    const isEditableTarget = (target) => {
      const el = target instanceof Element ? target : document.activeElement;
      if (!el) return false;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return Boolean(el.closest('.cm-editor, .CodeMirror, .ace_editor'));
    };

    document.addEventListener('keydown', (e) => {
      if (!isSupportedPage()) return;
      if (e.key === 'Escape' && ui?.isOpen) {
        setMenuOpen(false);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        if (isEditableTarget(e.target)) return;
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