import * as fs from "fs";
import * as path from "path";

import { CompletionItemKind, type CompletionItem } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import { resolveExtensionFile } from "../paths";
import { BuiltinSymbol } from "./builtinSymbol";
import type { IRslBuiltinDefinition } from "./standardLibraryData";

/**
 * Классы и процедуры прикладных модулей платформы (CommonInter и прочие).
 *
 * Отдельно от стандартной библиотеки по двум причинам.
 *
 * Доступность: символ модуля существует только там, где модуль импортирован,
 * поэтому предлагать его наравне со встроенными неверно — подсказка звала бы
 * имя, которого в файле нет.
 *
 * Объём: 61 модуль, 255 классов, 2353 члена и 1555 процедур — 798 КБ. Одним
 * файлом это пришлось бы разбирать и держать в памяти целиком ради одного-двух
 * импортированных модулей (PaymInter сам по себе 186 КБ). Поэтому данные лежат
 * по файлу на модуль, а индекс (5 КБ) отвечает на вопрос «знаем ли мы такой
 * модуль» без чтения состава.
 *
 * Чтение НИКОГДА не происходит в обработчике интерактивного запроса: состав
 * готовится по событию появления списка Import у документа (см. ensureModules).
 * Модуль, который к моменту запроса ещё не прочитан, просто не даёт символов —
 * они появятся следующим запросом. Синхронно читать 186 КБ на нажатие
 * Ctrl+Space значило бы задержать ответ ровно там, где это заметнее всего.
 */
export interface IPlatformModuleMember {
    name: string;
    isMethod: boolean;
    signature?: string;
    typeName?: string;
    description: string;
}

export interface IPlatformModuleClass {
    name: string;
    base?: string;
    summary: string;
    members: readonly IPlatformModuleMember[];
}

export interface IPlatformModuleProcedure {
    name: string;
    signature: string;
    description: string;
}

interface IPlatformModuleIndex {
    version: number;
    modules: Record<string, { file: string }>;
}

interface IPlatformModuleBody {
    version: number;
    classes?: IPlatformModuleClass[];
    procedures?: IPlatformModuleProcedure[];
}

interface ILoadedModule {
    /**
     * Все символы модуля — классы и процедуры.
     *
     * Отдельно от classes: Hover, Signature Help и семантическая подсветка
     * спрашивают символ по имени, не зная, класс это или процедура.
     */
    symbols: ReadonlyMap<string, RslSymbol>;
    classes: ReadonlyMap<string, RslSymbol>;
    completions: readonly CompletionItem[];
    /** Тип результата процедуры: нужен для вывода типа переменной. */
    resultTypes: ReadonlyMap<string, string>;
}

/** Формат данных; несовпадение версии выключает каталог. */
const SUPPORTED_VERSION = 2;
const DIRECTORY = "platform-modules";

export class PlatformModuleCatalog {
    private indexLoaded = false;
    private indexFailed = false;
    /** Ключ — имя модуля в нижнем регистре, значение — имя файла состава. */
    private files = new Map<string, string>();
    private loaded = new Map<string, ILoadedModule>();
    private failedModules = new Set<string>();

    constructor(private options: { log(message: string): void }) {}

    /** Индекс модулей: 5 КБ, читается один раз. */
    private ensureIndex(): void {
        if (this.indexLoaded || this.indexFailed) {
            return;
        }

        const filePath = path.join(this.directory(), "index.json");

        try {
            const parsed = JSON.parse(
                fs.readFileSync(filePath, "utf8")
            ) as IPlatformModuleIndex;

            if (parsed.version !== SUPPORTED_VERSION) {
                this.indexFailed = true;
                this.options.log(
                    "Каталог прикладных модулей не подключён: версия формата " +
                    `${parsed.version}, поддерживается ${SUPPORTED_VERSION}`
                );
                return;
            }

            for (const [name, entry] of Object.entries(parsed.modules || {})) {
                this.files.set(normalizeIdentifier(name), entry.file);
            }
            this.indexLoaded = true;
        } catch (error) {
            /*
             * Отсутствующий или испорченный файл не должен ронять сервер: без
             * него просто не будет подсказок по прикладным модулям, а весь
             * остальной язык обязан продолжать работать.
             */
            this.indexFailed = true;
            this.options.log(
                `Индекс прикладных модулей не прочитан: ${filePath}; ` +
                errorToString(error)
            );
        }
    }

    /**
     * Готовит состав перечисленных модулей заранее, вне пути запроса.
     *
     * Вызывается, когда у документа стал известен список Import — то есть
     * после разбора, а не из обработчика Completion.
     */
    ensureModules(moduleNames: readonly string[]): void {
        this.ensureIndex();

        for (const moduleName of moduleNames) {
            this.loadModule(normalizeIdentifier(moduleName));
        }
    }

    /** Знает ли каталог такой модуль; состав при этом не читается. */
    knowsModule(moduleName: string): boolean {
        this.ensureIndex();
        return this.files.has(normalizeIdentifier(moduleName));
    }

    get ready(): boolean {
        this.ensureIndex();
        return this.indexLoaded;
    }

    get moduleCount(): number {
        this.ensureIndex();
        return this.files.size;
    }

    get loadedCount(): number {
        return this.loaded.size;
    }

    /**
     * Класс, видимый через один из перечисленных модулей.
     *
     * Список модулей вычисляет вызывающий: только он знает, какие Import стоят
     * в файле и какие из них уже разобраны.
     */
    findClass(
        moduleNames: readonly string[],
        className: string
    ): RslSymbol | undefined {
        const key = normalizeIdentifier(className);

        for (const moduleName of moduleNames) {
            const symbol = this.loaded
                .get(normalizeIdentifier(moduleName))
                ?.classes.get(key);

            if (symbol) {
                return symbol;
            }
        }

        return undefined;
    }

    /**
     * Любой символ модуля по имени — класс или процедура.
     *
     * Нужен Hover, Signature Help и семантической подсветке: без него имя из
     * прикладного модуля предлагалось в Completion, но при наведении и при
     * подсветке оставалось неизвестным.
     */
    findSymbol(
        moduleNames: readonly string[],
        name: string
    ): RslSymbol | undefined {
        const key = normalizeIdentifier(name);

        for (const moduleName of moduleNames) {
            const symbol = this.loaded
                .get(normalizeIdentifier(moduleName))
                ?.symbols.get(key);

            if (symbol) {
                return symbol;
            }
        }

        return undefined;
    }

    /** Объявленный тип результата процедуры модуля, если он известен. */
    findResultType(
        moduleNames: readonly string[],
        procedureName: string
    ): string | undefined {
        const key = normalizeIdentifier(procedureName);

        for (const moduleName of moduleNames) {
            const found = this.loaded
                .get(normalizeIdentifier(moduleName))
                ?.resultTypes.get(key);

            if (found) {
                return found;
            }
        }

        return undefined;
    }

    /** Элементы Completion уже прочитанных из перечисленных модулей. */
    completionItems(moduleNames: readonly string[]): CompletionItem[] {
        const result: CompletionItem[] = [];

        for (const moduleName of moduleNames) {
            const module = this.loaded.get(normalizeIdentifier(moduleName));

            if (module) {
                result.push(...module.completions);
            }
        }

        return result;
    }

    private directory(): string {
        return process.env.RSL_PLATFORM_MODULES_DIR ||
            resolveExtensionFile(DIRECTORY);
    }

    private loadModule(key: string): void {
        if (this.loaded.has(key) || this.failedModules.has(key)) {
            return;
        }

        const file = this.files.get(key);

        if (!file) {
            return;
        }

        const filePath = path.join(this.directory(), file);

        try {
            const parsed = JSON.parse(
                fs.readFileSync(filePath, "utf8")
            ) as IPlatformModuleBody;

            if (parsed.version !== SUPPORTED_VERSION) {
                throw new Error(`версия формата ${parsed.version}`);
            }

            this.loaded.set(key, build(key, parsed));
        } catch (error) {
            this.failedModules.add(key);
            this.options.log(
                `Состав прикладного модуля не прочитан: ${filePath}; ` +
                errorToString(error)
            );
        }
    }
}

function build(key: string, body: IPlatformModuleBody): ILoadedModule {
    const symbols = new Map<string, RslSymbol>();
    const classes = new Map<string, RslSymbol>();
    const completions: CompletionItem[] = [];
    const resultTypes = new Map<string, string>();

    for (const item of body.classes || []) {
        const symbol = new BuiltinSymbol(classDefinition(item));
        const name = normalizeIdentifier(item.name);
        const semantic = symbol.toRslSymbol();
        classes.set(name, semantic);
        symbols.set(name, semantic);
        completions.push(moduleCompletion(symbol, key));
    }

    for (const item of body.procedures || []) {
        const symbol = new BuiltinSymbol(procedureDefinition(item));
        const name = normalizeIdentifier(item.name);
        completions.push(moduleCompletion(symbol, key));

        /* Класс с таким именем важнее: он несёт ещё и состав членов. */
        if (!symbols.has(name)) {
            symbols.set(name, symbol.toRslSymbol());
        }

        if (symbol.typeName && symbol.typeName !== "Variant") {
            resultTypes.set(name, symbol.typeName);
        }
    }

    return {
        symbols,
        classes,
        completions: Object.freeze(completions),
        resultTypes
    };
}

/**
 * Символ модуля уступает объявлениям файла и стандартной библиотеке.
 *
 * Он доступен, но менее вероятен как ответ: имён здесь тысячи, и всплывать
 * выше локальной переменной они не должны.
 */
function moduleCompletion(
    symbol: BuiltinSymbol,
    moduleName: string
): CompletionItem {
    return Object.freeze({
        ...symbol.completionItem,
        sortText: `3_${normalizeIdentifier(symbol.name)}`,
        detail: `${symbol.detail} — ${moduleName}`
    });
}

function classDefinition(item: IPlatformModuleClass): IRslBuiltinDefinition {
    return {
        name: item.name,
        kind: CompletionItemKind.Class,
        typeName: item.name,
        signature: `${item.name}(...)`,
        summary: item.summary,
        base: item.base,
        children: item.members.map(member => member.isMethod
            ? {
                name: member.name,
                kind: CompletionItemKind.Method,
                typeName: returnTypeOf(member.signature) || "Variant",
                signature: member.signature || `${member.name}(...)`,
                summary: member.description
            }
            : {
                name: member.name,
                kind: CompletionItemKind.Property,
                typeName: member.typeName || "Variant",
                summary: member.description
            })
    };
}

function procedureDefinition(
    item: IPlatformModuleProcedure
): IRslBuiltinDefinition {
    return {
        name: item.name,
        kind: CompletionItemKind.Function,
        typeName: returnTypeOf(item.signature) || "Variant",
        signature: item.signature,
        summary: item.description
    };
}

function returnTypeOf(signature: string | undefined): string | undefined {
    return signature
        ? /:\s*(@?[\wА-Яа-яЁё]+)\s*$/u.exec(signature)?.[1]
        : undefined;
}

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}
