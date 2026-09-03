import * as fs from "fs";
import * as path from "path";

import { CompletionItemKind, type CompletionItem } from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import { resolveExtensionFile } from "../paths";
import { BuiltinSymbol } from "./builtinSymbol";
import {
    trailingReturnType,
    type IRslBuiltinDefinition
} from "./standardLibraryData";

/**
 * Классы и процедуры прикладных модулей платформы (CommonInter и прочие).
 *
 * Отдельно от стандартной библиотеки по двум причинам.
 *
 * Доступность: символ модуля существует только там, где модуль импортирован,
 * поэтому предлагать его наравне со встроенными неверно — подсказка звала бы
 * имя, которого в файле нет.
 *
 * Объём: 62 модуля, 255 классов, 2353 члена и 1555 процедур — 798 КБ. Одним
 * файлом это пришлось бы разбирать и держать в памяти целиком ради одного-двух
 * импортированных модулей (PaymInter сам по себе 186 КБ). Поэтому данные лежат
 * по файлу на модуль, а индекс (5 КБ) отвечает на вопрос «знаем ли мы такой
 * модуль» без чтения состава.
 *
 * Чтение НИКОГДА не происходит в обработчике интерактивного запроса: состав
 * готовится по событию появления списка Import у документа (см. ensureModules),
 * асинхронно и с дедупликацией параллельных запросов одного файла. Модуль,
 * который к моменту запроса ещё не прочитан, просто не даёт символов — они
 * появятся следующим запросом.
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

/**
 * Константа модуля: `RSB_EV_MOUSE = 2`.
 *
 * В коде их пишут наравне с именами классов — например при разборе вида
 * события в обработчике, — поэтому в подсказке они нужны не меньше.
 */
export interface IPlatformModuleConstant {
    name: string;
    value: string;
    /**
     * Явный тип из справки.
     *
     * Если его нет, тип выводится из значения. Раньше вывод был единственным
     * источником, и константа `RSB_ALIGN_LEFT = "left"` получала Variant вместо
     * String, а само значение вообще не доходило до RslSymbol: оно попадало
     * только в текст подписи.
     */
    typeName?: string;
    description: string;
}

/**
 * Глобальная переменная модуля: `LastUsed` в RslScr.
 *
 * Отдельно от константы: её читают И пишут. Показывать её как константу значило
 * бы соврать о том, что ей можно присваивать.
 */
export interface IPlatformModuleVariable {
    name: string;
    typeName?: string;
    description: string;
}

export interface IPlatformModuleIndexEntry {
    file: string;
    /**
     * Модули, без которых состав этого неполон.
     *
     * Класс модуля может наследовать класс другого модуля: `RsbBBPayment` из
     * BankInter наследует `RsbPayment` из PaymInter. Чтобы одного
     * `Import BankInter` хватило для получения унаследованных членов, зависимые
     * модули читаются транзитивно — но их собственные имена при этом НЕ
     * становятся видимыми: назвать `RsbPayment` без `Import PaymInter` нельзя.
     */
    dependencies?: readonly string[];
    classes?: number;
    procedures?: number;
    constants?: number;
}

interface IPlatformModuleIndex {
    version: number;
    modules: Record<string, IPlatformModuleIndexEntry>;
}

interface IPlatformModuleBody {
    version: number;
    classes?: IPlatformModuleClass[];
    procedures?: IPlatformModuleProcedure[];
    constants?: IPlatformModuleConstant[];
    variables?: IPlatformModuleVariable[];
}

interface ILoadedModule {
    /** Имя модуля в написании справки: показывается пользователю. */
    displayName: string;
    /**
     * Все символы модуля — классы, процедуры и константы.
     *
     * Отдельно от classes: Hover, Signature Help и семантическая подсветка
     * спрашивают символ по имени, не зная, класс это или процедура.
     */
    symbols: ReadonlyMap<string, RslSymbol>;
    classes: ReadonlyMap<string, RslSymbol>;
    completions: readonly CompletionItem[];
    /** Только классы: нужны в позиции типа, где процедура неуместна. */
    classCompletions: readonly CompletionItem[];
    /** Тип результата процедуры: нужен для вывода типа переменной. */
    resultTypes: ReadonlyMap<string, string>;
}

/**
 * Символ вместе с модулем-владельцем.
 *
 * Владелец обязателен для разрешения базового класса: искать его надо в том
 * модуле, где объявлен производный класс, и в объявленных зависимостях этого
 * модуля — а не среди произвольных классов проекта.
 */
export interface IPlatformSymbol {
    /** Ключ модуля-владельца в нижнем регистре. */
    moduleKey: string;
    /** Имя модуля-владельца в написании справки. */
    moduleName: string;
    symbol: RslSymbol;
}

/** Формат данных; несовпадение версии выключает каталог. */
const SUPPORTED_VERSION = 3;
/*
 * Версия обратного указателя: своя, не общая с индексом.
 *
 * Указатель производен от тел модулей и пересобирается отдельно
 * (build/platform-modules.js --fix), поэтому несовпадение версии
 * выключает только его.
 */
const SYMBOL_OWNERS_VERSION = 1;
const DIRECTORY = "platform-modules";

/**
 * Состояние чтения индекса или отдельного модуля.
 *
 * `failed` обязано отличаться от `loading`: непрочитанные данные уже не
 * появятся, и ждать их нечего. Пока разницы не было, ошибка чтения оставляла
 * Import-контекст в состоянии «ещё грузится» навсегда — а вместе с ним молча и
 * навсегда выключались проверки, которым нужен полный контекст.
 */
export type RslPlatformLoadState = "missing" | "loading" | "loaded" | "failed";

export class PlatformModuleCatalog {
    private indexLoaded = false;
    private indexFailed = false;
    private indexPromise?: Promise<void>;
    /** Ключ — имя модуля в нижнем регистре. */
    private entries = new Map<string, IPlatformModuleIndexEntry>();
    private displayNames = new Map<string, string>();
    /**
     * Обратный указатель: имя объявления -> модули, где оно есть.
     *
     * Нужен диагностике «символ описан в модуле, который не подключён».
     * Без него такой ответ требовал бы прочитать все модули справки — то
     * есть отменить ленивость каталога ради проверки, которая
     * срабатывает редко.
     *
     * Читается отдельным файлом рядом с индексом. Файла нет или он
     * другой версии — указателя просто не будет, и проверка не
     * сработает: 312 КБ данных не повод ломать остальной каталог.
     */
    private symbolOwners = new Map<string, readonly string[]>();
    private loaded = new Map<string, ILoadedModule>();
    private failedModules = new Set<string>();
    /** Незавершённые чтения: второй запрос того же модуля их переиспользует. */
    private pendingModules = new Map<string, Promise<void>>();
    /**
     * Меняется при каждом изменении состава каталога.
     *
     * Кэши, зависящие от того, какие модули уже прочитаны (в частности набор
     * видимых модулей документа), сбрасываются по этому номеру. Без него первый
     * же ответ «модулей не видно», выданный до загрузки индекса, оставался в
     * кэше до следующей правки текста.
     */
    private revisionValue = 0;

    constructor(private options: { log(message: string): void }) {}

    get revision(): number {
        return this.revisionValue;
    }

    /**
     * Индекс модулей: 5 КБ, читается один раз и асинхронно.
     *
     * Параллельные вызовы разделяют одно чтение: при открытии нескольких файлов
     * событие Import приходит по каждому из них почти одновременно.
     */
    ensureIndexLoaded(): Promise<void> {
        if (this.indexLoaded || this.indexFailed) {
            return Promise.resolve();
        }

        if (!this.indexPromise) {
            this.indexPromise = this.loadIndex().finally(() => {
                this.indexPromise = undefined;
            });
        }

        return this.indexPromise;
    }

    /**
     * Готовит состав перечисленных модулей и их зависимостей заранее, вне пути
     * запроса.
     *
     * Вызывается, когда у документа стал известен список Import — то есть
     * после разбора, а не из обработчика Completion.
     */
    async ensureModules(moduleNames: readonly string[]): Promise<void> {
        await this.ensureIndexLoaded();

        const queue = moduleNames.map(name => normalizeIdentifier(name));
        const visited = new Set<string>();

        while (queue.length > 0) {
            const batch = queue.filter(key => {
                if (visited.has(key)) {
                    return false;
                }
                visited.add(key);
                return true;
            });
            queue.length = 0;

            await Promise.all(batch.map(key => this.loadModule(key)));

            for (const key of batch) {
                for (const dependency of this.dependenciesOf(key)) {
                    if (!visited.has(dependency)) {
                        queue.push(dependency);
                    }
                }
            }
        }
    }

    /** Знает ли каталог такой модуль; состав при этом не читается. */
    knowsModule(moduleName: string): boolean {
        return this.entries.has(normalizeIdentifier(moduleName));
    }

    /**
     * Имя модуля в написании справки по его ключу.
     *
     * Отдельной таблицы соответствий не заводится: написание уже
     * лежит в самой записи модуля, а ключ — это оно же в нижнем
     * регистре. Пусто, если модуль каталогу неизвестен.
     */
    moduleDisplayName(moduleKey: string): string {
        const key = normalizeIdentifier(moduleKey);

        return this.loaded.get(key)?.displayName ||
            this.displayNames.get(key) ||
            "";
    }

    get ready(): boolean {
        return this.indexLoaded;
    }

    get moduleCount(): number {
        return this.entries.size;
    }

    get loadedCount(): number {
        return this.loaded.size;
    }

    /**
     * Класс, видимый через один из перечисленных модулей.
     *
     * Список модулей вычисляет вызывающий: только он знает, какие Import стоят
     * в файле и какие из них уже разобраны. Одинаковые имена классов в разных
     * модулях разрешаются в порядке перечисления, то есть в порядке Import.
     */
    findClass(
        moduleNames: readonly string[],
        className: string
    ): IPlatformSymbol | undefined {
        return this.lookup(moduleNames, className, "classes");
    }

    /**
     * Любой символ модуля по имени — класс, процедура или константа.
     *
     * Нужен Hover, Signature Help и семантической подсветке: без него имя из
     * прикладного модуля предлагалось в Completion, но при наведении и при
     * подсветке оставалось неизвестным.
     */
    findSymbol(
        moduleNames: readonly string[],
        name: string
    ): IPlatformSymbol | undefined {
        return this.lookup(moduleNames, name, "symbols");
    }

    /**
     * Базовый класс класса прикладного модуля.
     *
     * Ищется в модуле-владельце, затем в его объявленных зависимостях —
     * транзитивно. Классы проекта и не связанных модулей сюда не попадают: имя
     * `RsbPayment` в базе `RsbBBPayment` означает класс PaymInter, а не
     * одноимённый класс, который может оказаться где-то в workspace.
     */
    findBaseClass(
        ownerModuleKey: string,
        baseClassName: string
    ): IPlatformSymbol | undefined {
        const key = normalizeIdentifier(baseClassName);
        const visited = new Set<string>();
        const queue = [normalizeIdentifier(ownerModuleKey)];

        for (let position = 0; position < queue.length; position++) {
            const moduleKey = queue[position];

            if (visited.has(moduleKey)) {
                continue;
            }
            visited.add(moduleKey);

            const module = this.loaded.get(moduleKey);
            const symbol = module?.classes.get(key);

            if (symbol && module) {
                return {
                    moduleKey,
                    moduleName: module.displayName,
                    symbol
                };
            }

            for (const dependency of this.dependenciesOf(moduleKey)) {
                if (!visited.has(dependency)) {
                    queue.push(dependency);
                }
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
        return this.collectCompletions(moduleNames, "completions");
    }

    /** То же, но только классы: для позиции типа. */
    classCompletionItems(moduleNames: readonly string[]): CompletionItem[] {
        return this.collectCompletions(moduleNames, "classCompletions");
    }

    /** Прочитан ли состав модуля; неизвестный модуль считается непрочитанным. */
    isModuleLoaded(moduleName: string): boolean {
        return this.loaded.has(normalizeIdentifier(moduleName));
    }

    /**
     * Состояние чтения состава модуля.
     *
     * `failed` — файл не прочитан, и сам он не появится: ждать нечего, состав
     * этого модуля так и останется неизвестным.
     */
    moduleState(moduleName: string): RslPlatformLoadState {
        const key = normalizeIdentifier(moduleName);

        if (this.loaded.has(key)) {
            return "loaded";
        }
        if (this.failedModules.has(key)) {
            return "failed";
        }
        return this.entries.has(key) ? "loading" : "missing";
    }

    /** Состояние чтения индекса модулей. */
    get indexState(): RslPlatformLoadState {
        if (this.indexLoaded) {
            return "loaded";
        }
        return this.indexFailed ? "failed" : "loading";
    }

    /** Объявленные зависимости модуля; для проверок и тестов. */
    dependenciesOf(moduleName: string): readonly string[] {
        return this.entries
            .get(normalizeIdentifier(moduleName))
            ?.dependencies
            ?.map(name => normalizeIdentifier(name)) || [];
    }

    private collectCompletions(
        moduleNames: readonly string[],
        field: "completions" | "classCompletions"
    ): CompletionItem[] {
        const result: CompletionItem[] = [];

        for (const moduleName of moduleNames) {
            const module = this.loaded.get(normalizeIdentifier(moduleName));

            if (module) {
                result.push(...module[field]);
            }
        }

        return result;
    }

    private lookup(
        moduleNames: readonly string[],
        name: string,
        field: "classes" | "symbols"
    ): IPlatformSymbol | undefined {
        const key = normalizeIdentifier(name);

        for (const moduleName of moduleNames) {
            const moduleKey = normalizeIdentifier(moduleName);
            const module = this.loaded.get(moduleKey);
            const symbol = module?.[field].get(key);

            if (symbol && module) {
                return {
                    moduleKey,
                    moduleName: module.displayName,
                    symbol
                };
            }
        }

        return undefined;
    }

    private directory(): string {
        return process.env.RSL_PLATFORM_MODULES_DIR ||
            resolveExtensionFile(DIRECTORY);
    }

    /**
     * Модули, объявляющие это имя.
     *
     * Пустой ответ означает и «такого имени нет», и «указатель ещё не
     * прочитан»: различать их незачем — проверка, которая на этом
     * основана, в обоих случаях молчит.
     */
    modulesDeclaring(name: string): readonly string[] {
        return this.symbolOwners.get(normalizeIdentifier(name)) || [];
    }

    private async loadSymbolOwners(): Promise<void> {
        const filePath = path.join(this.directory(), "symbols.json");

        try {
            const parsed = JSON.parse(
                await fs.promises.readFile(filePath, "utf8")
            ) as {
                version?: number;
                symbols?: Record<string, string[]>;
            };

            if (parsed.version !== SYMBOL_OWNERS_VERSION) {
                return;
            }

            for (const [name, owners] of Object.entries(
                parsed.symbols || {}
            )) {
                if (Array.isArray(owners) && owners.length > 0) {
                    this.symbolOwners.set(normalizeIdentifier(name), owners);
                }
            }
        } catch (_error) {
            /*
             * Указателя нет — это не поломка: он производный, и без него
             * работает всё, кроме одной проверки.
             */
        }
    }

    private async loadIndex(): Promise<void> {
        const filePath = path.join(this.directory(), "index.json");

        try {
            const parsed = JSON.parse(
                await fs.promises.readFile(filePath, "utf8")
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
                const key = normalizeIdentifier(name);
                this.entries.set(key, entry);
                this.displayNames.set(key, name);
            }
            this.indexLoaded = true;
            await this.loadSymbolOwners();
            this.revisionValue++;
        } catch (error) {
            /*
             * Отсутствующий или испорченный файл не должен ронять сервер: без
             * него просто не будет подсказок по прикладным модулям, а весь
             * остальной язык обязан продолжать работать.
             */
            this.indexFailed = true;
            /*
             * Ревизия растёт и при ошибке: состояние каталога изменилось, и
             * кэши, посчитанные в надежде «сейчас догрузится», обязаны
             * пересчитаться — иначе Import-контекст останется «загружающимся».
             */
            this.revisionValue++;
            this.options.log(
                `Индекс прикладных модулей не прочитан: ${filePath}; ` +
                errorToString(error)
            );
        }
    }

    private loadModule(key: string): Promise<void> {
        if (this.loaded.has(key) || this.failedModules.has(key)) {
            return Promise.resolve();
        }

        const pending = this.pendingModules.get(key);

        if (pending) {
            return pending;
        }

        const entry = this.entries.get(key);

        if (!entry) {
            return Promise.resolve();
        }

        const started = this.readModule(key, entry).finally(() => {
            this.pendingModules.delete(key);
        });
        this.pendingModules.set(key, started);
        return started;
    }

    private async readModule(
        key: string,
        entry: IPlatformModuleIndexEntry
    ): Promise<void> {
        const filePath = path.join(this.directory(), entry.file);

        try {
            const parsed = JSON.parse(
                await fs.promises.readFile(filePath, "utf8")
            ) as IPlatformModuleBody;

            if (parsed.version !== SUPPORTED_VERSION) {
                throw new Error(`версия формата ${parsed.version}`);
            }

            this.loaded.set(
                key,
                build(this.displayNames.get(key) || key, parsed)
            );
            this.revisionValue++;
        } catch (error) {
            this.failedModules.add(key);
            /* Ошибка — тоже изменение состояния: см. loadIndex. */
            this.revisionValue++;
            this.options.log(
                `Состав прикладного модуля не прочитан: ${filePath}; ` +
                errorToString(error)
            );
        }
    }
}

function build(
    displayName: string,
    body: IPlatformModuleBody
): ILoadedModule {
    const symbols = new Map<string, RslSymbol>();
    const classes = new Map<string, RslSymbol>();
    const completions: CompletionItem[] = [];
    const classCompletions: CompletionItem[] = [];
    const resultTypes = new Map<string, string>();

    for (const item of body.classes || []) {
        const symbol = new BuiltinSymbol(classDefinition(item));
        const name = normalizeIdentifier(item.name);
        const semantic = symbol.toRslSymbol();
        const completion = moduleCompletion(symbol, displayName);
        classes.set(name, semantic);
        symbols.set(name, semantic);
        completions.push(completion);
        classCompletions.push(completion);
    }

    for (const item of body.procedures || []) {
        const symbol = new BuiltinSymbol(procedureDefinition(item));
        const name = normalizeIdentifier(item.name);
        completions.push(moduleCompletion(symbol, displayName));

        /* Класс с таким именем важнее: он несёт ещё и состав членов. */
        if (!symbols.has(name)) {
            symbols.set(name, symbol.toRslSymbol());
        }

        if (symbol.typeName && symbol.typeName !== "Variant") {
            resultTypes.set(name, symbol.typeName);
        }
    }

    for (const item of body.constants || []) {
        const symbol = new BuiltinSymbol(constantDefinition(item));
        const name = normalizeIdentifier(item.name);
        completions.push(moduleCompletion(symbol, displayName));

        if (!symbols.has(name)) {
            symbols.set(name, symbol.toRslSymbol());
        }
    }

    for (const item of body.variables || []) {
        const symbol = new BuiltinSymbol(variableDefinition(item));
        const name = normalizeIdentifier(item.name);
        completions.push(moduleCompletion(symbol, displayName));

        if (!symbols.has(name)) {
            symbols.set(name, symbol.toRslSymbol());
        }
    }

    return {
        displayName,
        symbols,
        classes,
        completions: Object.freeze(completions),
        classCompletions: Object.freeze(classCompletions),
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

function constantDefinition(
    item: IPlatformModuleConstant
): IRslBuiltinDefinition {
    return {
        name: item.name,
        kind: CompletionItemKind.Constant,
        typeName: item.typeName || inferConstantType(item.value),
        /*
         * Значение показывается рядом с именем: оно и есть смысл константы.
         * Но справка приводит его не всегда — у констант вида RCB_VT_DATE
         * описан только смысл. Тогда в подписи остаётся одно имя: «RCB_VT_DATE =»
         * с пустотой справа читалось бы как значение, которого нет.
         */
        signature: item.value
            ? `${item.name} = ${item.value}`
            : item.name,
        value: item.value,
        summary: item.description
    };
}

/** Тип из значения — только когда явного типа в справке нет. */
function inferConstantType(value: string): string {
    const text = (value || "").trim();

    if (/^-?\d+$/.test(text)) {
        return "Integer";
    }
    if (/^-?\d+[.,]\d+$/.test(text)) {
        return "Double";
    }
    if (/^(?:"|')/.test(text)) {
        return "String";
    }
    if (/^(?:true|false)$/i.test(text)) {
        return "Bool";
    }
    return "Variant";
}

function variableDefinition(
    item: IPlatformModuleVariable
): IRslBuiltinDefinition {
    return {
        name: item.name,
        kind: CompletionItemKind.Variable,
        typeName: item.typeName || "Variant",
        summary: item.description
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

/*
 * Тип результата берётся из подписи: данные модулей извлечены из руководства
 * одной строкой, разделить её на этапе объявления здесь нечем. Правило одно и
 * то же для всего каталога — см. trailingReturnType.
 */
const returnTypeOf = trailingReturnType;

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
}
