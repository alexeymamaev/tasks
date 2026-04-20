# tasks prototype

Vanilla HTML/CSS/JS + Dexie + PWA. Деплой — GitHub Pages.

## Шаги плана

- [x] 1. Скелет PWA (5 файлов, Dexie через CDN, SW).
- [x] 2. Главный экран: header, 3-колоночная сетка активных, input-bar, добавление, тап=done.
- [x] 3. Чек-бейдж + журнал (закрытые сегодня).
- [x] 4. Bottom-sheet создания/редактирования (long-press активной / тап input-bar / тап journal).
- [x] 5. Иконки: keyword-подсказки (~120 RU/EN пар), full picker (150 Lucide + search).
- [ ] 6. Дедлайн pill.
- [ ] 7. Undo-снекбар.
- [ ] 8. Empty state.

## IndexedDB recovery (заложено сразу)

WebKit на iOS убивает IDB-соединение, пока страница в фоне. Паттерн, украденный из kid-journal (2026-04-20 bugfix):

- `ensureDbOpen()` — проверить `db.isOpen()` перед операциями
- `recoverDb()` — close+open с soft-баннером
- `isIdbDisconnectError()` — фильтр по `DatabaseClosedError` и сообщению «Connection to Indexed Database server lost»
- Глобальный error/unhandledrejection роутит эту ошибку в `recoverDb()`
- `visibilitychange` + `pageshow` → preemptive `ensureDbOpen()`
- `boot(retry=0)` с ретраем до 2 раз

## Запуск локально

```bash
cd /Users/alekseimamaev/Wiki/pet-projects/tasks/prototype
python3 -m http.server 8000
# открыть http://localhost:8000
```

SW и `navigator.storage.persist()` нормально работают только по HTTPS — для iPhone нужен GitHub Pages.

## Схема Dexie

`tasks-v1`:

```
tasks: '++id, done_at, created_at'
  id          — autoincrement
  icon        — string (lucide name, MVP1 = 'circle-dashed')
  text        — string
  deadline    — 'YYYY-MM-DD' | null
  created_at  — Date.now()
  done_at     — Date.now() | 0   (0 = активная; 0, а не null, чтобы индексировалось)
```
