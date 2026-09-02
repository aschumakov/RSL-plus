import { lexRsl } from "../lexer";
import {
    findRslStructuralMatches,
    parseRslStructuralPattern,
    type IRslStructuralMatch
} from "./structuralSearch";
import type { ReferenceIndex } from "../analysis/referenceIndex";
import { rangeInModule } from "../core/documentPosition";
import type { WorkspaceIndex } from "../workspaceIndex";

/**
 * Обход проекта для структурного поиска.
 *
 * Три правила, без которых такой поиск нельзя выпускать: кандидаты отбираются
 * заранее, обход уступает поток по бюджету времени и его можно отменить.
 * Иначе одна команда на проекте в шесть тысяч файлов занимает поток на
 * секунды, и всё это время редактор не отвечает.
 */
export interface IRslStructuralSearchRequest {
    /** Образец: вызов с заполнителями. */
    pattern: string;
    /** Сколько совпадений показывать; остальное не ищется. */
    limit?: number;
}

export interface IRslStructuralSearchHit {
    uri: string;
    range: ReturnType<typeof rangeInModule>;
    /** Текст совпавшего вызова: показывается в списке. */
    text: string;
    bindings: Record<string, string>;
}

export interface IRslStructuralSearchAnswer {
    hits: IRslStructuralSearchHit[];
    /** Сколько файлов действительно прочитано. */
    scannedFiles: number;
    /** Сколько отсеяно до чтения. */
    skippedFiles: number;
    problem?: string;
    cancelled?: boolean;
    /** Достигнут предел: показано не всё. */
    truncated?: boolean;
}

export interface IRslStructuralSearchEnvironment {
    index: WorkspaceIndex;
    referenceIndex: ReferenceIndex;
    /** Уступка интерактивным запросам, когда бюджет времени вышел. */
    yieldToInteractive(): Promise<void>;
    /** Часы: подменяются стендом, чтобы бюджет проверялся без ожидания. */
    now?(): number;
    /** Чтение файла; отдельно, чтобы стенд не зависел от диска. */
    readSource(uri: string): Promise<string | undefined>;
}

/**
 * Сколько времени обход вправе занимать поток между уступками.
 *
 * Считалось порциями по 24 файла, и это неверная мерка: среди
 * кандидатов попадаются файлы по 700 КБ, и такая порция занимала
 * поток надолго. Бюджет времени не зависит от того, какие файлы
 * попались.
 */
const SLICE_BUDGET_MS = 10;
const DEFAULT_LIMIT = 500;

export async function runRslStructuralSearch(
    environment: IRslStructuralSearchEnvironment,
    request: IRslStructuralSearchRequest,
    isCancelled: () => boolean = () => false
): Promise<IRslStructuralSearchAnswer> {
    const parsed = parseRslStructuralPattern(
        request.pattern,
        source => lexRsl(source).tokens
    );

    if (!parsed.pattern) {
        return {
            hits: [],
            scannedFiles: 0,
            skippedFiles: 0,
            problem: parsed.problem || "Образец не разобран"
        };
    }

    const limit = Math.max(1, request.limit ?? DEFAULT_LIMIT);
    const all = environment.index.getWorkspaceFileUris();
    /*
     * Кандидаты отбираются индексом ссылок по имени вызова: файл, где такого
     * имени нет ни в каком виде, разбирать незачем. На настоящем проекте это
     * отсекает почти всё.
     */
    const candidates = await environment.referenceIndex.findCandidates(
        parsed.pattern.callName,
        all,
        isCancelled
    );
    const hits: IRslStructuralSearchHit[] = [];
    let scanned = 0;
    const clock = environment.now ?? now;
    let sliceStartedAt = clock();

    for (const candidate of candidates) {
        if (isCancelled()) {
            return answer(hits, scanned, all.length - scanned, true, false);
        }

        const source = candidate.source ??
            await environment.readSource(candidate.uri);

        if (source === undefined) {
            continue;
        }

        scanned++;

        /*
         * Один разбор на файл: и совпадения, и начала строк берутся
         * из него. Прежде файл лексировался дважды — второй раз
         * только ради того, чтобы перевести смещение в строку.
         */
        const lex = lexRsl(source);
        const found = findRslStructuralMatches(
            parsed.pattern,
            source,
            lex.tokens,
            isCancelled
        );

        if (found.length > 0) {
            appendHits(hits, candidate.uri, source, lex, found, limit);
        }

        if (hits.length >= limit) {
            return answer(hits, scanned, all.length - scanned, false, true);
        }

        /*
         * Уступка по времени, а не по числу файлов.
         *
         * Крупный файл кандидата один занимает поток дольше, чем
         * два десятка обычных, и уступать после него надо сразу.
         */
        if (clock() - sliceStartedAt >= SLICE_BUDGET_MS) {
            await environment.yieldToInteractive();
            sliceStartedAt = clock();
        }
    }

    return answer(hits, scanned, all.length - scanned, false, false);
}

function appendHits(
    hits: IRslStructuralSearchHit[],
    uri: string,
    source: string,
    /* Разбор того же файла: второй раз его лексировать незачем. */
    lex: { lineStarts: readonly number[] },
    found: readonly IRslStructuralMatch[],
    limit: number
): void {
    const lineStarts = lex.lineStarts;

    for (const match of found) {
        if (hits.length >= limit) {
            return;
        }

        hits.push({
            uri,
            range: rangeInModule(
                { lex: { lineStarts } } as never,
                match.start,
                match.end
            ),
            text: source.slice(match.start, match.end),
            bindings: match.bindings
        });
    }
}

/** Часы обхода: вынесены, чтобы стенд мог их подменить. */
function now(): number {
    return Date.now();
}

function answer(
    hits: IRslStructuralSearchHit[],
    scannedFiles: number,
    skippedFiles: number,
    cancelled: boolean,
    truncated: boolean
): IRslStructuralSearchAnswer {
    return {
        hits,
        scannedFiles,
        skippedFiles: Math.max(0, skippedFiles),
        cancelled: cancelled || undefined,
        truncated: truncated || undefined
    };
}
