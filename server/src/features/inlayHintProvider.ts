import {
    InlayHint,
    InlayHintKind,
    type Range
} from "vscode-languageserver";
import { CompletionItemKind } from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";
import { displayTypeName } from "../language/rslLanguageReference";
import type { RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Выведенный тип переменной рядом с её объявлением.
 *
 * Показывается ровно там, где типа в тексте нет: `Var doc;` и `Var doc = TBFile
 * (...)` — это Variant, и подсказка сообщает, чем он оказался. У объявления с
 * написанным типом подсказки нет: там тип и так виден, а дублировать его значит
 * засорять строку.
 *
 * Тип показывается только подтверждённый — примитив языка или разрешимый класс
 * (см. effectiveTypeName). Показать вместо типа имя неразрешённого вызова было
 * бы хуже, чем не показывать ничего: подсказка выглядит как факт.
 */
export function buildRslInlayHints(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    range: Range,
    isCancelled: () => boolean = () => false
): InlayHint[] {
    const starts = module.lex.lineStarts;
    const from = offsetOfLine(starts, range.start.line);
    const to = offsetOfLine(starts, range.end.line + 1);
    const result: InlayHint[] = [];

    const visit = (scope: RslSymbol): void => {
        if (isCancelled()) {
            return;
        }

        for (const child of scope.children) {
            if (child.isContainer) {
                /* Внутрь контейнера, который не пересекает диапазон, не идём. */
                if (child.range.end >= from && child.range.start <= to) {
                    visit(child);
                }
                continue;
            }

            if (
                child.selectionRange.start < from ||
                child.selectionRange.end > to
            ) {
                continue;
            }

            const hint = createHint(module, resolver, child);

            if (hint) {
                result.push(hint);
            }
        }
    };

    visit(module.symbolTree);
    return result;
}

function createHint(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    symbol: RslSymbol
): InlayHint | undefined {
    if (!HINTED_KINDS.has(symbol.kind) || !symbol.isTypeVariant) {
        return undefined;
    }

    /*
     * Только объявление и его инициализатор.
     *
     * Присваивания ниже по тексту подсказке не нужны: она стоит у объявления и
     * говорит о начальном значении. Общий effectiveTypeName ради них строил
     * индекс присваиваний всего файла — на каждую новую модель, то есть на
     * каждую правку, при том что редактор просит подсказки для видимых строк.
     */
    const typeName = resolver.declarationTypeName(
        module.uri,
        module.symbolTree,
        symbol
    );

    if (!typeName || typeName.toLowerCase() === "variant") {
        return undefined;
    }

    return {
        position: positionAtOffset(
            module.lex.lineStarts,
            symbol.selectionRange.end
        ),
        label: `: ${displayTypeName(typeName)}`,
        kind: InlayHintKind.Type,
        paddingLeft: false,
        /*
         * Подсказка неполна по смыслу: тип выведен, а не объявлен. Tooltip
         * говорит об этом прямо, чтобы её не приняли за текст программы.
         */
        tooltip: `Тип выведен из присваивания; в объявлении он не указан`
    };
}

/** Объявления, у которых имеет смысл показывать тип значения. */
const HINTED_KINDS: ReadonlySet<CompletionItemKind> = new Set([
    CompletionItemKind.Variable,
    CompletionItemKind.Field,
    CompletionItemKind.Property
]);

function offsetOfLine(
    lineStarts: readonly number[],
    line: number
): number {
    if (line <= 0) {
        return 0;
    }
    return line < lineStarts.length
        ? lineStarts[line]
        : Number.MAX_SAFE_INTEGER;
}
