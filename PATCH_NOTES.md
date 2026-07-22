# RSL-plus 1.1.4 — resource optimization patch

Распакуйте архив в корень репозитория и выполните:

```powershell
powershell -ExecutionPolicy Bypass -File .\apply-resource-patch.ps1
npm.cmd test
vsce.cmd package
```

## Новая структура server/src

- `analysis/` — поиск ссылок;
- `diagnostics/` — engine, правила, coordinator и публикация Problems;
- `features/` — LSP providers и Quick Fix;
- `indexing/` — загрузка workspace;
- `services/` — анализ документов и настройки;
- `core/` — общие ограниченные структуры данных;
- в корне остаются parser/lexer, legacy-модель и общие индексы, которыми пользуются многие подсистемы.

## Ресурсные изменения

- full workspace indexing больше не запускается автоматически;
- закрытый файл заменяется compact external summary;
- summary не удерживает source, AST, lexer tokens и локальные объявления Macro;
- Definition Provider использует WorkspaceIndex вместо второго кэша;
- Import-кэши ограничены 32 LRU-записями и инвалидируются адресно;
- References разбирает неизвестные файлы только во время явного запроса;
- диагностики считаются только для активного RSL-файла и переиспользуют результат той же версии.
