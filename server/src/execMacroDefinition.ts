import {
    cachedSignificantTokens,
    IRslToken,
    lexRsl
} from "./lexer";
import {
    callbackNameFromArgument,
    getProcedureCallbackSpec,
    isPositionalHandlerArgument,
    isProcedureCallbackArgument
} from "./features/procedureCallbackCatalog";

export type DynamicDefinitionKind =
    | "macro"
    | "fileMacro"
    | "file";

export interface IDynamicDefinitionTarget {
    kind: DynamicDefinitionKind;
    macroName?: string;
    moduleName?: string;
}

/**
 * Упоминание подключаемого модуля в директиве Import.
 */
/**
 * Ссылка на файл модуля в директиве Import.
 *
 * Это ссылка на файл, а не на символ: её разрешает каталог проекта по имени
 * файла, и разбор для неё не нужен. Обычная строка с тем же текстом ссылкой не
 * является — `MsgBox("lib.mac")` остаётся текстом сообщения.
 */
export interface IImportDefinitionTarget {
    kind: "import-file";
    /** Имя, как оно написано в файле: без кавычек и без нормализации. */
    rawText: string;
    /** Имя файла модуля после нормализации: регистр, разделители, расширение. */
    moduleName: string;
    /**
     * Весь фрагмент директивы, включая кавычки.
     *
     * По нему диагностика подчёркивает импорт целиком, а переименование файла
     * заменяет ссылку вместе с кавычками.
     */
    start: number;
    end: number;
    /**
     * Точный диапазон самого имени: кавычки в него не входят.
     *
     * По нему решается, попал ли курсор в ссылку, и по нему же редактор
     * подсвечивает переход. Кавычка частью имени файла не является, и
     * подчёркивать её как ссылку незачем.
     */
    nameStart: number;
    nameEnd: number;
}

interface ICallArgument {
    tokens: IRslToken[];
    stringToken?: IRslToken;
}

interface IParsedCall {
    name: string;
    arguments: ICallArgument[];
    openIndex: number;
    closeIndex: number;
}

export interface IProcedureReferenceTarget {
    kind: "macro" | "method";
    name: string;
    /** Позиция объекта в R2M(object, "Method"). */
    receiverOffset?: number;
}

const DYNAMIC_CALLS: { [name: string]: boolean } = {
    execmacro: true,
    execmacro2: true,
    execmacrofile: true
};

/**
 * Определяет цель перехода для строковых параметров ExecMacro,
 * ExecMacro2 и ExecMacroFile.
 */
export function GetDynamicDefinitionTarget(
    source: string,
    offset: number
): IDynamicDefinitionTarget | undefined {
    return GetDynamicDefinitionTargetFromTokens(
        lexRsl(source || "").tokens,
        offset
    );
}

/** Использует уже готовый lexer-поток и не сканирует документ повторно. */
export function GetDynamicDefinitionTargetFromTokens(
    sourceTokens: IRslToken[],
    offset: number
): IDynamicDefinitionTarget | undefined {
    const tokens = cachedSignificantTokens(sourceTokens);
    const calls = findDynamicCalls(tokens);

    /*
     * Для вложенных вызовов сначала проверяем самый узкий диапазон.
     */
    calls.sort((left, right) =>
        (left.closeIndex - left.openIndex) -
        (right.closeIndex - right.openIndex)
    );

    for (const call of calls) {
        const selectedArgument = findSelectedStringArgument(
            call.arguments,
            offset
        );

        if (selectedArgument < 0) {
            continue;
        }

        if (
            call.name === "execmacro" ||
            call.name === "execmacro2"
        ) {
            if (selectedArgument !== 0) {
                continue;
            }

            const macroName = getStringArgument(call.arguments, 0);

            return macroName
                ? {
                    kind: "macro",
                    macroName
                }
                : undefined;
        }

        if (call.name === "execmacrofile") {
            if (selectedArgument !== 0 && selectedArgument !== 1) {
                continue;
            }

            const moduleName = getStringArgument(call.arguments, 0);

            if (!moduleName) {
                return undefined;
            }

            const macroName = getStringArgument(call.arguments, 1);

            return macroName
                ? {
                    kind: "fileMacro",
                    moduleName,
                    macroName
                }
                : {
                    kind: "file",
                    moduleName
                };
        }
    }

    return undefined;
}

/**
 * Определяет строковое имя callback-процедуры в документированных API RSL.
 * Ссылки вида @Proc обслуживает обычный resolver; здесь нужен именно переход
 * со строки и со второго параметра R2M.
 */
export function GetProcedureReferenceTargetFromTokens(
    sourceTokens: IRslToken[],
    offset: number
): IProcedureReferenceTarget | undefined {
    const tokens = cachedSignificantTokens(sourceTokens);
    const calls = findCalls(tokens, name =>
        name === "r2m" || !!getProcedureCallbackSpec(name)
    ).sort((left, right) =>
        (left.closeIndex - left.openIndex) -
        (right.closeIndex - right.openIndex)
    );

    for (const call of calls) {
        const argumentIndex = findSelectedStringArgument(
            call.arguments,
            offset
        );
        if (argumentIndex < 0) {
            continue;
        }

        const name = getStringArgument(call.arguments, argumentIndex);
        if (!name) {
            continue;
        }

        if (call.name === "r2m" && argumentIndex === 1) {
            const receiver = call.arguments[0]?.tokens.find(token =>
                token.kind === "identifier"
            );
            return receiver
                ? {
                    kind: "method",
                    name,
                    receiverOffset: receiver.start
                }
                : undefined;
        }

        if (isProcedureCallbackArgument(call.name, argumentIndex)) {
            return { kind: "macro", name };
        }
    }

    return undefined;
}

/** Имена Macro, фактически переданных как позиционные обработчики. */
export function GetPositionalHandlerNamesFromTokens(
    sourceTokens: IRslToken[]
): Set<string> {
    const tokens = cachedSignificantTokens(sourceTokens);
    const result = new Set<string>();

    for (const call of findCalls(tokens, name =>
        getProcedureCallbackSpec(name)?.positionalHandler === true
    )) {
        for (let index = 0; index < call.arguments.length; index++) {
            if (!isPositionalHandlerArgument(call.name, index)) {
                continue;
            }
            const name = callbackNameFromArgument(call.arguments[index].tokens);
            if (name) {
                result.add(name.trim().toLowerCase());
            }
        }
    }

    return result;
}

/**
 * Определяет модуль Import, на имени которого находится курсор.
 *
 * Поддерживаются:
 *
 *     Import common, utils;
 *     Import "cards.mac";
 *     Import folder\payments;
 */
export function GetImportDefinitionTarget(
    source: string,
    offset: number
): IImportDefinitionTarget | undefined {
    return GetImportDefinitionTargetFromTokens(
        lexRsl(source || "").tokens,
        offset
    );
}

/** Использует уже готовый lexer-поток и не сканирует документ повторно. */
export function GetImportDefinitionTargetFromTokens(
    sourceTokens: IRslToken[],
    offset: number
): IImportDefinitionTarget | undefined {
    return getImportReferencesFromTokens(sourceTokens).find(reference =>
        reference.nameStart <= offset &&
        offset < reference.nameEnd
    );
}

/**
 * Возвращает имена файлов из директив Import.
 */

/**
 * Возвращает строковые имена Macro из ExecMacro/ExecMacro2.
 * Используется диагностикой неиспользуемых Import.
 */
export function GetDynamicMacroReferences(source: string): string[] {
    return GetDynamicMacroReferencesFromTokens(
        lexRsl(source || "").tokens
    );
}

export function GetDynamicMacroReferencesFromTokens(
    sourceTokens: IRslToken[]
): string[] {
    const tokens = cachedSignificantTokens(sourceTokens);
    const result: string[] = [];

    for (const call of findDynamicCalls(tokens)) {
        if (call.name !== "execmacro" && call.name !== "execmacro2") {
            continue;
        }

        const name = getStringArgument(call.arguments, 0);

        if (name) {
            result.push(name);
        }
    }

    return result;
}

/**
 * Ссылка на файл модуля строкой: первый аргумент ExecMacroFile.
 *
 * Именно первый и именно у этого вызова. Строка, равная имени файла, сама по
 * себе ссылкой не является: MsgBox("lib.mac") — это текст сообщения, и
 * переименование файла не имеет права его менять.
 */
export interface IRslMacroFileReference {
    /** Значение строки без кавычек, как написано. */
    value: string;
    /** Токен строки: по нему считается точный диапазон правки. */
    token: IRslToken;
}

export function GetMacroFileReferencesFromTokens(
    sourceTokens: IRslToken[]
): IRslMacroFileReference[] {
    const tokens = cachedSignificantTokens(sourceTokens);
    const result: IRslMacroFileReference[] = [];

    for (const call of findDynamicCalls(tokens)) {
        if (call.name !== "execmacrofile") {
            continue;
        }

        const token = call.arguments[0]?.stringToken;

        if (token) {
            result.push({ value: token.value.trim(), token });
        }
    }

    return result;
}

export function GetMacroFileReferences(
    source: string
): IRslMacroFileReference[] {
    return GetMacroFileReferencesFromTokens(lexRsl(source || "").tokens);
}

/**
 * Имена файлов, на которые файл ссылается строкой.
 *
 * Только имя файла, в нижнем регистре и без пути: каталогу нужен ключ поиска,
 * а точный диапазон правки считается заново по тексту при переименовании.
 */
export function GetMacroFileReferenceNamesFromTokens(
    sourceTokens: IRslToken[]
): string[] {
    const result = new Set<string>();

    for (const reference of GetMacroFileReferencesFromTokens(sourceTokens)) {
        const normalized = reference.value.split("\\").join("/");
        const name = normalized.slice(normalized.lastIndexOf("/") + 1);

        if (name) {
            result.add(name.toLowerCase());
        }
    }

    return [...result].sort();
}

export function GetImportDefinitionTargets(
    source: string
): IImportDefinitionTarget[] {
    return GetImportDefinitionTargetsFromTokens(
        lexRsl(source || "").tokens
    );
}

export function GetImportDefinitionTargetsFromTokens(
    sourceTokens: IRslToken[]
): IImportDefinitionTarget[] {
    return getImportReferencesFromTokens(sourceTokens);
}

/**
 * Возвращает имена файлов из директив Import.
 */
export function GetImportedMacroFiles(source: string): string[] {
    return GetImportedMacroFilesFromTokens(
        lexRsl(source || "").tokens
    );
}

export function GetImportedMacroFilesFromTokens(
    sourceTokens: IRslToken[]
): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    for (const reference of getImportReferencesFromTokens(sourceTokens)) {
        const normalized = reference.moduleName
            .replace(/\\/g, "/")
            .toLowerCase();

        if (seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        result.push(reference.moduleName);
    }

    return result;
}

/*
 * Ссылки Import запоминаются на версию token stream.
 *
 * Их спрашивают несколько проверок диагностики, и каждая заново фильтровала
 * весь поток токенов и заново обходила его. В профиле диагностики это была
 * самая дорогая опознаваемая строка. Ключ — сам массив токенов: каждый lex
 * возвращает новый, поэтому устаревший ответ отдать невозможно.
 */
const importReferencesCache = new WeakMap<
    readonly IRslToken[],
    IImportDefinitionTarget[]
>();

function getImportReferencesFromTokens(
    sourceTokens: IRslToken[]
): IImportDefinitionTarget[] {
    const known = importReferencesCache.get(sourceTokens);

    if (known) {
        return known;
    }

    const references = computeImportReferences(sourceTokens);
    importReferencesCache.set(sourceTokens, references);
    return references;
}

export interface IRslImportReferenceScanner {
    step(token: IRslToken, index: number): void;
    finish(): IImportDefinitionTarget[];
}

/**
 * Поиск директив Import, который можно прервать.
 *
 * Обход значимых токенов сам по себе стоит около пяти миллисекунд на файле
 * 700 КБ — не из-за разбора директив, которых в файле десяток, а из-за самой
 * длины потока. Фоновому расчёту это нельзя делать одним куском, поэтому
 * состояние обхода живёт в замыкании: разобранная директива отмечает, до какого
 * токена дальше идти нечего.
 */
export function createImportReferenceScanner(
    sourceTokens: IRslToken[]
): IRslImportReferenceScanner {
    /* Тот же отфильтрованный поток, что и у остальных: он уже посчитан. */
    const tokens = cachedSignificantTokens(sourceTokens);
    const result: IImportDefinitionTarget[] = [];
    let resumeAt = 0;

    const step = (token: IRslToken, index: number): void => {
        if (index < resumeAt || !isImportWord(token)) {
            return;
        }

        let current: IRslToken[] = [];

        for (let cursor = index + 1; cursor < tokens.length; cursor++) {
            const part = tokens[cursor];

            if (
                part.kind === "symbol" &&
                (part.raw === "," || part.raw === ";")
            ) {
                addImportReference(current, result);
                current = [];

                if (part.raw === ";") {
                    resumeAt = cursor + 1;
                    return;
                }

                continue;
            }

            /*
             * В повреждённом коде без ; не захватываем следующую
             * директиву Import как часть имени предыдущего файла.
             */
            if (current.length > 0 && isImportWord(part)) {
                addImportReference(current, result);
                resumeAt = cursor;
                return;
            }

            current.push(part);
        }

        /* Директива не закрыта до конца файла: дальше искать нечего. */
        addImportReference(current, result);
        resumeAt = tokens.length;
    };

    return {
        step,
        finish: () => {
            importReferencesCache.set(sourceTokens, result);

            return result;
        }
    };
}

/**
 * Слово Import.
 *
 * Длина проверяется раньше регистра: приведение к нижнему регистру создаёт
 * строку на каждый идентификатор файла, а слово Import — ровно шесть символов.
 */
function isImportWord(token: IRslToken): boolean {
    return token.kind === "identifier" &&
        token.value.length === 6 &&
        token.value.toLowerCase() === "import";
}

function computeImportReferences(
    sourceTokens: IRslToken[]
): IImportDefinitionTarget[] {
    const scanner = createImportReferenceScanner(sourceTokens);
    const tokens = cachedSignificantTokens(sourceTokens);

    for (let index = 0; index < tokens.length; index++) {
        scanner.step(tokens[index], index);
    }

    return scanner.finish();
}

function addImportReference(
    tokens: IRslToken[],
    result: IImportDefinitionTarget[]
): void {
    if (tokens.length === 0) {
        return;
    }

    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    let raw: string;
    let nameStart = first.start;
    let nameEnd = last.end;

    if (tokens.length === 1 && first.kind === "string") {
        /*
         * Берётся исходный текст строки, а не её значение.
         *
         * Значение строки прошло через escape-последовательности лексера, и
         * `"sub\checkaml.mac"` превращается в `subcheckaml.mac`: обратная
         * косая черта там понята как escape. В имени файла она разделитель
         * каталогов, и терять её нельзя.
         */
        raw = first.raw.slice(1, -1).trim();
        nameStart = first.start + 1;
        nameEnd = last.end - 1;
    } else {
        raw = tokens.map(token => token.raw).join("").trim();
    }

    if (!raw) {
        return;
    }

    const value = /\.mac$/i.test(raw) ? raw : raw + ".mac";

    result.push({
        kind: "import-file",
        rawText: raw,
        moduleName: value,
        start: first.start,
        end: last.end,
        nameStart,
        nameEnd
    });
}

function findDynamicCalls(tokens: IRslToken[]): IParsedCall[] {
    return findCalls(tokens, name => !!DYNAMIC_CALLS[name]);
}

function findCalls(
    tokens: IRslToken[],
    accepts: (name: string) => boolean
): IParsedCall[] {
    const result: IParsedCall[] = [];

    for (let index = 0; index < tokens.length - 1; index++) {
        const nameToken = tokens[index];
        const openToken = tokens[index + 1];

        if (
            nameToken.kind !== "identifier" ||
            openToken.kind !== "symbol" ||
            openToken.raw !== "("
        ) {
            continue;
        }

        const name = nameToken.value.toLowerCase();

        if (!accepts(name)) {
            continue;
        }

        const parsed = parseCallArguments(tokens, index + 1);

        if (!parsed) {
            continue;
        }

        result.push({
            name,
            arguments: parsed.arguments,
            openIndex: openToken.start,
            closeIndex: tokens[parsed.closeIndex].end
        });
    }

    return result;
}

function parseCallArguments(
    tokens: IRslToken[],
    openIndex: number
): { arguments: ICallArgument[]; closeIndex: number } | undefined {
    const result: ICallArgument[] = [];
    let current: IRslToken[] = [];
    let parenthesisDepth = 1;
    let braceDepth = 0;

    for (let index = openIndex + 1; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind === "symbol") {
            if (token.raw === "(") {
                parenthesisDepth++;
                current.push(token);
                continue;
            }

            if (token.raw === ")") {
                parenthesisDepth--;

                if (parenthesisDepth === 0) {
                    if (current.length > 0 || result.length > 0) {
                        result.push(createArgument(current));
                    }

                    return {
                        arguments: result,
                        closeIndex: index
                    };
                }

                current.push(token);
                continue;
            }

            if (token.raw === "{") {
                braceDepth++;
                current.push(token);
                continue;
            }

            if (token.raw === "}" && braceDepth > 0) {
                braceDepth--;
                current.push(token);
                continue;
            }

            if (
                token.raw === "," &&
                parenthesisDepth === 1 &&
                braceDepth === 0
            ) {
                result.push(createArgument(current));
                current = [];
                continue;
            }
        }

        current.push(token);
    }

    return undefined;
}

function createArgument(tokens: IRslToken[]): ICallArgument {
    return {
        tokens,
        stringToken:
            tokens.length === 1 && tokens[0].kind === "string"
                ? tokens[0]
                : undefined
    };
}

function findSelectedStringArgument(
    argumentsList: ICallArgument[],
    offset: number
): number {
    for (let index = 0; index < argumentsList.length; index++) {
        const token = argumentsList[index].stringToken;

        if (
            token &&
            token.start <= offset &&
            offset <= token.end
        ) {
            return index;
        }
    }

    return -1;
}

function getStringArgument(
    argumentsList: ICallArgument[],
    index: number
): string {
    if (
        index < 0 ||
        index >= argumentsList.length ||
        !argumentsList[index].stringToken
    ) {
        return "";
    }

    return argumentsList[index].stringToken!.value.trim();
}
