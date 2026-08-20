import type { Diagnostic } from "vscode-languageserver";

import {
    diffRslDocumentUnits,
    splitRslDocumentUnits,
    type IRslDocumentUnit
} from "../analysis/documentUnits";
import { positionAtOffset } from "../core/documentPosition";
import { LruCache } from "../core/lruCache";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Кэш локальных диагностик по единицам документа.
 *
 * Правка почти всегда задевает одну единицу из нескольких десятков: тело одного
 * Macro, одно поле класса. Остальные единицы после правки те же — им нужен не
 * пересчёт, а перенос смещений.
 *
 * Переиспользуются только проверки, результат которых зависит ровно от текста
 * своей единицы: длина имени и строки, незакрытая строка, неизвестный escape,
 * устаревшее объявление, отладочный BREAK. Проверки, которые смотрят за
 * пределы единицы — область видимости, использование до объявления, дубликаты
 * имён, — считаются как прежде: их результат зависит от всего файла, и
 * переиспользование давало бы неверный ответ, а не выигрыш.
 *
 * Диагностика хранится смещениями ОТНОСИТЕЛЬНО начала своей единицы. Тогда
 * перенос — это сложение, и он не зависит от того, сдвинулась единица на строку
 * или на десять: абсолютные позиции пересчитываются по новому тексту.
 */
export interface IRslUnitDiagnosticRecord {
    /** Смещение начала относительно начала единицы. */
    start: number;
    /** Смещение конца относительно начала единицы. */
    end: number;
    diagnostic: Diagnostic;
}

interface IRslUnitDiagnosticsEntry {
    uri: string;
    /**
     * Отпечаток настроек, при которых результат посчитан.
     *
     * Кэшируемые проверки включаются настройками, и выключенная проверка не
     * даёт находок — а не даёт «те же находки, что и раньше». Без отпечатка
     * снятая галочка `debugBreak` оставляла бы предупреждения в файле до
     * закрытия, а поставленная — не добавляла их в нетронутых процедурах.
     */
    fingerprint: string;
    source: string;
    units: readonly IRslDocumentUnit[];
    byUnit: Map<string, IRslUnitDiagnosticRecord[]>;
    /** Оценка занятой памяти: по ней кэш и ограничивается. */
    bytes: number;
}

/**
 * Один расчёт файла: что переиспользовать и чем закончить.
 *
 * Расчёт заканчивается двояко. Полный проход всех кэшируемых проверок даёт
 * результат, который можно запомнить, — это commit. Отменённый расчёт и расчёт,
 * упёршийся в лимит Problems, дают неполный результат: запоминать его нельзя,
 * иначе следующая правка «переиспользует» находки, которых не искали. Такой
 * расчёт заканчивается abort, и прежняя запись остаётся нетронутой.
 */
export interface IRslUnitDiagnosticsRun {
    /** Единицы, которые нужно посчитать заново. */
    readonly stale: readonly IRslDocumentUnit[];
    /** Единицы, чей результат взят из прошлой записи. */
    readonly keep: readonly IRslDocumentUnit[];
    /** Готовые диагностики неизменившихся единиц, уже с новыми позициями. */
    readonly reused: readonly Diagnostic[];
    /** Все единицы новой версии — в них раскладывается новый результат. */
    readonly units: readonly IRslDocumentUnit[];
    /** Пересчитывается весь файл: прошлого результата нет или он не годится. */
    readonly full: boolean;
    /** Запомнить посчитанное: только после полного прохода. */
    commit(diagnostics: readonly Diagnostic[]): void;
    /** Ничего не менять: результат неполон. */
    abort(): void;
}

/*
 * Оценка веса одной записи.
 *
 * Считать точно нечем: JS не сообщает размер объекта. Берётся то, что задаёт
 * порядок величины, — исходный текст (по два байта на символ) и находки, у
 * каждой из которых есть сообщение, позиции и код. Ошибка такой оценки в разы
 * не страшна: она нужна, чтобы кэш не удерживал десятки мегабайт, а не чтобы
 * знать их точное число.
 */
const BYTES_PER_RECORD = 256;

/** Записей в кэше: открытых документов не бывает много. */
const DEFAULT_MAX_ENTRIES = 24;

/**
 * Верхняя граница памяти кэша.
 *
 * Ограничения по числу файлов мало: в проверенном репозитории есть модули по
 * 700 КБ, и двадцать четыре таких записи — это десятки мегабайт, удерживаемых
 * ради ускорения повторного расчёта.
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface IRslUnitDiagnosticsCacheOptions {
    maxEntries?: number;
    maxBytes?: number;
}

export class RslUnitDiagnosticsCache {
    private readonly entries: LruCache<string, IRslUnitDiagnosticsEntry>;
    private readonly maxBytes: number;
    private usedBytes = 0;

    constructor(options: IRslUnitDiagnosticsCacheOptions = {}) {
        this.entries = new LruCache(
            Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES)
        );
        this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    }

    /**
     * Начать расчёт файла.
     *
     * Прошлая запись используется, только если она о том же файле и посчитана
     * при тех же настройках: единицы сопоставляются по устойчивому
     * идентификатору, а совпадение текста проверяется по обоим исходникам, а не
     * по одному отпечатку.
     */
    begin(
        module: IIndexedModule,
        fingerprint: string
    ): IRslUnitDiagnosticsRun {
        const units = splitRslDocumentUnits(
            module.source,
            module.lex.tokens,
            module.symbolTree
        );
        const previous = this.entries.get(module.uri);
        const usable = previous &&
            previous.uri === module.uri &&
            previous.fingerprint === fingerprint
            ? previous
            : undefined;

        if (!usable) {
            return this.createRun(module, fingerprint, {
                units,
                stale: units,
                keep: [],
                reused: [],
                full: true,
                previous: undefined
            });
        }

        const diff = diffRslDocumentUnits(usable.units, units, {
            previous: usable.source,
            next: module.source
        });
        const keep = [...diff.unchanged, ...diff.shifted];
        const reused: Diagnostic[] = [];

        for (const unit of keep) {
            for (const record of usable.byUnit.get(unit.id) || []) {
                reused.push(shiftDiagnostic(module, unit, record));
            }
        }

        return this.createRun(module, fingerprint, {
            units,
            stale: [...diff.changed, ...diff.added],
            keep,
            reused,
            full: false,
            previous: usable
        });
    }

    /** Файл закрыт: держать его текст и находки больше незачем. */
    forget(uri: string): void {
        const entry = this.entries.get(uri);

        if (!entry) {
            return;
        }

        this.usedBytes -= entry.bytes;
        this.entries.delete(uri);
    }

    clear(): void {
        this.entries.clear();
        this.usedBytes = 0;
    }

    /** Сколько записей и сколько памяти удерживается: для тестов и профиля. */
    get size(): number {
        return this.entries.size;
    }

    get bytes(): number {
        return this.usedBytes;
    }

    private createRun(
        module: IIndexedModule,
        fingerprint: string,
        plan: {
            units: readonly IRslDocumentUnit[];
            stale: readonly IRslDocumentUnit[];
            keep: readonly IRslDocumentUnit[];
            reused: readonly Diagnostic[];
            full: boolean;
            previous: IRslUnitDiagnosticsEntry | undefined;
        }
    ): IRslUnitDiagnosticsRun {
        let finished = false;

        return {
            ...plan,
            commit: (diagnostics: readonly Diagnostic[]): void => {
                if (finished) {
                    return;
                }
                finished = true;
                this.store(module, fingerprint, plan, diagnostics);
            },
            abort: (): void => {
                finished = true;
            }
        };
    }

    private store(
        module: IIndexedModule,
        fingerprint: string,
        plan: {
            units: readonly IRslDocumentUnit[];
            keep: readonly IRslDocumentUnit[];
            previous: IRslUnitDiagnosticsEntry | undefined;
        },
        diagnostics: readonly Diagnostic[]
    ): void {
        const byUnit = collectRslUnitDiagnostics(
            module,
            plan.units,
            diagnostics
        );

        /*
         * Переносятся записи ТОЛЬКО переиспользованных единиц.
         *
         * У пересчитанной единицы новый результат полон, в том числе когда он
         * пуст: правка могла убрать находку. Перенос прежних записей по
         * признаку «сейчас ничего не нашлось» оставлял бы исправленное в кэше
         * навсегда.
         */
        for (const unit of plan.keep) {
            if (byUnit.has(unit.id)) {
                continue;
            }

            const kept = plan.previous?.byUnit.get(unit.id);

            if (kept) {
                byUnit.set(unit.id, kept);
            }
        }

        let records = 0;
        byUnit.forEach(list => {
            records += list.length;
        });

        const bytes = module.source.length * 2 + records * BYTES_PER_RECORD;

        /* Запись, которая одна не помещается в границу, не запоминается. */
        if (bytes > this.maxBytes) {
            this.forget(module.uri);

            return;
        }

        this.forget(module.uri);
        this.evictOldest(bytes);

        /* Вытесненное по числу записей тоже уходит из счёта занятого объёма. */
        const evicted = this.entries.set(module.uri, {
            uri: module.uri,
            fingerprint,
            source: module.source,
            units: plan.units,
            byUnit,
            bytes
        });

        for (const [, entry] of evicted) {
            this.usedBytes -= entry.bytes;
        }

        this.usedBytes += bytes;
    }

    /** Освободить место под новую запись: сначала уходят самые давние. */
    private evictOldest(incoming: number): void {
        while (this.usedBytes + incoming > this.maxBytes) {
            const oldest = this.entries.peekOldest();

            if (oldest === undefined) {
                this.usedBytes = 0;

                return;
            }

            this.forget(oldest);
        }
    }
}

/**
 * Расчёт без кэша: считается всё, запоминать некуда.
 *
 * Так работают прямые вызовы диагностик — из тестов и batch-клиентов. Кэш
 * принадлежит движку и живёт вместе с открытыми документами; у одиночного
 * вызова владельца нет, и заводить общий на модуль значило бы делить состояние
 * между несвязанными расчётами.
 */
export function runRslUnitDiagnosticsWithoutCache(
    _module: IIndexedModule
): IRslUnitDiagnosticsRun {
    /*
     * Разбиение на единицы здесь не считается вовсе.
     *
     * Оно нужно только для того, чтобы решить, что переиспользовать, и чтобы
     * разложить результат по единицам. Без кэша не делается ни то, ни другое,
     * а на мелком файле лишний обход дерева заметен: таких вызовов по одному
     * на файл при сплошном проходе по проекту.
     */
    return {
        units: [],
        stale: [],
        keep: [],
        reused: [],
        full: true,
        commit: () => undefined,
        abort: () => undefined
    };
}

/** Диагностика единицы с позициями по новому тексту. */
function shiftDiagnostic(
    module: IIndexedModule,
    unit: IRslDocumentUnit,
    record: IRslUnitDiagnosticRecord
): Diagnostic {
    const start = unit.start + record.start;
    const end = unit.start + record.end;
    const lineStarts = module.lex.lineStarts;

    return {
        ...record.diagnostic,
        range: {
            start: positionAtOffset(lineStarts, start),
            end: positionAtOffset(lineStarts, end)
        },
        data: withOffsets(record.diagnostic.data, start, end)
    };
}

/**
 * Смещения внутри data тоже переносятся.
 *
 * По ним Quick Fix находит место правки: оставить прежние значило бы предложить
 * исправление не там, где оно нужно.
 */
function withOffsets(data: unknown, start: number, end: number): unknown {
    if (!data || typeof data !== "object") {
        return data;
    }

    const known = data as { start?: unknown; end?: unknown };

    if (typeof known.start !== "number" || typeof known.end !== "number") {
        return data;
    }

    return { ...data, start, end };
}

/**
 * Раскладывает посчитанные диагностики по единицам.
 *
 * Позиция диагностики переводится в смещение по строкам новой версии: так
 * запись не зависит от того, что именно её создало.
 */
function collectRslUnitDiagnostics(
    module: IIndexedModule,
    units: readonly IRslDocumentUnit[],
    diagnostics: readonly Diagnostic[]
): Map<string, IRslUnitDiagnosticRecord[]> {
    const byUnit = new Map<string, IRslUnitDiagnosticRecord[]>();
    const lineStarts = module.lex.lineStarts;

    for (const diagnostic of diagnostics) {
        const start = offsetOf(lineStarts, diagnostic.range.start);
        const end = offsetOf(lineStarts, diagnostic.range.end);
        const unit = unitAt(units, start);

        if (!unit) {
            continue;
        }

        const records = byUnit.get(unit.id) || [];
        records.push({
            start: start - unit.start,
            end: end - unit.start,
            diagnostic
        });
        byUnit.set(unit.id, records);
    }

    return byUnit;
}

/** Единица, которой принадлежит смещение; по кускам, а не по границам. */
function unitAt(
    units: readonly IRslDocumentUnit[],
    offset: number
): IRslDocumentUnit | undefined {
    for (const unit of units) {
        for (const range of unit.ranges) {
            if (offset >= range.start && offset < range.end) {
                return unit;
            }
        }
    }

    return undefined;
}

function offsetOf(
    lineStarts: readonly number[],
    position: { line: number; character: number }
): number {
    const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));

    return lineStarts[line] + position.character;
}

/** Токены, попадающие в куски перечисленных единиц. */
export function tokensOfRslUnits<T extends { start: number }>(
    tokens: readonly T[],
    units: readonly IRslDocumentUnit[]
): T[] {
    if (units.length === 0) {
        return [];
    }

    const ranges = units
        .flatMap(unit => unit.ranges.map(range => ({ ...range })))
        .sort((first, second) => first.start - second.start);
    const result: T[] = [];

    for (const range of ranges) {
        let low = 0;
        let high = tokens.length;

        while (low < high) {
            const middle = (low + high) >>> 1;

            if (tokens[middle].start < range.start) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        for (let index = low; index < tokens.length; index++) {
            if (tokens[index].start >= range.end) {
                break;
            }

            result.push(tokens[index]);
        }
    }

    return result;
}
