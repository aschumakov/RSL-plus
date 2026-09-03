import { CompletionItemKind } from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";

import {
    descriptorKind,
    type IRslDeclarationDescriptor
} from "../analysis/declarationExtractor";
import {
    normalizeModuleName,
    rslModuleBaseName
} from "../core/language/moduleName";
import { normalizeIdentifier } from "../lexer";
import {
    createSymbolId,
    moduleSymbolId,
    type RslSymbol,
    type SymbolId
} from "../symbols/rslSymbol";

/**
 * Постоянный каталог символов проекта.
 *
 * Отдельно от LRU подробных моделей — и в этом весь смысл. Подробная модель
 * живёт, пока помещается в лимит: у проекта в 5800 файлов их в памяти
 * четыре тысячи, остальные вытесняются, и Ctrl+T перестаёт их видеть. Каталог
 * держит про каждый файл только то, что нужно глобальным ответам: имя, вид,
 * место, владельца, видимость и базовый класс. Запись переживает вытеснение
 * модели и исчезает лишь вместе с файлом.
 *
 * Порядок ответа не зависит от порядка загрузки: результаты сортируются
 * целиком и только потом обрезаются лимитом. Прежде Workspace Symbols
 * перебирал модули в порядке Map и останавливался на двухсотом совпадении —
 * состав ответа менялся от запуска к запуску.
 */
export interface IRslCatalogSymbol {
    name: string;
    /**
     * Устойчивая часть тождества символа: пара {uri, symbolId}.
     *
     * По одному имени класса ответить нельзя: `Base` бывает в двух файлах
     * проекта, и иерархия типов смешивала бы их наследников. Тождество
     * даёт тот же идентификатор, что и подробная модель, поэтому запись
     * компактного сканера и запись открытого файла сравнимы между собой.
     */
    symbolId: SymbolId;
    /** Нормализованное имя: поиск в RSL регистронезависим. */
    normalized: string;
    kind: CompletionItemKind;
    uri: string;
    start: number;
    end: number;
    line: number;
    character: number;
    /** Класс-владелец для члена; пусто у объявления верхнего уровня. */
    container: string;
    isPrivate: boolean;
    /** Базовый класс: нужен Go to Implementation и иерархии типов. */
    baseClassName: string;
}

export interface IRslCatalogModule {
    uri: string;
    version: number;
    symbols: readonly IRslCatalogSymbol[];
    /** Экспортируемые имена: кандидаты для References и Auto Import. */
    exports: ReadonlySet<string>;
    imports: readonly string[];
    /**
     * Имена файлов, упомянутые строками: ExecMacroFile("lib.mac").
     *
     * Заполняет только фоновая достройка каталога, которая и так читает
     * файл целиком. На каждое обновление модели этого не делается: проход
     * по тексту на каждую правку стоил бы дороже, чем переименование файла
     * раз в месяц.
     */
    fileReferences?: ReadonlySet<string>;
}

/**
 * Что нужно каталогу от модуля.
 *
 * Не IIndexedModule: каталог заполняется и одноразовой компактной моделью
 * фоновой достройки, у которой нет ни версии документа, ни признака
 * открытости.
 */
export interface IRslCatalogSource {
    uri: string;
    version: number;
    symbolTree: RslSymbol;
    imports: readonly string[];
    lex?: { lineStarts: readonly number[] };
}

export interface IRslCatalogStats {
    modules: number;
    symbols: number;
    /** Приблизительный объём хранимого: для отчёта о памяти. */
    approximateBytes: number;
}

export class WorkspaceCatalog {
    private modules = new Map<string, IRslCatalogModule>();
    /**
     * Кто подключает эту ссылку: НАПИСАНИЕ ссылки -> файлы-импортёры.
     *
     * Ключ — нормализованная ссылка целиком, вместе с путём. Сводить её
     * к базовому имени нельзя: `Import "a/lib.mac"` и
     * `Import "b/lib.mac"` — разные модули, и путь в Import написан
     * именно затем, чтобы их различить.
     */
    private importersByReference = new Map<string, Set<string>>();
    /**
     * Написания ссылок с этим базовым именем.
     *
     * Нужна, чтобы ответить на обратный вопрос без обхода каталога: у
     * файла берётся базовое имя, по нему — все написания, которые могли
     * бы в него разрешиться, и разрешается только они. Прежде обратные
     * ссылки считались полным проходом по каталогу, а потом ещё по одному
     * проходу на каждого найденного — на популярном модуле это
     * произведение числа файлов на число зависимых.
     */
    private referencesByBaseName = new Map<string, Set<string>>();
    /**
     * Имя -> файл -> объявления.
     *
     * Двухуровневая карта, а не список: при обновлении модуля запись о
     * нём удаляется по ключу. Плоский список приходилось фильтровать
     * целиком, а у популярного имени вроде `Helper` в нём тысячи
     * записей — обновление одного файла стоило прохода по всему проекту.
     */
    private byName = new Map<string, Map<string, IRslCatalogSymbol[]>>();
    /**
     * Имена каталога по порядку: поиск по началу имени идёт двоичным.
     *
     * Нужен Auto Import. Он спрашивает кандидатов на КАЖДУЮ нажатую букву,
     * а общий отбор (find) для этого не годится: он обходит все объявления
     * проекта, и на настоящем проекте это сотня тысяч символов за запрос.
     * Ctrl+T такой обход по силам — там один запрос на ввод пользователя, —
     * подсказке нет.
     *
     * Строится лениво: проект, в котором Auto Import не спрашивали, за него
     * не платит.
     */
    private sortedNames: string[] | undefined;
    /**
     * Имена, добавленные после последней сортировки.
     *
     * Полная пересортировка на каждую запись каталога не годится: достройка
     * читает проект всё время, пока пользователь набирает текст, и подсказка
     * пересобирала бы список ста тысяч имён на каждую букву. Новых имён при
     * записи одного модуля единицы, и они вставляются на место.
     */
    private pendingNames: string[] = [];
    /** Имя файла -> файлы, которые упоминают его строкой. */
    private byFileReference = new Map<string, Set<string>>();
    /**
     * Публичное имя верхнего уровня -> файлы, где оно объявлено.
     *
     * Обратный индекс, а не перебор модулей. Через modulesExporting отвечает
     * подбор недостающих Import, и там имён столько же, сколько неизвестных
     * слов в файле: на 6165 модулях перебор стоил 62,3 мс на 500 имён.
     *
     * byName для этого не годится: он держит и члены классов, и приватные
     * объявления, а экспортом считается только публичное имя верхнего уровня.
     */
    private byExport = new Map<string, Set<string>>();
    private revisionValue = 0;
    /** Готовый ответ на пустой запрос: см. firstSymbols. */
    private firstSymbolsCache: {
        revision: number;
        limit: number;
        symbols: IRslCatalogSymbol[];
    } | undefined;

    get revision(): number {
        return this.revisionValue;
    }

    /**
     * Запоминает состав модуля.
     *
     * Вызывается на каждое обновление модели — и открытой, и компактной
     * внешней. Дороже одного прохода по объявлениям это не стоит.
     */
    record(module: IRslCatalogSource): void {
        const symbols: IRslCatalogSymbol[] = [];
        const exports = new Set<string>();
        const lineStarts = module.lex?.lineStarts || [0];

        for (const child of module.symbolTree.children) {
            const added = append(symbols, module.uri, child, "", lineStarts);

            if (added && !child.isPrivate) {
                exports.add(added.normalized);
            }

            if (child.kind === CompletionItemKind.Class) {
                for (const member of child.children) {
                    append(symbols, module.uri, member, child.name, lineStarts);
                }
            }
        }

        this.commitRecord({
            uri: module.uri,
            version: module.version,
            symbols,
            exports,
            imports: module.imports
        });
    }

    private attachImports(uri: string, imports: readonly string[]): void {
        for (const name of imports) {
            const key = normalizeModuleName(name);

            if (!key) {
                continue;
            }

            const importers = this.importersByReference.get(key) ||
                new Set<string>();

            importers.add(uri);
            this.importersByReference.set(key, importers);

            const base = rslModuleBaseName(name);
            const spellings = this.referencesByBaseName.get(base) ||
                new Set<string>();

            spellings.add(key);
            this.referencesByBaseName.set(base, spellings);
        }
    }

    private detachImports(uri: string, imports: readonly string[]): void {
        for (const name of imports) {
            const key = normalizeModuleName(name);
            const importers = this.importersByReference.get(key);

            if (!importers) {
                continue;
            }

            importers.delete(uri);

            if (importers.size > 0) {
                continue;
            }

            this.importersByReference.delete(key);

            const base = rslModuleBaseName(name);
            const spellings = this.referencesByBaseName.get(base);

            spellings?.delete(key);

            if (spellings && spellings.size === 0) {
                this.referencesByBaseName.delete(base);
            }
        }
    }

    /**
     * Написания Import, которые могли бы разрешиться в этот файл.
     *
     * Кто из них действительно в него разрешается, решает тот же каталог
     * файлов, что и обычное разрешение имён: здесь только сужение
     * перебора по базовому имени.
     */
    importReferencesForBaseName(baseName: string): string[] {
        const spellings = this.referencesByBaseName.get(
            rslModuleBaseName(baseName)
        );

        return spellings ? [...spellings] : [];
    }

    /** Кто подключает ссылку с этим написанием. */
    importersOfReference(reference: string): string[] {
        const importers = this.importersByReference.get(
            normalizeModuleName(reference)
        );

        return importers ? [...importers] : [];
    }

    private attachExports(uri: string, exports: ReadonlySet<string>): void {
        for (const name of exports) {
            const uris = this.byExport.get(name) || new Set<string>();

            uris.add(uri);
            this.byExport.set(name, uris);
        }
    }

    private detachExports(uri: string, exports: ReadonlySet<string>): void {
        for (const name of exports) {
            const uris = this.byExport.get(name);

            if (!uris) {
                continue;
            }

            uris.delete(uri);

            if (uris.size === 0) {
                this.byExport.delete(name);
            }
        }
    }

    private indexSymbols(
        uri: string,
        symbols: readonly IRslCatalogSymbol[]
    ): void {
        for (const symbol of symbols) {
            let byUri = this.byName.get(symbol.normalized);

            if (!byUri) {
                byUri = new Map<string, IRslCatalogSymbol[]>();
                this.byName.set(symbol.normalized, byUri);
                this.pendingNames.push(symbol.normalized);
            }

            const list = byUri.get(uri);

            if (list) {
                list.push(symbol);
            } else {
                byUri.set(uri, [symbol]);
            }
        }
    }

    /**
     * Строковые ссылки на файлы модулей.
     *
     * Отдельный вход, а не часть record: их знает только тот, кто читал
     * текст файла целиком, — фоновая достройка каталога.
     */
    recordFileReferences(uri: string, names: ReadonlySet<string>): void {
        const previous = this.modules.get(uri);

        /*
         * Прежние ссылки снимаются по списку самого файла, а не обходом
         * всей карты: обход стоил бы столько же на каждую правку любого
         * файла, сколько сама достройка каталога.
         */
        this.detachFileReferences(uri, previous?.fileReferences);
        this.attachFileReferences(uri, names);

        if (previous) {
            this.modules.set(uri, { ...previous, fileReferences: names });
        }

        this.revisionValue++;
    }

    private attachFileReferences(
        uri: string,
        names: ReadonlySet<string> | undefined
    ): void {
        for (const name of names || []) {
            const uris = this.byFileReference.get(name) ||
                new Set<string>();

            uris.add(uri);
            this.byFileReference.set(name, uris);
        }
    }

    private detachFileReferences(
        uri: string,
        names: ReadonlySet<string> | undefined
    ): void {
        for (const name of names || []) {
            const uris = this.byFileReference.get(name);

            if (!uris) {
                continue;
            }

            uris.delete(uri);

            if (uris.size === 0) {
                this.byFileReference.delete(name);
            }
        }
    }

    /**
     * Кто упоминает файл строкой.
     *
     * Отвечает и про файлы, которые ни разу не открывались: их прочитала
     * фоновая достройка каталога.
     */
    modulesMentioningFile(fileName: string): string[] {
        return [
            ...(this.byFileReference.get(fileName.toLowerCase()) || [])
        ].sort();
    }

    /**
     * Состав файла по дескрипторам компактного сканера.
     *
     * Отдельный вход, а не record: у компактного сканера нет ни дерева
     * символов, ни начал строк, зато у каждого дескриптора есть точная
     * строка и колонка. Раньше такие файлы попадали в каталог с
     * lineStarts = [0], и символ с третьей строки открывался как символ
     * первой.
     */
    /**
     * Записать состав файла порциями, уступая поток между ними.
     *
     * Нужно ровно одному месту — переносу сохранённого каталога, — и только
     * ради непрерывности занятости: 25 000 объявлений в одном файле держат
     * поток 40 мс при бюджете 25, а 100 000 — 190 мс. На проверенном проекте
     * худший файл — 4140 объявлений и 3,7 мс, то есть запас шестикратный, но
     * патология обязана не ломать отзывчивость, а не «встречаться редко».
     *
     * Дробление живёт ЗДЕСЬ, а не у вызывающего, потому что тождество символа
     * считается по всему файлу: номер повторения одноимённых объявлений и
     * идентификатор модуля общие для всех порций. Разложить это на отдельные
     * вызовы записи нельзя — одинаковые объявления по разные стороны границы
     * порции получали бы один и тот же symbolId.
     */
    /**
     * То же, что recordDeclarations, но порциями — и с видимым промежутком.
     *
     * Между порциями поток отдаётся: иначе один крупный файл занимает его
     * целиком. Поэтому запрос может прийти в середину, и вот что он увидит:
     *
     *   запись файла уже стоит — has(uri) и versionOf(uri) отвечают по новой
     *   версии, а прежние символы этого файла уже сняты;
     *
     *   имена индексируются порциями, поэтому Ctrl+T и поиск по имени видят
     *   часть символов файла, а не все;
     *
     *   ревизия каталога поднимается только в конце, поэтому кэши, привязанные
     *   к ревизии, промежуточное состояние не подхватят и пересчитаются по
     *   готовому.
     *
     * Делать промежуток невидимым — значит собирать второй экземпляр индекса
     * имён и подменять его целиком; на файле с 50 000 символов это заметная
     * память ради состояния, которое живёт миллисекунды.
     */
    /**
     * Записать крупный файл порциями, уступая поток между ними.
     *
     * `isCurrent` спрашивается после каждой уступки: за время уступки
     * файл могли открыть, и живая модель записывает свой, более свежий
     * состав. Продолжать после этого нельзя — ни коммитить построенное
     * поверх живой записи, ни доиндексировать старые имена в byName.
     * Открытая модель главнее фоновой всегда, а не только в момент
     * начала работы.
     *
     * Возвращает false, если работа брошена: вызывающий не вправе
     * считать такой файл восстановленным.
     */
    async recordDeclarationsInBatches(
        source: {
            uri: string;
            version: number;
            declarations: readonly IRslDeclarationDescriptor[];
            imports: readonly string[];
            fileReferences?: ReadonlySet<string>;
        },
        batchSize: number,
        onBatch?: () => void | Promise<void>,
        /** Актуальна ли ещё эта работа; по умолчанию — да. */
        isCurrent: () => boolean = () => true
    ): Promise<boolean> {
        const size = Math.max(1, batchSize);
        const declarations = source.declarations;
        const built = this.buildSymbols(source.uri, []);

        for (let at = 0; at < declarations.length; at += size) {
            if (at > 0) {
                await onBatch?.();

                if (!isCurrent()) {
                    /* Ничего ещё не записано: бросить и есть весь откат. */
                    return false;
                }
            }

            this.buildSymbols(
                source.uri,
                declarations.slice(at, at + size),
                built
            );
        }

        /*
         * Последняя проверка перед записью: между сборкой и коммитом
         * уступок не было, но самая первая порция могла быть и
         * единственной — тогда проверок выше не случилось вовсе.
         */
        if (!isCurrent()) {
            return false;
        }

        this.commitRecord({
            uri: source.uri,
            version: source.version,
            symbols: built.symbols,
            exports: built.exports,
            imports: source.imports,
            fileReferences: source.fileReferences,
            /* Имена индексируются ниже порциями, а не одним куском. */
            deferIndexing: true
        });

        /* Индексация тоже порциями: на 50 000 символов она не мгновенна. */
        for (let at = 0; at < built.symbols.length; at += size) {
            if (at > 0) {
                await onBatch?.();
            }

            /*
             * Проверка ПЕРЕД каждой порцией, включая первую.
             *
             * Запись уже сделана, и если файл открылся, живая модель её
             * заменила своей — вместе с уже проиндексированными именами
             * (remove снимает их по файлу). Дописывать старые имена
             * поверх живой записи нельзя: в byName оказались бы
             * объявления двух разных версий файла сразу.
             */
            if (!isCurrent()) {
                return false;
            }

            this.indexSymbols(
                source.uri,
                built.symbols.slice(at, at + size)
            );
        }

        this.revisionValue++;

        return true;
    }

    /**
     * Разбор дескрипторов в символы каталога.
     *
     * Состояние — номера повторений и идентификатор модуля — живёт в
     * возвращаемом объекте, поэтому одну и ту же сборку можно продолжать
     * несколькими вызовами: см. recordDeclarationsInBatches.
     */
    private buildSymbols(
        uri: string,
        declarations: readonly IRslDeclarationDescriptor[],
        state?: {
            symbols: IRslCatalogSymbol[];
            exports: Set<string>;
            rootId: SymbolId;
            occurrences: Map<string, number>;
        }
    ): {
        symbols: IRslCatalogSymbol[];
        exports: Set<string>;
        rootId: SymbolId;
        occurrences: Map<string, number>;
    } {
        const built = state || {
            symbols: [],
            exports: new Set<string>(),
            rootId: moduleSymbolId(),
            occurrences: new Map<string, number>()
        };

        for (const descriptor of declarations) {
            const added = appendDescriptor(
                built.symbols,
                uri,
                descriptor,
                "",
                built.rootId,
                built.occurrences
            );

            if (added && descriptor.visibility !== "private") {
                built.exports.add(added.normalized);
            }

            if (descriptor.kind !== "class" || !added) {
                continue;
            }

            const members = new Map<string, number>();

            for (const member of descriptor.children) {
                appendDescriptor(
                    built.symbols,
                    uri,
                    member,
                    descriptor.name,
                    added.symbolId,
                    members
                );
            }
        }

        return built;
    }

    recordDeclarations(source: {
        uri: string;
        version: number;
        declarations: readonly IRslDeclarationDescriptor[];
        imports: readonly string[];
        fileReferences?: ReadonlySet<string>;
    }): void {
        const built = this.buildSymbols(source.uri, source.declarations);

        this.commitRecord({
            uri: source.uri,
            version: source.version,
            symbols: built.symbols,
            exports: built.exports,
            imports: source.imports,
            fileReferences: source.fileReferences
        });
    }

    /**
     * Запись файла в каталог: одна на все три входа.
     *
     * Собрать символы можно по-разному — из готового дерева, из компактных
     * объявлений, из объявлений порциями, — а положить их в каталог надо
     * одинаково. Прежде порядок из шести шагов был выписан в каждом входе
     * своими словами: снять прежнюю запись, поставить модуль, проиндексовать
     * имена, подцепить экспорт, подцепить ссылки на файлы, поднять ревизию.
     * Три копии одного порядка — три места, где можно забыть шаг.
     *
     * Возвращает список символов: порционному входу он нужен, чтобы
     * проиндексовать их не одним куском.
     */
    private commitRecord(record: {
        uri: string;
        version: number;
        symbols: IRslCatalogSymbol[];
        exports: Set<string>;
        imports: readonly string[];
        fileReferences?: ReadonlySet<string>;
        /** Проиндексовать имена отдельно: порциями, а не одним куском. */
        deferIndexing?: boolean;
    }): IRslCatalogSymbol[] {
        /*
         * Ссылки на файлы живут своей записью и переживают перезапись
         * объявлений: их приносит recordFileReferences, а не разбор модуля.
         */
        const references = record.fileReferences ||
            this.modules.get(record.uri)?.fileReferences;

        this.remove(record.uri);
        this.modules.set(record.uri, {
            uri: record.uri,
            version: record.version,
            symbols: record.symbols,
            exports: record.exports,
            imports: record.imports.slice(),
            fileReferences: references
        });
        this.attachExports(record.uri, record.exports);
        this.attachImports(record.uri, record.imports);
        this.attachFileReferences(record.uri, references);

        if (!record.deferIndexing) {
            this.indexSymbols(record.uri, record.symbols);
            this.revisionValue++;
        }

        return record.symbols;
    }

    /** Файла больше нет в проекте: запись уходит вместе с ним. */
    remove(uri: string): void {
        const previous = this.modules.get(uri);

        if (!previous) {
            return;
        }

        for (const symbol of previous.symbols) {
            const byUri = this.byName.get(symbol.normalized);

            if (!byUri) {
                continue;
            }

            byUri.delete(uri);

            if (byUri.size === 0) {
                this.byName.delete(symbol.normalized);
            }
        }

        this.detachExports(uri, previous.exports);
        this.detachImports(uri, previous.imports);
        this.detachFileReferences(uri, previous.fileReferences);
        this.modules.delete(uri);
        this.revisionValue++;
    }

    /**
     * Где объявлен класс с этим именем, если смотреть из этого файла.
     *
     * Имя класса само по себе адреса не даёт: `Base` бывает в двух модулях
     * проекта, и иерархия типов смешивала их наследников. Видно из файла
     * либо своё объявление, либо объявление импортированного модуля —
     * этого достаточно, чтобы отличить два одноимённых класса.
     *
     * undefined — не определилось: имени нет вовсе или его экспортируют
     * несколько импортированных модулей. Тогда отсеивать нельзя: спрятать
     * настоящего наследника хуже, чем показать лишнего.
     */
    classDeclaringUri(
        fromUri: string,
        className: string
    ): string | undefined {
        const wanted = normalizeIdentifier(className);
        const candidates = this.byName.get(wanted);

        if (!candidates) {
            return undefined;
        }

        const isClass = (uri: string): boolean =>
            (candidates.get(uri) || []).some(symbol =>
                symbol.kind === CompletionItemKind.Class);

        /* Своё объявление ближе любого импортированного. */
        if (isClass(fromUri)) {
            return fromUri;
        }

        const imported = new Set(
            (this.modules.get(fromUri)?.imports || [])
                .map(name => normalizeIdentifier(name))
        );
        const found: string[] = [];

        for (const uri of candidates.keys()) {
            if (!isClass(uri)) {
                continue;
            }

            const moduleName = normalizeIdentifier(moduleNameOf(uri));

            if (imported.has(moduleName)) {
                found.push(uri);
            }
        }

        return found.length === 1 ? found[0] : undefined;
    }

    /** Проект сменился: каталог прежнего проекта не годится. */
    clear(): void {
        this.modules.clear();
        this.byName.clear();
        this.sortedNames = undefined;
        this.pendingNames = [];
        this.byExport.clear();
        this.byFileReference.clear();
        this.importersByReference.clear();
        this.referencesByBaseName.clear();
        this.revisionValue++;
    }

    /**
     * Знает ли каталог о файле всё, включая строковые ссылки.
     *
     * Запись, сделанная из подробной модели, ссылок не содержит: их знает
     * только тот, кто читал текст файла целиком. Достройка каталога отличает
     * эти два случая — иначе файл, попавший в каталог при открытии, навсегда
     * оставался бы без ссылок.
     */
    hasFileReferences(uri: string): boolean {
        return this.modules.get(uri)?.fileReferences !== undefined;
    }

    has(uri: string): boolean {
        return this.modules.has(uri);
    }

    /** Известная версия модуля: повторно записывать неизменившийся незачем. */
    versionOf(uri: string): number | undefined {
        return this.modules.get(uri)?.version;
    }

    /**
     * Написанные в файле ссылки на модули — как они есть в тексте.
     *
     * Нужны, когда подробной модели файла в памяти нет: состав Import каталог
     * помнит про все прочитанные файлы.
     */
    importsOf(uri: string): string[] {
        return (this.modules.get(uri)?.imports || []).slice();
    }

    get stats(): IRslCatalogStats {
        let symbols = 0;
        let bytes = 0;

        for (const module of this.modules.values()) {
            symbols += module.symbols.length;
            bytes += module.uri.length * 2 + 64;

            for (const symbol of module.symbols) {
                /*
                 * Две строки на символ (имя и нормализованное имя), URI —
                 * ссылка на общую строку, остальное — числа.
                 */
                bytes += (symbol.name.length * 2) * 2 +
                    symbol.container.length * 2 +
                    symbol.baseClassName.length * 2 +
                    SYMBOL_OVERHEAD_BYTES;
            }
        }

        return { modules: this.modules.size, symbols, approximateBytes: bytes };
    }

    /**
     * Поиск по проекту: точное имя, начало, вхождение, подпоследовательность.
     *
     * Стоимость ответа определяется его размером, а не числом совпадений.
     * Каждый ранг набирается ограниченным отбором: список растёт до четырёх
     * лимитов, после чего сортируется и обрезается до лимита — остальное в
     * ответ всё равно не попадёт. Полная сортировка всех совпадений стоила на
     * проекте в 97 тысяч символов 20 мс на запрос: тысячи заведомо лишних
     * записей сортировались ради двухсот верхних.
     *
     * Заодно не считается то, что уже не понадобится: подпоследовательность —
     * самая дорогая проверка, и пока лучших совпадений меньше лимита, она
     * нужна, а как только их набралось достаточно — нет. Ответ от этого не
     * меняется: ранг сортируется первым, и совпадение худшего ранга в первые
     * limit не попало бы.
     *
     * Порядок ответа не зависит от порядка загрузки файлов: внутри ранга
     * сравниваются имя, URI и положение.
     */
    find(query: string, limit: number): IRslCatalogSymbol[] {
        const wanted = Math.max(0, limit);

        if (wanted === 0) {
            /* Ответ пуст по условию: каталог обходить незачем. */
            return [];
        }

        const normalized = normalizeIdentifier(query.trim());

        if (!normalized) {
            return this.firstSymbols(wanted);
        }

        return this.collect(normalized, wanted);
    }

    /**
     * Начало общего списка: ответ на пустой запрос.
     *
     * Пустому запросу подходит весь каталог, и отбор по нему — это обход ста
     * тысяч символов ради двухсот первых, одинаковый от запроса к запросу.
     * Ответ зависит только от содержимого каталога, поэтому считается один
     * раз и живёт до следующего изменения — ревизия каталога его и отменяет.
     */
    private firstSymbols(limit: number): IRslCatalogSymbol[] {
        const cached = this.firstSymbolsCache;

        if (
            cached &&
            cached.revision === this.revisionValue &&
            cached.limit >= limit
        ) {
            return cached.symbols.slice(0, limit);
        }

        /* С запасом: запрос с бо́льшим лимитом не заставит считать заново. */
        const prepared = Math.max(limit, FIRST_SYMBOLS_LIMIT);
        const symbols = this.collect("", prepared);

        this.firstSymbolsCache = {
            revision: this.revisionValue,
            limit: prepared,
            symbols
        };

        return symbols.slice(0, limit);
    }

    /** Отбор по рангам, каждый ранг — ограниченным списком. */
    private collect(
        normalized: string,
        limit: number
    ): IRslCatalogSymbol[] {
        const buckets: IRslCatalogSymbol[][] = [[], [], [], []];
        const bound = limit * BOUNDED_COLLECT_FACTOR;
        let cheapCount = 0;

        for (const module of this.modules.values()) {
            for (const symbol of module.symbols) {
                const rank = matchRank(
                    symbol.normalized,
                    normalized,
                    cheapCount < limit
                );

                if (rank < 0) {
                    continue;
                }

                const bucket = buckets[rank];

                bucket.push(symbol);

                if (bucket.length >= bound) {
                    /* Отобрать лучшие и забыть остальные: они уже лишние. */
                    bucket.sort(compareSymbols);
                    bucket.length = limit;
                }

                if (rank < 3) {
                    cheapCount++;
                }
            }
        }

        const result: IRslCatalogSymbol[] = [];

        for (const bucket of buckets) {
            if (result.length >= limit) {
                break;
            }

            bucket.sort(compareSymbols);

            for (const symbol of bucket) {
                if (result.length >= limit) {
                    break;
                }

                result.push(symbol);
            }
        }

        return result;
    }

    /**
     * Объявления, чьё имя начинается с prefix, в порядке имени и файла.
     *
     * Порядок задан ключом, а не порядком записи в каталог: одноимённые
     * объявления из разных файлов обязаны идти всегда одинаково.
     *
     * Пустой prefix ответа не имеет: «все объявления проекта» — это не
     * поиск по началу имени, и такой запрос обслуживает find.
     */
    findByPrefix(prefix: string, limit: number): IRslCatalogSymbol[] {
        const normalized = normalizeIdentifier(prefix);

        if (!normalized || limit <= 0) {
            return [];
        }

        const names = this.orderedNames();
        const result: IRslCatalogSymbol[] = [];

        for (
            let at = lowerBoundName(names, normalized);
            at < names.length && result.length < limit;
            at++
        ) {
            if (!names[at].startsWith(normalized)) {
                break;
            }

            const byUri = this.byName.get(names[at]);

            if (!byUri) {
                /* Имя осталось от удалённого модуля: см. orderedNames. */
                continue;
            }

            for (const uri of [...byUri.keys()].sort()) {
                for (const symbol of byUri.get(uri) || []) {
                    if (result.length >= limit) {
                        return result;
                    }

                    result.push(symbol);
                }
            }
        }

        return result;
    }

    /**
     * Имена каталога по порядку.
     *
     * Добавленные с прошлого раза вставляются на место, а не заставляют
     * сортировать всё заново: при достройке каталога новых имён на модуль
     * единицы. Если их накопилось много — дешевле пересортировать.
     *
     * Удаления здесь не отслеживаются вовсе: имя удалённого модуля остаётся
     * в списке, а поиск пропускает его, не найдя в byName. Держать список в
     * точности значило бы платить за это на каждом удалении, а ответ от
     * лишнего имени не меняется.
     */
    private orderedNames(): string[] {
        if (!this.sortedNames) {
            this.sortedNames = [...this.byName.keys()].sort();
            this.pendingNames = [];

            return this.sortedNames;
        }

        if (this.pendingNames.length === 0) {
            return this.sortedNames;
        }

        const names = this.sortedNames;
        const pending = this.pendingNames;

        this.pendingNames = [];

        if (pending.length * 8 > names.length) {
            this.sortedNames = [...this.byName.keys()].sort();

            return this.sortedNames;
        }

        for (const name of pending) {
            const at = lowerBoundName(names, name);

            if (names[at] !== name) {
                names.splice(at, 0, name);
            }
        }

        return names;
    }

    /** Все объявления с таким именем: кандидаты References и Auto Import. */
    findByName(name: string): readonly IRslCatalogSymbol[] {
        const byUri = this.byName.get(normalizeIdentifier(name));

        if (!byUri) {
            return [];
        }

        /* Порядок ответа не зависит от порядка загрузки файлов. */
        return [...byUri.keys()].sort()
            .flatMap(uri => byUri.get(uri) || []);
    }

    /**
     * Файлы, ссылающиеся на macro-файл: Import или строка с именем.
     *
     * Ответ по каталогу, а не чтением проекта: переименование файла
     * должно предлагать правки сразу, а не после обхода тысяч файлов.
     */
    /**
     * Кто подключает этот модуль — по всему каталогу проекта.
     *
     * Отличается от modulesReferencing тем, что сравнивает БАЗОВОЕ имя:
     * `Import "sub/lib.mac"` и `Import lib` подключают один модуль.
     * Отвечает каталог, а не граф загруженных модулей: при обычном
     * режиме индексации значительная часть проекта не загружена, а
     * состав Import каталог знает про все прочитанные файлы.
     */
    modulesImportingModule(moduleName: string): string[] {
        const wanted = rslModuleBaseName(moduleName);

        if (!wanted) {
            return [];
        }

        const result: string[] = [];

        for (const module of this.modules.values()) {
            const imports = module.imports.some(
                name => rslModuleBaseName(name) === wanted
            );

            if (imports) {
                result.push(module.uri);
            }
        }

        return result.sort();
    }

    modulesReferencing(moduleName: string): string[] {
        const wanted = normalizeIdentifier(moduleName);
        const result: string[] = [];

        for (const module of this.modules.values()) {
            const imported = module.imports.some(
                name => normalizeIdentifier(name) === wanted
            );

            if (imported) {
                result.push(module.uri);
            }
        }

        return result.sort();
    }

    /** Файлы, экспортирующие имя: кандидаты для адресной загрузки. */
    modulesExporting(name: string): string[] {
        return [
            ...(this.byExport.get(normalizeIdentifier(name)) || [])
        ].sort();
    }

    /** Классы, унаследованные от базового: основа Go to Implementation. */
    implementationsOf(baseClassName: string): IRslCatalogSymbol[] {
        const wanted = normalizeIdentifier(baseClassName);
        const result: IRslCatalogSymbol[] = [];

        for (const module of this.modules.values()) {
            for (const symbol of module.symbols) {
                if (
                    symbol.kind === CompletionItemKind.Class &&
                    symbol.baseClassName &&
                    normalizeIdentifier(symbol.baseClassName) === wanted
                ) {
                    result.push(symbol);
                }
            }
        }

        return result.sort((left, right) =>
            compare(left.uri, right.uri) || (left.start - right.start)
        );
    }
}

function append(
    result: IRslCatalogSymbol[],
    uri: string,
    symbol: RslSymbol,
    container: string,
    lineStarts: readonly number[]
): IRslCatalogSymbol | undefined {
    if (!symbol.name) {
        return undefined;
    }

    const start = symbol.selectionRange?.start ?? symbol.range.start;
    const end = symbol.selectionRange?.end ?? symbol.range.end;
    const position = positionAt(lineStarts, start);

    const record: IRslCatalogSymbol = {
        name: symbol.name,
        symbolId: symbol.id,
        normalized: normalizeIdentifier(symbol.name),
        kind: symbol.kind,
        uri,
        start,
        end,
        line: position.line,
        character: position.character,
        container,
        isPrivate: !!symbol.isPrivate,
        baseClassName: symbol.baseClassName || ""
    };

    result.push(record);

    return record;
}

/**
 * Запись каталога по дескриптору компактного сканера.
 *
 * Позиция берётся из самого дескриптора: он знает строку и колонку
 * объявления точно, а восстанавливать их из смещения без начал строк
 * нельзя.
 */
function appendDescriptor(
    result: IRslCatalogSymbol[],
    uri: string,
    descriptor: IRslDeclarationDescriptor,
    container: string,
    parentId: SymbolId,
    occurrences: Map<string, number>
): IRslCatalogSymbol | undefined {
    if (!descriptor.name) {
        return undefined;
    }

    const kind = descriptorKind(descriptor);
    const key = kind + ":" + normalizeIdentifier(descriptor.name);
    const occurrence = occurrences.get(key) || 0;

    occurrences.set(key, occurrence + 1);

    const record: IRslCatalogSymbol = {
        name: descriptor.name,
        symbolId: createSymbolId(
            parentId,
            kind,
            descriptor.name,
            occurrence
        ),
        normalized: normalizeIdentifier(descriptor.name),
        kind,
        uri,
        start: descriptor.selectionStart,
        end: descriptor.selectionEnd,
        line: descriptor.startLine,
        character: descriptor.startCharacter,
        container,
        isPrivate: descriptor.visibility === "private",
        baseClassName: descriptor.baseClassName || ""
    };

    result.push(record);

    return record;
}

/*
 * Во сколько раз список ранга растёт сверх лимита, прежде чем его обрежут.
 *
 * Обрезка стоит сортировки, поэтому чем реже, тем лучше; но чем больше запас,
 * тем больше памяти на популярный префикс. Четыре лимита — это одна сортировка
 * на каждые три лимита совпадений и восемьсот записей в памяти при обычном
 * лимите Ctrl+T в двести имён.
 */
const BOUNDED_COLLECT_FACTOR = 4;

/* С каким запасом считается сохраняемый ответ на пустой запрос. */
const FIRST_SYMBOLS_LIMIT = 500;

/*
 * Постоянные расходы на один символ каталога, байт.
 *
 * Восемьдесят байт — столько занимают поля записи, если считать только их. Но
 * символ живёт не сам по себе: у него есть устойчивый идентификатор, а сам он
 * лежит ещё и в двухуровневой карте «имя -> файл -> объявления», у которой
 * свои узлы, массивы и ключи.
 *
 * Замер на проверенном проекте: 97 220 символов занимают 42,6 МБ, то есть 438
 * байт на символ, а прежняя оценка давала 12,5 МБ — втрое меньше настоящего.
 * Отчёт о памяти с такой оценкой вводил в заблуждение ровно там, где по нему
 * принимают решения.
 */
const SYMBOL_OVERHEAD_BYTES = 380;

/** Порядок внутри одного ранга: имя, файл, положение. */
function compareSymbols(
    left: IRslCatalogSymbol,
    right: IRslCatalogSymbol
): number {
    return compare(left.normalized, right.normalized) ||
        compare(left.uri, right.uri) ||
        (left.start - right.start);
}

/** Имя модуля — имя файла без расширения. */
function moduleNameOf(uri: string): string {
    const withoutQuery = uri.split("?")[0];
    const fileName = withoutQuery.slice(
        withoutQuery.lastIndexOf("/") + 1
    );
    const dot = fileName.lastIndexOf(".");

    return dot < 0 ? fileName : fileName.slice(0, dot);
}

/** -1 — не подходит; меньше — лучше. */
function matchRank(
    candidate: string,
    query: string,
    /* Считать ли подпоследовательность: см. find. */
    withSubsequence: boolean = true
): number {
    if (!query) {
        return 2;
    }

    if (candidate === query) {
        return 0;
    }

    if (candidate.startsWith(query)) {
        return 1;
    }

    if (candidate.includes(query)) {
        return 2;
    }

    if (!withSubsequence) {
        return -1;
    }

    /*
     * Дешёвая отсечка: подпоследовательность обязана начинаться с первой буквы
     * запроса. Поиск буквы — встроенный, а проверка подпоследовательности —
     * цикл по строке, и на проекте в сто тысяч символов разница заметна.
     */
    if (!candidate.includes(query[0])) {
        return -1;
    }

    return isSubsequence(query, candidate) ? 3 : -1;
}

/** Нечёткое совпадение: буквы запроса идут по порядку. */
function isSubsequence(query: string, candidate: string): boolean {
    let index = 0;

    /*
     * Обход по индексу, а не по итератору строки: итератор идёт по кодовым
     * точкам и на длинном списке символов стоит заметно дороже, а имена в RSL
     * суррогатных пар не содержат.
     */
    for (let position = 0; position < candidate.length; position++) {
        if (candidate.charCodeAt(position) === query.charCodeAt(index)) {
            index++;

            if (index === query.length) {
                return true;
            }
        }
    }

    return false;
}

function compare(left: string, right: string): number {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

/* Перевод координат один на всех: см. core/documentPosition. */
function positionAt(
    lineStarts: readonly number[],
    offset: number
): { line: number; character: number } {
    return positionAtOffset(lineStarts, offset);
}

/** Первое имя, не меньшее искомого. */
function lowerBoundName(names: readonly string[], wanted: string): number {
    let low = 0;
    let high = names.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (names[middle] < wanted) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}
