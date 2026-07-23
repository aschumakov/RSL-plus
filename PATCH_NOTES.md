# RSL-plus 1.1.4 — Fast Open & Performance Patch

Патч накладывается на текущую версию **1.1.4** после resource-optimization изменений.
Номер версии не меняется.

## Установка без PowerShell

1. Распакуйте архив в корень репозитория с заменой файлов.
2. Выполните:

```powershell
node .\apply-performance-patch.js
npm.cmd test
vsce.cmd package
```

`apply-performance-patch.js` нужен только для изменения клиентского порядка запуска:

- активный документ получает приоритет перед обходом workspace;
- поиск `**/*.mac` начинается через 500 мс;
- исключаются `dist`, `build`, `archive`, `backup`, `.history`;
- перед сборкой удаляются старые `client/out`, `server/out` и `tsconfig.tsbuildinfo`.

**Тесты не читают и не проверяют установочный скрипт.** После применения скрипт можно удалить из репозитория.

## Новый порядок открытия файла

1. TextMate-грамматика подсвечивает файл средствами VS Code.
2. Первый parser запускается немедленно, без debounce открытия.
3. Один lexer/parser snapshot используется для дерева символов, Folding и Outline.
4. Локальные Problems публикуются отдельно и не ждут загрузки Import.
5. Import-summary загружаются последовательной интерактивной очередью.
6. Workspace-зависимые Problems обновляют результат вторым пакетом, но не позднее жёсткого max-wait.

## Основные изменения

- первый разбор файла выполняется сразу; debounce 90 мс остаётся только для изменений текста;
- устранён второй lexer pass при запросе Folding;
- диагностики разделены на local/workspace фазы;
- локальные диагностики не зависят от общей ревизии workspace;
- workspace-диагностика имеет `debounce=700 мс` и `maxWait=1800 мс`;
- загрузка очередного Import больше не переносит Problems бесконечно;
- external summary строится отдельным scanner без statement/expression AST;
- external summary хранит готовые line/character Range для перехода к определению без повторного чтения файла;
- три Import-кэша объединены в один `ImportContext` LRU на 8 активных документов;
- Semantic Tokens поддерживают full/delta/range;
- References не перестраивает глобальные symbol/import индексы для временных файлов и не создаёт lowercase-копию всего файла;
- прогресс индексации считается за O(1), обновления status bar ограничены частотой;
- добавлены тесты fast-open pipeline и external summary scanner.

## Проверка перед выпуском

После распаковки и применения Node.js-скрипта выполните:

```powershell
npm.cmd test
vsce.cmd package
```
