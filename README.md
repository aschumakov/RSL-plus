# RSL-plus

Расширение Visual Studio Code для разработки на **RSL / Object RSL** — языке макросов продуктов R-Style Softlab.

RSL-plus вырос из расширения [alliluja/RSL](https://github.com/alliluja/RSL) и сохраняет его базовые возможности, но дополняет их полноценным language server: диагностикой, навигацией по проекту, семантическим анализом и безопасными автоматическими исправлениями.

## Возможности

### Редактор

- подсветка синтаксиса RSL, SQL-строк и SQL-блоков `[ ... ]`;
- поддержка вложенных блочных комментариев;
- безопасное форматирование с сохранением строк, SQL, BOM, CRLF и финального перевода строки;
- сворачивание `Macro`, `Class`, `If`, `For`, `While`, `With`, комментариев и SQL-блоков;
- сниппеты RSL;
- команды копирования и вставки SQL-запросов.

### IntelliSense и навигация

- автодополнение локальных, глобальных и импортированных символов;
- учёт областей видимости, `Private`, классов и наследования;
- Hover с типом и описанием символа;
- Go to Definition для объявлений, `Import`, `ExecMacro`, `ExecMacro2` и `ExecMacroFile`;
- Find All References по загруженному workspace index;
- семантическая подсветка классов, методов, функций, переменных, параметров и свойств;
- список символов документа и список известных макрофайлов.

### Problems и Quick Fix

Плагин проверяет:

- структуру блоков, `END`, `ELSE` и скобки;
- незакрытые строки, комментарии и блоки `[ ... ]`;
- повторные объявления и повторные `Import`;
- неиспользуемые переменные, параметры и известные импортированные модули;
- использование локальной переменной до объявления;
- неоднозначные ссылки и неоднозначные `Import`;
- оставленный `DEBUGBREAK`;
- устаревшие объявления `RECORD` и `ARRAY`.

Для однозначных случаев доступны Quick Fix: удаление `DEBUGBREAK`, лишнего `END`/`ELSE`/скобки, повторного или неиспользуемого `Import`, неиспользуемого объявления и вставка `+` между соседними строками.

## Стандартные обработчики RS-Bank

Некоторые `Macro` вызываются ядром RS-Bank с позиционным набором параметров. Реализация может использовать только часть параметров, но обязана сохранить позиции до последнего используемого аргумента.

Имена таких обработчиков задаются в корневом файле [`standard-handlers.json`](standard-handlers.json):

```json
{
  "handlers": [
    "ExecuteStep",
    "PostStepAction",
    "CheckStepAction"
  ]
}
```

Для стандартного обработчика проверяется только неиспользуемый хвост параметров справа. Параметры слева от последнего используемого не помечаются как ошибки.

## Что изменилось в 1.1.4

Версия 1.1.4 начинает архитектурное разделение language server:

- `server.ts` оставлен точкой сборки и регистрации LSP;
- разбор документов вынесен в `DocumentAnalysisService`;
- расписание и публикация Problems вынесены в `DiagnosticsCoordinator`;
- настройки документов изолированы в `RslSettingsService`;
- чтение и фоновая индексация `.mac` вынесены в `WorkspaceModuleLoader`;
- LSP-provider-ы и их кэши собраны в `RslLanguageFeatureRegistry`;
- введена единая модель модуля с AST и временным compatibility-слоем `CBase`;
- добавлены реестры диагностических правил и Quick Fix;
- неоднозначный `Import` больше не разрешается случайным выбором файла;
- Find All References больше не читает весь workspace внутри пользовательского запроса.

## Установка

### Из Marketplace

В Visual Studio Code откройте Extensions (`Ctrl+Shift+X`) и найдите **RSL-plus**.

Из командной строки:

```text
code --install-extension AChumakov.rsl-plus
```

### Из VSIX

```text
code --install-extension rsl-plus-1.1.4.vsix
```

## Настройки

Основные параметры находятся в `RSLanguageServer`:

- `RSLanguageServer.import` — подключать импортированные макросы;
- `RSLanguageServer.diagnostics.enabled` — включить Problems;
- отдельные переключатели для структуры, неиспользуемых объявлений, Import, `DEBUGBREAK`, использования до объявления и неоднозначных ссылок;
- `RSLanguageServer.diagnostics.maxProblems` — лимит сообщений на файл.

Для заголовков новых файлов используется `rsl-plus.programmerName`.

## Разработка

Требуются Node.js 18+ и Visual Studio Code 1.90+.

```text
npm ci
npm test
```

Сборка VSIX:

```text
npx @vscode/vsce package
```

Корневой `npm test` компилирует client/server и запускает набор регрессионных тестов lexer, parser, formatter, folding, scope resolver, diagnostics, navigation, performance и Quick Fix.

## Обратная связь

- Репозиторий: <https://github.com/aschumakov/RSL-plus>
- Ошибки и предложения: <https://github.com/aschumakov/RSL-plus/issues>

Проект использует и развивает исходную реализацию расширения [alliluja/RSL](https://github.com/alliluja/RSL).
