import { CompletionItem, CompletionItemKind } from "vscode-languageserver";

import {
    getFastDocumentDeclarations,
    type IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IRslDeclarationDescriptor } from "../analysis/declarationExtractor";

/**
 * Объявления файла без ожидания полной модели.
 *
 * Нужны там, где ждать нечем: пользователь нажал Ctrl+Space или точку, а модель
 * этой версии ещё строится. Прежде в таком случае возвращался пустой список —
 * то есть подсказка выглядела так, будто в файле ничего нет.
 *
 * Это заведомо неполный ответ, и он таким и помечается: состав взят
 * сканированием токенов, без областей видимости и вывода типов. Локальных
 * переменных Macro здесь не будет вовсе — быстрый снимок их не извлекает, он
 * строится для Structure. Остаются классы, макропроцедуры, методы и параметры,
 * то есть ровно то, что чаще всего и вызывают. Как только модель готова, клиент
 * перезапрашивает список и получает точный.
 */
export function buildRslFastCompletions(
    snapshot: IFastDocumentSnapshot,
    offset: number
): CompletionItem[] {
    const declarations = getFastDocumentDeclarations(snapshot).declarations;
    const items = new Map<string, CompletionItem>();

    const add = (
        declaration: IRslDeclarationDescriptor,
        insideCurrentBlock: boolean
    ): void => {
        /*
         * Локальные переменные чужого Macro в подсказку не попадают: областей
         * видимости здесь нет, и предложить их значило бы предложить то, что
         * компилятор в этой позиции не увидит. Верхний уровень виден всегда.
         */
        if (!insideCurrentBlock && declaration.kind === "variable") {
            return;
        }

        const key = declaration.name.toLowerCase();

        if (!items.has(key)) {
            items.set(key, {
                label: declaration.name,
                kind: completionKind(declaration),
                detail: declaration.typeName || undefined,
                /*
                 * Сортировка ниже обычной: точный список придёт следом, и
                 * приблизительные имена не должны опережать его.
                 */
                sortText: `${declaration.name}`
            });
        }
    };

    const visit = (
        list: readonly IRslDeclarationDescriptor[],
        insideCurrentBlock: boolean
    ): void => {
        for (const declaration of list) {
            add(declaration, insideCurrentBlock);
            const inside = insideCurrentBlock ||
                (offset >= declaration.start && offset <= declaration.end);
            visit(declaration.children, inside);
        }
    };

    visit(declarations, false);
    return Array.from(items.values());
}

/**
 * Члены объекта до готовности модели: `MessageText.` сразу после правки.
 *
 * Тип получателя ищется в тексте рядом — по написанному типу `Var x: TFile`
 * или по присваиванию класса `x = TStringList` и `x = TStringList()`. Это
 * ровно те два случая, в которых тип виден без анализа; всё сложнее (вызов
 * процедуры, член другого объекта, ветвление) остаётся полной модели.
 *
 * Возвращает undefined, если это не обращение к члену или тип не опознан:
 * тогда вызывающий отдаёт обычный приблизительный список, а не пустой.
 */
export function buildRslFastMemberCompletions(
    snapshot: IFastDocumentSnapshot,
    offset: number,
    findClassMembers: (className: string) => CompletionItem[] | undefined
): CompletionItem[] | undefined {
    const receiver = findReceiverBeforeDot(snapshot.lex.tokens, offset);

    if (!receiver) {
        return undefined;
    }

    const className = findReceiverType(
        snapshot.lex.tokens,
        receiver.name,
        receiver.index
    );

    return className ? findClassMembers(className) : undefined;
}

/** Имя перед точкой, на которой стоит курсор. */
function findReceiverBeforeDot(
    tokens: readonly IRslToken[],
    offset: number
): { name: string; index: number } | undefined {
    let dotIndex = -1;

    /*
     * Ищем последний значимый токен перед курсором. Двоичный поиск здесь не
     * нужен: обращение к члену начинается в паре токенов от позиции запроса.
     */
    for (let index = tokens.length - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.end > offset || token.kind === "whitespace" ||
            token.kind === "newline") {
            continue;
        }

        dotIndex = token.kind === "symbol" && token.raw === "." ? index : -1;
        break;
    }

    if (dotIndex <= 0) {
        return undefined;
    }

    for (let index = dotIndex - 1; index >= 0; index--) {
        const token = tokens[index];

        if (token.kind === "whitespace" || token.kind === "newline") {
            continue;
        }

        return token.kind === "identifier"
            ? { name: normalizeIdentifier(token.value), index }
            : undefined;
    }

    return undefined;
}

/**
 * Тип получателя по ближайшему предшествующему объявлению или присваиванию.
 *
 * Поиск идёт назад от места обращения: ближе к нему — вернее. Ограничен
 * началом файла, но на практике останавливается на первом же совпадении.
 */
function findReceiverType(
    tokens: readonly IRslToken[],
    name: string,
    fromIndex: number
): string | undefined {
    for (let index = fromIndex - 1; index >= 0; index--) {
        const token = tokens[index];

        if (
            token.kind !== "identifier" ||
            normalizeIdentifier(token.value) !== name
        ) {
            continue;
        }

        const next = nextSignificant(tokens, index);

        if (!next) {
            continue;
        }

        /* `Var x: TFile` — тип написан прямо. */
        if (next.token.kind === "symbol" && next.token.raw === ":") {
            const type = nextSignificant(tokens, next.index);

            if (type?.token.kind === "identifier") {
                return type.token.value;
            }

            continue;
        }

        /* `x = TStringList` и `x = TStringList()` — присвоен класс. */
        if (next.token.kind === "symbol" && next.token.raw === "=") {
            const value = nextSignificant(tokens, next.index);

            if (value?.token.kind !== "identifier") {
                continue;
            }

            const after = nextSignificant(tokens, value.index);
            const isCallOrEnd = !after ||
                (after.token.kind === "symbol" &&
                    (after.token.raw === "(" || after.token.raw === ";"));

            if (isCallOrEnd) {
                return value.token.value;
            }
        }
    }

    return undefined;
}

function nextSignificant(
    tokens: readonly IRslToken[],
    index: number
): { token: IRslToken; index: number } | undefined {
    for (let position = index + 1; position < tokens.length; position++) {
        const token = tokens[position];

        if (
            token.kind === "whitespace" || token.kind === "newline" ||
            token.kind === "comment"
        ) {
            continue;
        }

        return { token, index: position };
    }

    return undefined;
}

function completionKind(
    declaration: IRslDeclarationDescriptor
): CompletionItemKind {
    if (declaration.kind === "class") {
        return CompletionItemKind.Class;
    }

    if (declaration.kind === "macro") {
        return declaration.isMethod
            ? CompletionItemKind.Method
            : CompletionItemKind.Function;
    }

    if (declaration.isConstant) {
        return CompletionItemKind.Constant;
    }

    return declaration.isProperty
        ? CompletionItemKind.Property
        : CompletionItemKind.Variable;
}
