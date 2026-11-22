(() => {
  'use strict';

  const BAR_ID = 'st-md-floating-bar';
  const COPY_BTN_ID = 'st-md-copy-btn';
  const INTERACTIVE_TYPES = new Set(['choice', 'matching', 'sorting', 'table', 'fill-blanks']);
  const JUNK_LANGS = new Set(['no-highlight', 'nohighlight', 'undefined', 'none', 'plain', 'plaintext', 'text']);

  const cleanText = (str) =>
    (str || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '');

  const normalizeLang = (lang) => {
    if (!lang) return '';
    const l = lang.toLowerCase().trim();
    if (JUNK_LANGS.has(l)) return '';
    if (/^python/.test(l)) return 'python';
    if (/^(c\+\+|cpp)/.test(l)) return 'cpp';
    if (/^(c#|csharp)/.test(l)) return 'csharp';
    if (/^(sh|shell|bash|zsh)/.test(l)) return 'bash';
    if (/^(js|javascript)/.test(l)) return 'javascript';
    if (/^(ts|typescript)/.test(l)) return 'typescript';
    if (/^(postgres|mysql|sqlite|sql)/.test(l)) return 'sql';
    return l.replace(/[\d.]+$/, '') || l;
  };

  function htmlToMd(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const root = doc.body;

    root.querySelectorAll('.copy-code-btn, script:not([type^="math/tex"]), style, noscript').forEach((el) => el.remove());

    // 1. Блоки кода <pre> -> плейсхолдеры
    const codeBlocks = [];
    root.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      const cls = `${codeEl?.className || ''} ${pre.className || ''}`;
      const m = cls.match(/(?:language|lang)-([a-zA-Z0-9_+#.-]+)/);
      const lang = m ? normalizeLang(m[1]) : '';
      const rawCode = cleanText((codeEl || pre).textContent)
        .replace(/\r\n?/g, '\n')
        .replace(/^\n+|\n+$/g, '');
      const token = `___CODE_BLOCK_${codeBlocks.length}___`;
      codeBlocks.push(`\n\`\`\`${lang}\n${rawCode}\n\`\`\`\n`);
      pre.replaceWith(token);
    });

    // 2. LaTeX-формулы -> плейсхолдеры
    const mathBlocks = [];
    root.querySelectorAll('.math-tex, script[type^="math/tex"]').forEach((el) => {
      let tex = cleanText(el.textContent).trim();
      if (!tex) {
        el.remove();
        return;
      }
      let formatted;
      if (tex.startsWith('\\[') && tex.endsWith('\\]')) {
        formatted = `\n$$\n${tex.slice(2, -2).trim()}\n$$\n`;
      } else if (tex.startsWith('\\(') && tex.endsWith('\\)')) {
        formatted = `$${tex.slice(2, -2).trim()}$`;
      } else if (tex.startsWith('$$') && tex.endsWith('$$')) {
        formatted = `\n$$\n${tex.slice(2, -2).trim()}\n$$\n`;
      } else if (tex.startsWith('$') && tex.endsWith('$')) {
        formatted = tex;
      } else if (el.tagName === 'SCRIPT' && (el.getAttribute('type') || '').includes('display')) {
        formatted = `\n$$\n${tex}\n$$\n`;
      } else {
        formatted = `$${tex}$`;
      }
      const token = `___MATH_BLOCK_${mathBlocks.length}___`;
      mathBlocks.push(formatted);
      el.replaceWith(token);
    });

    // 3. Инлайн-код <code> -> плейсхолдеры
    const inlineCodes = [];
    root.querySelectorAll('code').forEach((c) => {
      const txt = cleanText(c.textContent);
      const wrapped = txt.includes('`') ? `\`\` ${txt} \`\`` : `\`${txt}\``;
      const token = `___INLINE_CODE_${inlineCodes.length}___`;
      inlineCodes.push(wrapped);
      c.replaceWith(token);
    });

    // 4. Изображения
    root.querySelectorAll('img').forEach((img) => {
      const src = (img.getAttribute('src') || '').trim();
      if (!src) {
        img.remove();
        return;
      }
      const alt = cleanText(img.getAttribute('alt') || '').trim();
      const inInlineCtx = Boolean(img.closest('td, th, li'));
      img.replaceWith(inInlineCtx ? `![${alt}](${src})` : `\n![${alt}](${src})\n`);
    });

    // 5. Инлайн-форматирование (от внутренних узлов к внешним, с сохранением пробелов)
    const wrapInline = (selector, marker) => {
      Array.from(root.querySelectorAll(selector))
        .reverse()
        .forEach((el) => {
          const raw = cleanText(el.textContent);
          const lead = raw.match(/^\s*/)[0];
          const trail = raw.match(/\s*$/)[0];
          const txt = raw.trim();
          el.replaceWith(txt ? `${lead}${marker}${txt}${marker}${trail}` : raw);
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

    // 6. Таблицы -> плейсхолдеры
    const tableBlocks = [];
    root.querySelectorAll('table').forEach((table) => {
      const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('th, td')).map((cell) => {
          cell.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
          return cleanText(cell.textContent)
            .replace(/\s*\n+\s*/g, ' ')
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\|/g, '\\|')
            .trim();
        })
      ).filter((r) => r.length > 0);

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

    // 7. Спойлеры <details>/<summary>, заголовки, цитаты, <hr>
    root.querySelectorAll('summary').forEach((s) => {
      const txt = cleanText(s.textContent).replace(/\*\*/g, '').trim();
      s.replaceWith(txt ? `\n**${txt}**\n` : '\n');
    });

    root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h) => {
      const level = '#'.repeat(Number(h.tagName.slice(1)));
      const txt = cleanText(h.textContent).replace(/\s+/g, ' ').trim();
      h.replaceWith(txt ? `\n${level} ${txt}\n` : '');
    });

    root.querySelectorAll('blockquote').forEach((bq) => {
      const lines = cleanText(bq.textContent)
        .trim()
        .split('\n')
        .map((l) => `> ${l.trim()}`)
        .join('\n');
      bq.replaceWith(lines ? `\n${lines}\n` : '');
    });

    root.querySelectorAll('hr').forEach((hr) => hr.replaceWith('\n---\n'));

    // 8. Вложенные списки -> плейсхолдеры (2 пробела на уровень, без ложных code-блоков)
    const listBlocks = [];
    const renderList = (listEl, depth = 0) => {
      const isOrdered = listEl.tagName === 'OL';
      const indent = '  '.repeat(depth);
      let index = Number(listEl.getAttribute('start')) || 1;
      const lines = [];

      Array.from(listEl.children).forEach((li) => {
        if (li.tagName !== 'LI') return;
        const subLists = [];
        Array.from(li.children).forEach((child) => {
          if (child.tagName === 'UL' || child.tagName === 'OL') {
            subLists.push(renderList(child, depth + 1));
            child.remove();
          }
        });
        li.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
        const marker = isOrdered ? `${index++}.` : '*';
        const text = cleanText(li.textContent)
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/^[·•▪◦]\s*/, '');
        if (text) lines.push(`${indent}${marker} ${text}`);
        if (subLists.length) lines.push(...subLists);
      });

      return lines.join('\n');
    };

    root.querySelectorAll('ul, ol').forEach((list) => {
      if (list.isConnected && !list.parentElement?.closest('ul, ol')) {
        const rendered = renderList(list, 0);
        if (rendered) {
          const token = `___LIST_BLOCK_${listBlocks.length}___`;
          listBlocks.push(`\n${rendered}\n`);
          list.replaceWith(token);
        } else {
          list.remove();
        }
      }
    });

    // 9. Параграфы и переносы строк
    root.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
    root.querySelectorAll('p').forEach((p) => {
      const txt = cleanText(p.textContent).trim();
      p.replaceWith(txt ? `\n${txt}\n` : '\n');
    });

    // 10. Финальная сборка и восстановление плейсхолдеров (через () => block, чтобы не ломать $$)
    let result = cleanText(root.textContent)
      .replace(/\r\n?/g, '\n')
      .replace(/^[ \t]+/gm, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    listBlocks.forEach((b, i) => {
      result = result.replace(`___LIST_BLOCK_${i}___`, () => b);
    });
    tableBlocks.forEach((b, i) => {
      result = result.replace(`___TABLE_BLOCK_${i}___`, () => b);
    });
    codeBlocks.forEach((b, i) => {
      result = result.replace(`___CODE_BLOCK_${i}___`, () => b);
    });
    mathBlocks.forEach((b, i) => {
      result = result.replace(`___MATH_BLOCK_${i}___`, () => b);
    });
    inlineCodes.forEach((b, i) => {
      result = result.replace(`___INLINE_CODE_${i}___`, () => b);
    });

    return result.replace(/\n{3,}/g, '\n\n').trim();
  }

  function formatDuration(sec) {
    if (!sec || !Number.isFinite(sec)) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  async function fetchAttemptDataset(stepId) {
    try {
      const res = await fetch(`/api/attempts?step=${stepId}`, { credentials: 'same-origin' });
      if (!res.ok) return null;
      const data = await res.json();
      const attempts = data.attempts || [];
      if (!attempts.length) return null;
      const active = attempts.find((a) => a.status === 'active') || attempts[attempts.length - 1];
      return active?.dataset || null;
    } catch {
      return null;
    }
  }

  async function buildLessonMarkdown() {
    const match = window.location.pathname.match(/\/lesson\/(\d+)/);
    if (!match) throw new Error('ID урока не найден в URL');
    const lessonId = match[1];

    const resLesson = await fetch(`/api/lessons/${lessonId}`, { credentials: 'same-origin' });
    if (!resLesson.ok) throw new Error(`HTTP ${resLesson.status} при загрузке урока`);
    const dataLesson = await resLesson.json();
    const lesson = dataLesson.lessons?.[0];
    if (!lesson) throw new Error('Данные урока не найдены');

    const allSteps = [];
    for (let i = 0; i < lesson.steps.length; i += 50) {
      const chunk = lesson.steps.slice(i, i + 50);
      const query = chunk.map((id) => `ids[]=${id}`).join('&');
      const resSteps = await fetch(`/api/steps?${query}`, { credentials: 'same-origin' });
      if (!resSteps.ok) throw new Error(`HTTP ${resSteps.status} при загрузке шагов`);
      const dataSteps = await resSteps.json();
      allSteps.push(...(dataSteps.steps || []));
    }
    allSteps.sort((a, b) => a.position - b.position);

    // Подгружаем dataset из существующих попыток для интерактивных шагов
    const datasets = new Map();
    const quizSteps = allSteps.filter((s) => {
      const t = s.block?.name;
      const o = s.block?.options || {};
      return INTERACTIVE_TYPES.has(t) && !o.options && !o.pairs && !o.rows && !o.components;
    });
    await Promise.all(
      quizSteps.map(async (s) => {
        const ds = await fetchAttemptDataset(s.id);
        if (ds) datasets.set(s.id, ds);
      })
    );

    const courseTitle = document.querySelector('.lesson-sidebar__course-title')?.textContent.trim();
    const lessonHeader = document.querySelector('.top-tools__lesson-name')?.textContent.replace(/\s+/g, ' ').trim();
    const title = lessonHeader || lesson.title || `Урок ${lessonId}`;

    let md = `# ${title}\n`;
    if (courseTitle) md += `*Курс: ${courseTitle}*\n`;
    md += '\n';

    for (const step of allSteps) {
      const block = step.block || {};
      const type = block.name || 'unknown';
      const opts = block.options || {};
      const ds = datasets.get(step.id) || {};

      md += `## Шаг ${step.position} [${type}]\n\n`;

      if (type === 'video' && block.video) {
        const urls = [...(block.video.urls || [])].sort((a, b) => Number(b.quality) - Number(a.quality));
        const best = urls[0];
        const dur = formatDuration(block.video.duration);
        if (best?.url) {
          md += `*Видео (${best.quality}p${dur ? `, ${dur}` : ''}):* ${best.url}\n\n`;
        } else {
          md += `*Видео${dur ? ` (${dur})` : ''}*\n\n`;
        }
      }

      if (block.text) {
        const bodyMd = htmlToMd(block.text);
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
              md += `* [ ] ${htmlToMd(opt)}\n`;
            } else {
              const mark = opt.is_correct ? '[x]' : '[ ]';
              md += `* ${mark} ${htmlToMd(opt.text)}\n`;
            }
          }
          md += '\n';
        } else {
          md += `*Варианты ответа${mode ? ` (${mode})` : ''}: не загружены (откройте шаг для генерации попытки).*\n\n`;
        }
      }

      if (type === 'matching') {
        const pairs = ds.pairs || opts.pairs;
        if (pairs?.length) {
          md += `**Пары для сопоставления:**\n`;
          for (const pair of pairs) {
            md += `* ${htmlToMd(pair.first)} — ${htmlToMd(pair.second)}\n`;
          }
          md += '\n';
        } else {
          md += `*Пары для сопоставления не загружены (откройте шаг для генерации попытки).*\n\n`;
        }
      }

      if (type === 'sorting') {
        const items = ds.options || opts.options;
        if (items?.length) {
          md += `**Элементы для сортировки:**\n`;
          items.forEach((item, idx) => {
            md += `${idx + 1}. ${htmlToMd(item)}\n`;
          });
          md += '\n';
        } else {
          md += `*Элементы для сортировки не загружены (откройте шаг для генерации попытки).*\n\n`;
        }
      }

      if (type === 'table') {
        const rows = ds.rows || opts.rows;
        const columns = ds.columns || opts.columns;
        if (rows?.length && columns?.length) {
          const desc = ds.description ? htmlToMd(ds.description) : '';
          md += `**Таблица выбора${ds.is_checkbox ? ' (несколько в строке)' : ''}:**\n`;
          md += `| ${desc} | ${columns.map((c) => htmlToMd(c).replace(/\|/g, '\\|')).join(' | ')} |\n`;
          md += `| --- | ${columns.map(() => '---').join(' | ')} |\n`;
          for (const r of rows) {
            md += `| ${htmlToMd(r).replace(/\|/g, '\\|')} | ${columns.map(() => ' ').join(' | ')} |\n`;
          }
          md += '\n';
        } else {
          md += `*Таблица выбора не загружена (откройте шаг для генерации попытки).*\n\n`;
        }
      }

      if (type === 'fill-blanks') {
        const components = ds.components || opts.components;
        if (components?.length) {
          md += `**Шаблон с пропусками:**\n`;
          const line = components
            .map((c) => {
              if (c.type === 'text') return htmlToMd(c.text);
              if (c.type === 'select') return `[Выбор: ${(c.options || []).map((o) => cleanText(o)).join(' / ')}]`;
              return '[____]';
            })
            .join(' ');
          md += `${line}\n\n`;
        } else {
          md += `*Шаблон с пропусками не загружен (откройте шаг для генерации попытки).*\n\n`;
        }
      }

      if (opts.samples?.length) {
        md += `**Примеры:**\n`;
        opts.samples.forEach(([inp, out], idx) => {
          md += `*Тест ${idx + 1}:*\n\`\`\`text\nВход:\n${cleanText(inp).trim()}\nВыход:\n${cleanText(out).trim()}\n\`\`\`\n`;
        });
        md += '\n';
      }

      if (opts.code_templates && typeof opts.code_templates === 'object') {
        for (const [lang, tpl] of Object.entries(opts.code_templates)) {
          const cleanedTpl = cleanText(tpl).trim();
          if (!cleanedTpl) continue;
          const fenceLang = normalizeLang(lang);
          md += `**Шаблон кода (${lang}):**\n\`\`\`${fenceLang}\n${cleanedTpl}\n\`\`\`\n\n`;
        }
      }
    }

    return { md: md.replace(/\n{3,}/g, '\n\n').trim() + '\n', lessonId, title, count: allSteps.length };
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  const isLessonPage = () => /\/lesson\/\d+/.test(window.location.pathname);

  function syncFloatingPanel() {
    const existing = document.getElementById(BAR_ID);
    if (!isLessonPage()) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;

    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'z-index: 2147483647',
      'display: flex',
      'gap: 6px',
      'padding: 6px',
      'border-radius: 8px',
      'background: rgba(24, 26, 32, 0.92)',
      'border: 1px solid #54ad54',
      'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45)',
      'backdrop-filter: blur(4px)'
    ].join(';');

    const btnStyle = [
      'padding: 6px 12px',
      'font-size: 12px',
      'font-weight: 500',
      'font-family: system-ui, -apple-system, sans-serif',
      'border-radius: 5px',
      'border: 1px solid rgba(84, 173, 84, 0.5)',
      'background: #2b303b',
      'color: #f3f4f6',
      'cursor: pointer',
      'white-space: nowrap'
    ].join(';');

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.id = COPY_BTN_ID;
    copyBtn.textContent = '📋 Копировать MD (Alt+C)';
    copyBtn.style.cssText = btnStyle;

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.textContent = '💾 .md';
    dlBtn.style.cssText = btnStyle;

    copyBtn.onclick = async () => {
      const orig = '📋 Копировать MD (Alt+C)';
      copyBtn.textContent = '⏳ Загрузка...';
      try {
        const { md, count } = await buildLessonMarkdown();
        await copyToClipboard(md);
        copyBtn.textContent = `✅ Скопировано (${count} шаг.)`;
      } catch (e) {
        console.error('[Stepik MD]', e);
        copyBtn.textContent = '❌ Ошибка (см. F12)';
      }
      setTimeout(() => (copyBtn.textContent = orig), 2200);
    };

    dlBtn.onclick = async () => {
      const orig = '💾 .md';
      dlBtn.textContent = '⏳...';
      try {
        const { md, lessonId, title } = await buildLessonMarkdown();
        const safeTitle = title.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60);
        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${safeTitle || lessonId}.md`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        dlBtn.textContent = '✅';
      } catch (e) {
        console.error('[Stepik MD]', e);
        dlBtn.textContent = '❌';
      }
      setTimeout(() => (dlBtn.textContent = orig), 2200);
    };

    bar.append(copyBtn, dlBtn);
    document.body.appendChild(bar);
  }

  // SPA-навигация (Ember.js)
  let lastHref = window.location.href;
  const onUrlChange = () => {
    if (window.location.href !== lastHref) {
      lastHref = window.location.href;
    }
    syncFloatingPanel();
  };

  window.addEventListener('popstate', onUrlChange);
  const origPush = history.pushState;
  history.pushState = function (...args) {
    const ret = origPush.apply(this, args);
    onUrlChange();
    return ret;
  };
  const origReplace = history.replaceState;
  history.replaceState = function (...args) {
    const ret = origReplace.apply(this, args);
    onUrlChange();
    return ret;
  };

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.code === 'KeyC' && isLessonPage()) {
      e.preventDefault();
      document.getElementById(COPY_BTN_ID)?.click();
    }
  });

  syncFloatingPanel();
  new MutationObserver(() => syncFloatingPanel()).observe(document.body, { childList: true });
})();