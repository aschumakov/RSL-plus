import {
    CompletionItemKind,
    InlayHint,
    InlayHintKind,
    type Range
} from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";
import { extractParameterLabels } from "./signatureHelpProvider";

/**
 * Имя параметра рядом с аргументом вызова.
 *
 * `Send(document, 1, true)` не говорит, что означают 1 и true; подсказка
 * дописывает `count:` и `silent:` — ровно то, что стоит в объявлении.
 *
 * Три правила, из которых складывается всё остальное.
 *
 * Первое: показывается только достоверное. Вызов, который не разрешился в одно
 * объявление, вызов с числом аргументов больше числа параметров, объявление без
 * читаемого списка параметров — подсказок не будет вовсе. Подсказка выглядит
 * как факт, и ошибаться ей нельзя.
 *
 * Второе: это не проверка. Несовпадение числа аргументов не сообщается никак —
 * ни подсказкой, ни диагностикой. Проверять вызовы — работа диагностик, у
 * которых для этого есть и полная модель, и настройки, и лимиты.
 *
 * Третье: очевидное не показывается. `Send(document)` при параметре `document`
 * подсказки не получает: она повторила бы то, что уже написано.
 */

/*
 * Сколько вызовов разбирать за один запрос.
 *
 * Редактор просит подсказки для видимых строк, но диапазон бывает и во весь
 * файл — например при печати документа. Разрешение имени стоит времени, и
 * тратить его на тысячу вызовов ради экрана в сорок строк незачем.
 */
const MAX_CALLS = 200;

/** Имя параметра: те же символы, что и в идентификаторах RSL. */
const PARAMETER_NAME_PATTERN =
    /^[A-Za-zА-Яа-яЁё_@][A-Za-zА-Яа-яЁё0-9_$@]*$/u;

export function buildRslParameterInlayHints(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    range: Range,
    isCancelled: () => boolean = () => false
): InlayHint[] {
    const starts = module.lex.lineStarts;
    const from = offsetOfLine(starts, range.start.line);
    const to = offsetOfLine(starts, range.end.line + 1);
    const tokens = module.syntax.tokens;
    const result: InlayHint[] = [];
    let calls = 0;

    for (
        let index = firstTokenAt(tokens, from);
        index < tokens.length && tokens[index].start < to;
        index++
    ) {
        if (calls >= MAX_CALLS || isCancelled()) {
            break;
        }

        const call = readCall(tokens, index);

        if (!call) {
            continue;
        }

        calls++;
        appendCallHints(module, resolver, tokens, call, result);
        /* Вложенные вызовы разбираются своим шагом цикла. */
    }

    return result;
}

interface IRslCallSite {
    callee: IRslToken;
    /** Индекс токена «(». */
    open: number;
    /** Индексы первых токенов аргументов. */
    arguments: number[];
    /** Есть ли аргумент без закрывающей скобки: такой вызов пропускается. */
    closed: boolean;
}

/** Вызов, начинающийся с этого токена, если он тут есть. */
function readCall(
    tokens: readonly IRslToken[],
    index: number
): IRslCallSite | undefined {
    const callee = tokens[index];
    const open = tokens[index + 1];

    if (
        callee.kind !== "identifier" ||
        !open ||
        open.kind !== "symbol" ||
        open.raw !== "("
    ) {
        return undefined;
    }

    const starts: number[] = [];
    let depth = 0;

    for (let cursor = index + 1; cursor < tokens.length; cursor++) {
        const token = tokens[cursor];

        if (token.kind === "symbol" && OPENING.has(token.raw)) {
            depth++;

            if (depth === 1 && isArgumentStart(tokens, cursor + 1)) {
                starts.push(cursor + 1);
            }

            continue;
        }

        if (token.kind === "symbol" && CLOSING.has(token.raw)) {
            depth--;

            if (depth === 0) {
                return {
                    callee,
                    open: index + 1,
                    arguments: starts,
                    closed: token.raw === ")"
                };
            }

            continue;
        }

        if (depth === 1 && token.kind === "symbol" && token.raw === ",") {
            if (isArgumentStart(tokens, cursor + 1)) {
                starts.push(cursor + 1);
            }

            continue;
        }
    }

    return undefined;
}

const OPENING = new Set(["(", "[", "{"]);
const CLOSING = new Set([")", "]", "}"]);

/** Начинается ли тут аргумент, а не конец списка. */
function isArgumentStart(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const token = tokens[index];

    return token !== undefined &&
        !(token.kind === "symbol" && CLOSING.has(token.raw));
}

function appendCallHints(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    tokens: readonly IRslToken[],
    call: IRslCallSite,
    result: InlayHint[]
): void {
    if (!call.closed || call.arguments.length === 0) {
        return;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        call.callee.start
    );

    if (
        !resolved ||
        (
            resolved.symbol.kind !== CompletionItemKind.Function &&
            resolved.symbol.kind !== CompletionItemKind.Method
        )
    ) {
        return;
    }

    const names = extractParameterLabels(resolved.symbol).map(parameterName);

    /*
     * Аргументов больше, чем параметров.
     *
     * Либо разрешилось не то объявление, либо вызов написан неверно. В обоих
     * случаях подсказок не будет: сообщать об ошибке — не дело подсказки, а
     * приписать чужие имена к аргументам хуже, чем промолчать.
     */
    if (names.length === 0 || call.arguments.length > names.length) {
        return;
    }

    for (let index = 0; index < call.arguments.length; index++) {
        const name = names[index];
        const argument = tokens[call.arguments[index]];

        if (!name || !argument || isObvious(name, tokens, call, index)) {
            continue;
        }

        result.push({
            position: positionAtOffset(module.lex.lineStarts, argument.start),
            label: name + ":",
            kind: InlayHintKind.Parameter,
            paddingRight: true,
            tooltip: "Имя параметра из объявления " + resolved.symbol.name
        });
    }
}

/**
 * Имя параметра из его записи в сигнатуре.
 *
 * В сигнатуре параметр бывает записан как `Var doc`, `doc: TBFile`, `doc = 0`.
 * Имя — это идентификатор перед типом и значением по умолчанию, без модификатора.
 */
function parameterName(label: string): string {
    const text = label.split("=")[0].split(":")[0].trim();
    const words = text.split(/\s+/).filter(Boolean);
    const last = words[words.length - 1] || "";

    /* Имена в RSL бывают кириллическими: ASCII-шаблон их отбрасывал. */
    return PARAMETER_NAME_PATTERN.test(last) ? last : "";
}

/**
 * Очевидна ли подсказка.
 *
 * Аргумент, записанный тем же именем, что и параметр, в подсказке не
 * нуждается: `Send(document)` при параметре `document`. То же для обращения к
 * полю — `Send(this.document)`: последнее имя цепочки и есть ответ на вопрос
 * «что это за аргумент».
 */
function isObvious(
    name: string,
    tokens: readonly IRslToken[],
    call: IRslCallSite,
    index: number
): boolean {
    const normalized = normalizeIdentifier(name);
    const end = index + 1 < call.arguments.length
        ? call.arguments[index + 1] - 1
        : tokens.length;
    let last = "";

    for (
        let cursor = call.arguments[index];
        cursor < end && cursor < tokens.length;
        cursor++
    ) {
        const token = tokens[cursor];

        if (token.kind === "symbol" && token.raw === ",") {
            break;
        }

        if (token.kind === "symbol" && CLOSING.has(token.raw)) {
            break;
        }

        if (token.kind === "identifier") {
            last = normalizeIdentifier(token.value);
            continue;
        }

        if (token.kind === "symbol" && token.raw === ".") {
            continue;
        }

        /* Аргумент — выражение, а не имя: подсказка небесполезна. */
        return false;
    }

    return last === normalized;
}

function firstTokenAt(tokens: readonly IRslToken[], offset: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >> 1;

        if (tokens[middle].end < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}

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
