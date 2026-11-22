![Vibe Coded with Gemini](https://img.shields.io/badge/Vibe_Coded_with-Gemini_4_Neon-8E75B2?style=flat&logo=googlegemini&logoColor=white)
# Stepik to Markdown

Скрипт/расширение для скачивания курсов со Stepik в формате Markdown (`.md`).
Для скачивания можно выбрать сразу весь курс, конкретный модуль или урок. Комментарии не подтягиваются. Функционал в кнопке MD сверху справа.

Смысл:
Если скачать урок со Stepik в формате HTML и попробовать скормить его LLM-модели, например для обучения, то вскоре придётся столкнуться с закончившимися лимитами. Скачанный HTML содержит тонны мусора, скриптов, ненужных данных и т.д., которые высасывают все токены. Скрипт всё это вычищает оставляя чистый markdown, так хорошо понятный нейроночкам.

<p align="center">
  <img width="598" height="57" alt="image" src="https://github.com/user-attachments/assets/c1e05a35-3606-4f7c-b0b8-7afbae1ca637" />
  <br>
  Для сравнения — урок в формате <code>.md</code> весит в среднем <strong>в 40—60 раз меньше</strong>, чем тот же HTML-файл.
</p>



Думай.Те



<p align="center">
  <img width="389" height="61" alt="image" src="https://github.com/user-attachments/assets/f905f482-c17c-40bf-afbd-8fa6228d0ccb" />
  <br>
  Кнопочка MD для скачивания сверху справа в хедере.
</p>


Чтобы воспользоваться скриптом можно установить расширение в браузер или добавить скрипт в Tampermonkey.


## Расширение для браузера (Chrome, Edge, Brave)

1. Скачайте архив с расширением из раздела **[Releases](../../releases/latest)** и распакуйте его куда-нибудь, откуда потом случайно не удалите. Также можно сразу скачать папку `extension/` из этого репозитория.
2. Откройте страницу расширений в вашем браузере (`chrome://extensions/`):
3. Включите тумблер **«Режим разработчика»** в правом верхнем углу.
4. Нажмите **«Загрузить распакованное расширение»** (Load unpacked) и выберите папку с файлами расширения (`manifest.json` и `content.js`).
5. Откройте или обновите (`F5`) любую страницу урока на Stepik. Расширение должно появиться.


## Скрипт для Tampermonkey (Firefox, Safari)

1. Установите расширение **Tampermonkey** или **Violentmonkey** для вашего браузера.
   * *Для браузеров на базе Chromium обязательно включите **«Режим разработчика»** на странице расширений браузера, иначе менеджер скриптов не сможет запускаться на страницах.*
2. Откройте файл [`userscript/stepik-to-md.user.js`](userscript/stepik-to-md.user.js) в этом репозитории и нажмите кнопку **Raw**. Или создайте свой скрипт в Tampermonkey, вставив туда содержимое `userscript/stepik-to-md.user.js`. Убедитесь что параметр Allow User Scripts в настройках расширения включён.
3. Обновите (`F5`) страницу урока на Stepik.


## English Overview

**Stepik to Markdown** is a lightweight browser extension and userscript that lets you export courses, modules, or individual lessons from Stepik into clean Markdown (`.md`) files in one click.

### Why use it?
If you save a Stepik lesson as a standard `.html` or `.mhtml` page and feed it into an LLM (like ChatGPT, Claude, Gemini, or NotebookLM) for studying or summarization, you will quickly hit context limits. Raw web pages contain megabytes of scripts, styles, and layout bloat that waste tokens.

This tool strips away all unnecessary markup and leaves only pure, structured Markdown:
* **40–60x smaller file size** compared to saved HTML pages.
* **Flexible export:** Download a single lesson, a whole module, or an entire course at once.
* **LLM-ready:** Clean formatting optimized for AI context windows and personal knowledge bases (Obsidian, Notion).
* **Easy access:** Adds a convenient `MD` button right in the top-right header of any Stepik lesson page.

