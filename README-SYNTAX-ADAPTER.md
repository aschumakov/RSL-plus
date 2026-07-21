# Syntax tree adapter hotfix

Этот overlay накладывается на текущее состояние RSL-plus 1.1.3 с уже установленным `syntaxParser.ts`.

## Изменения

1. Многострочное выражение после бинарного оператора больше не разбивается на две инструкции:

```rsl
result = "<tag>" +
         BuildValue(...)
         + "</tag>";
```

2. `common.ts` больше не разбирает исходный текст самостоятельно. `CBase` и `CVar` создаются классом `LegacySymbolTreeAdapter` из `IRslSyntaxNode`.

3. Один результат `parseRslSyntax()` используется для:

- syntax diagnostics;
- полного lexer-потока;
- построения legacy symbol tree;
- списка импортов WorkspaceIndex.

4. Объявления внутри `IF`, `FOR` и `WHILE` добавляются в ближайшую область модуля, MACRO или CLASS, поскольку эти блоки не создают отдельной области видимости RSL.

5. Добавлены регрессионные тесты:

- `tests/syntax-parser.test.js`;
- `tests/symbol-tree-adapter.test.js`.

## Проверка

```powershell
npm test
vsce.cmd package
```
