# pdf.js (локальная копия)

Просмотр многостраничных PDF в «Документ анализа» (`js/ui/docViewer.js`).
Файлы лежат в проекте и кэшируются Service Worker — без CDN и сети.

- Пакет: `pdfjs-dist@4.10.38` (npm), Mozilla, лицензия Apache-2.0 (`LICENSE`).
- Сборка `legacy/build` — с полифилами для старых Safari / iOS PWA.
- Переименованы только расширения (`.mjs` → `.js`), чтобы любой статический хостинг
  отдавал их с JavaScript MIME-типом:

| Файл | Оригинал | SHA-256 |
|---|---|---|
| `pdf.min.js` | `legacy/build/pdf.min.mjs` | `44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72` |
| `pdf.worker.min.js` | `legacy/build/pdf.worker.min.mjs` | `bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d` |

Обновление: `npm pack pdfjs-dist@<версия>`, скопировать два файла из `legacy/build`,
обновить таблицу и `CACHE_VERSION` в `sw.js`.
