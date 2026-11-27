![Vibe Coded with Gemini](https://img.shields.io/badge/Vibe_Coded_with-Gemini_4_Neon-8E75B2?style=flat&logo=googlegemini&logoColor=white)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-2.1-blue.svg)](../../releases/latest)

# Stepik to Markdown

Бесплатное расширение для браузера и userscript (Tampermonkey / Violentmonkey), которое позволяет **скачать курс, отдельный модуль или урок со Stepik в чистом формате Markdown (`.md`)** в один клик — для нейросетей (ChatGPT, Claude, Gemini, NotebookLM, DeepSeek) и личных баз знаний (Obsidian, Notion).

Кнопка **MD** появляется прямо в верхней панели Stepik (также работают горячие клавиши `Alt+M` — открыть меню, `Alt+C` — скопировать текущий урок в буфер обмена). Комментарии и интерфейсный мусор не подтягиваются.

## Зачем это нужно

Если сохранить урок со Stepik как обычный `.html` или `.mhtml` и загрузить его в LLM для конспекта или обучения, вы быстро упрётесь в лимиты контекстного окна: сырая страница содержит мегабайты скриптов, стилей и разметки сайта. **Stepik to Markdown** забирает контент напрямую через read-only GET API Stepik и очищает его в компактный Markdown.

<p align="center">
  <img width="598" height="57" alt="Сравнение размера .md и .mhtml файла урока Stepik" src="https://github.com/user-attachments/assets/c1e05a35-4f7c-4f8a-b0b8-7afbae1ca637" />
  <br>
  Для сравнения — урок в формате <code>.md</code> весит в среднем <strong>в 40—60 раз меньше</strong>, чем тот же HTML-файл.
</p>

<p align="center">
  <img width="389" height="61" alt="Кнопка MD в шапке урока Stepik" src="https://github.com/user-attachments/assets/f905f482-c17c-4f8a-b1fe-8fa6228d0ccb" />
  <br>
  Кнопка <code>MD</code> для экспорта сверху справа в хедере.
</p>

<details>
<summary>Пример итогового Markdown (.md) на выходе</summary>

```markdown
# Целочисленная арифметика. Часть 1
*Курс: "Поколение Python": курс для начинающих*

## Шаг 1 [text]

| Оператор | Описание |
| --- | --- |
| `+` | сложение |
| `-` | вычитание |

Диапазон значений: $\left[-2^{63}; \, 2^{63} - 1\right]$

## Шаг 8 [code]

*Ограничения:* python3 (15с, 256 МБ)

**Примеры:**
*Тест 1:*
```text
Вход:
1
2
3
Выход:
6
```
```

</details>

---

## Установка

Чтобы воспользоваться инструментом, выберите удобный способ: расширение для браузера или скрипт для Tampermonkey.

### Вариант 1: Расширение для браузера (Chrome, Edge, Brave, Яндекс Браузер)

1. Скачайте архив `stepik-to-markdown-extension.zip` из раздела **[Releases](../../releases/latest)** и распакуйте его в постоянную папку (откуда не удалите). Также можно скачать папку `extension/` из этого репозитория.
2. Откройте страницу расширений браузера (`chrome://extensions/`).
3. Включите тумблер **«Режим разработчика»** (Developer mode) в правом верхнем углу.
4. Нажмите **«Загрузить распакованное расширение»** (Load unpacked) и выберите папку с файлами расширения (`manifest.json`, `content.js`, `icons/`).
5. Откройте или обновите (`F5`) любую страницу курса или урока на Stepik. Кнопка `MD` появится в верхнем меню.

### Вариант 2: Скрипт для Tampermonkey / Violentmonkey (Firefox, Safari, Chromium)

1. Установите расширение **Tampermonkey** или **Violentmonkey** для вашего браузера.
   * *В браузерах на базе Chromium обязательно включите **«Режим разработчика»** и параметр **Allow User Scripts** на странице расширений, иначе менеджер скриптов не сможет запускаться на страницах.*
2. **[Установить скрипт в 1 клик (stepik-to-md.user.js)](https://github.com/k0tislav/stepik-to-markdown/raw/main/userscript/stepik-to-md.user.js)** — Tampermonkey автоматически откроет вкладку установки. Либо откройте [`userscript/stepik-to-md.user.js`](userscript/stepik-to-md.user.js), нажмите **Raw** и вставьте код вручную.
3. Обновите (`F5`) страницу курса или урока на Stepik.

---

## Возможности и поддерживаемые типы шагов

* **Три режима экспорта:** копирование/скачивание текущего урока, скачивание выбранного модуля или выгрузка всего курса в один `.md` файл с оглавлением.
* **Теория (`text`):** заголовки, таблицы (GFM), формулы LaTeX/MathJax (`$...$`, `$$...$$`), блоки кода с определением языка, списки, цитаты, спойлеры `<details>`, изображения и ссылки. Корректно сохраняет учебные примеры HTML и CSS, не смешивая их с разметкой сайта.
* **Практика (`code`, `sql`, `html`):** условие, лимиты времени/памяти, тестовые примеры (`samples`), нетривиальные стартовые шаблоны, а для курсов по вёрстке (`html`) — `html_template`, `css_template` и чеклист проверок.
* **Тесты и квизы (`choice`, `matching`, `sorting`, `parsons`, `table`, `fill-blanks`, `number`, `string`, `math`, `free-answer`, `dataset`):** варианты ответа, пары, таблицы и пропуски.
* **Видео (`video`):** прямая ссылка на видео в максимальном доступном качестве, длительность и ссылки на субтитры.
* **Устойчивость к большим курсам:** пакетная загрузка по API (`GET`), соблюдение `Retry-After` и защита от `429 Rate Limit`, таймауты и отмена экспорта в любой момент.

> **Ограничения (read-only режим):** скрипт работает строго через `GET`-запросы и не создаёт попытки на сервере. Варианты ответов в тестах (`choice`, `matching`, `sorting`, `fill-blanks`, `table`) подтягиваются, если вы уже открывали этот шаг в браузере (создана попытка). Закрытые/платные уроки без доступа помечаются как недоступные.

---

## English Overview

**Stepik to Markdown** is a lightweight, zero-dependency browser extension and Tampermonkey userscript to **export Stepik courses, modules, or individual lessons to clean Markdown (`.md`)** in one click. Built for feeding course materials into LLMs (ChatGPT, Claude, Gemini, NotebookLM, DeepSeek) and personal knowledge bases (Obsidian, Notion, Logseq).

### Why use it?
Saving a Stepik lesson as `.html` or `.mhtml` bloats files with megabytes of scripts, styles, and UI chrome that quickly exhaust LLM context windows. **Stepik to Markdown** fetches lesson content directly via Stepik's read-only GET API and converts it into clean, structured Markdown:
* **40–60x smaller file size** compared to saved HTML/MHTML pages.
* **Flexible export:** Copy or download a single lesson (`Alt+C`), a selected module, or an entire course with a Table of Contents.
* **Rich step support:** Preserves LaTeX/MathJax formulas, GFM tables, fenced code blocks, HTML/CSS coding tasks (`html_template` & `css_template`), programming task samples/limits, video links + subtitles, and quiz options.
* **Large-course resilient:** Batched API fetching, `429` rate-limit backoff/circuit-breaker, per-request timeouts, and one-click cancellation.

### Quick Installation (English)
* **Chrome / Edge / Brave (Extension):** Download `stepik-to-markdown-extension.zip` from **[Releases](../../releases/latest)**, unzip it, enable **Developer mode** at `chrome://extensions/`, and click **Load unpacked** selecting the extracted folder (`manifest.json`, `content.js`, `icons/`).
* **Tampermonkey / Violentmonkey (Userscript):** Install directly via **[1-click userscript link](https://github.com/k0tislav/stepik-to-markdown/raw/main/userscript/stepik-to-md.user.js)** (on Chromium browsers, enable Developer mode / *Allow User Scripts*).
* **Shortcuts:** Press `Alt+M` to open the `MD` menu, or `Alt+C` on a lesson page to copy it to your clipboard.
