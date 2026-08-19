import type { Diagnostic } from "vscode-languageserver";

import {
    diffRslDocumentUnits,
    splitRslDocumentUnits,
    type IRslDocumentUnit
} from "../analysis/documentUnits";
import { positionAtOffset } from "../core/documentPosition";
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

export interface IRslUnitDiagnosticsEntry {
    uri: string;
    version: number;
    source: string;
    units: readonly IRslDocumentUnit[];
    byUnit: Map<string, IRslUnitDiagnosticRecord[]>;
}

export interface IRslUnitDiagnosticsPlan {
    /** Единицы, которые нужно посчитать заново. */
    readonly stale: readonly IRslDocumentUnit[];
    /**
     * Единицы, чей результат взят из прошлой записи.
     *
     * Только их записи переносятся в новую запись кэша. Переносить записи
     * пересчитанной единицы нельзя: если правка убрала из неё находку, пустой
     * результат пересчёта унаследовал бы прежнюю — и она осталась бы в кэше
     * навсегда, показывая в Problems уже исправленное.
     */
    readonly keep: readonly IRslDocumentUnit[];
    /** Готовые диагностики неизменившихся единиц, уже с новыми позициями. */
    readonly reused: readonly Diagnostic[];
    /** Все единицы новой версии — в них раскладывается новый результат. */
    readonly units: readonly IRslDocumentUnit[];
    /** Пересчитывается весь файл: прошлого результата нет или он не годится. */
    readonly full: boolean;
}

/**
 * Что пересчитывать и что переносить.
 *
 * Прошлая запись используется только если она о том же файле: единицы
 * сопоставляются по устойчивому идентификатору, а совпадение текста проверяется
 * по обоим исходникам, а не по одному отпечатку.
 */
export function planRslUnitDiagnostics(
    module: IIndexedModule,
    previous: IRslUnitDiagnosticsEntry | undefined
): IRslUnitDiagnosticsPlan {
    /* Границы берутся из уже построенного дерева: см. splitRslDocumentUnits. */
    const units = splitRslDocumentUnits(
        module.source,
        module.lex.tokens,
        module.symbolTree
    );

    if (!previous || previous.uri !== module.uri) {
        return { stale: units, keep: [], reused: [], units, full: true };
    }

    const diff = diffRslDocumentUnits(previous.units, units, {
        previous: previous.source,
        next: module.source
    });
    const reused: Diagnostic[] = [];
    const keep = [...diff.unchanged, ...diff.shifted];

    for (const unit of keep) {
        const records = previous.byUnit.get(unit.id);

        if (!records) {
            continue;
        }

        for (const record of records) {
            reused.push(shiftDiagnostic(module, unit, record));
        }
    }

    return {
        stale: [...diff.changed, ...diff.added],
        keep,
        reused,
        units,
        full: false
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
export function collectRslUnitDiagnostics(
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
