import { lexRsl } from "../lexer";
import {
    findRslStructuralMatches,
    parseRslStructuralPattern,
    type IRslStructuralPattern,
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
    /**
     * Версия открытого документа; пусто, если файл не открыт.
     *
     * Нужна замене: версия входит в саму правку, и правку для устаревшего
     * документа отклонит редактор.
     */
    documentVersion?(uri: string): number | undefined;
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

/** Что обход сообщает о каждом прочитанном файле. */
export interface IRslStructuralFile {
    uri: string;
    source: string;
    /** Разбор этого файла: второй раз лексировать его незачем. */
    lex: ReturnType<typeof lexRsl>;
    matches: readonly IRslStructuralMatch[];
}

export interface IRslStructuralWalkResult {
    scannedFiles: number;
    totalFiles: number;
    cancelled: boolean;
    /** Обработчик попросил остановиться: предел достигнут. */
    stopped: boolean;
}

/**
 * Обход кандидатов с одним разбором на файл.
 *
 * Общий для поиска и замены. Замена обязана видеть ровно те же
 * совпадения, что и поиск, и получать их тем же разбором: второй полный
 * lex файла ради того же ответа — это цена, за которую ничего не куплено.
 *
 * Три правила обхода, без которых такую команду нельзя выпускать:
 * кандидаты отбираются заранее индексом ссылок, обход уступает поток по
 * бюджету времени и его можно отменить.
 */
export async function walkRslStructuralCandidates(
    environment: IRslStructuralSearchEnvironment,
    pattern: IRslStructuralPattern,
    isCancelled: () => boolean,
    onFile: (file: IRslStructuralFile) => boolean
): Promise<IRslStructuralWalkResult> {
    const all = environment.index.getWorkspaceFileUris();
    /*
     * Кандидаты отбираются индексом ссылок по имени вызова: файл, где
     * такого имени нет ни в каком виде, разбирать незачем. На настоящем
     * проекте это отсекает почти всё.
     */
    const candidates = await environment.referenceIndex.findCandidates(
        pattern.callName,
        all,
        isCancelled
    );
    const clock = environment.now ?? now;
    let sliceStartedAt = clock();
    let scanned = 0;

    for (const candidate of candidates) {
        if (isCancelled()) {
            return {
                scannedFiles: scanned,
                totalFiles: all.length,
                cancelled: true,
                stopped: false
            };
        }

        const source = candidate.source ??
            await environment.readSource(candidate.uri);

        if (source === undefined) {
            continue;
        }

        scanned++;

        const lex = lexRsl(source);
        const matches = findRslStructuralMatches(
            pattern,
            source,
            lex.tokens,
            isCancelled
        );

        if (!onFile({ uri: candidate.uri, source, lex, matches })) {
            return {
                scannedFiles: scanned,
                totalFiles: all.length,
                cancelled: false,
                stopped: true
            };
        }

        /*
         * Уступка по времени, а не по числу файлов.
         *
         * Крупный файл кандидата один занимает поток дольше, чем два
         * десятка обычных, и уступать после него надо сразу.
         */
        if (clock() - sliceStartedAt >= SLICE_BUDGET_MS) {
            await environment.yieldToInteractive();
            sliceStartedAt = clock();
        }
    }

    return {
        scannedFiles: scanned,
        totalFiles: all.length,
        cancelled: false,
        stopped: false
    };
}

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
    const hits: IRslStructuralSearchHit[] = [];
    const walked = await walkRslStructuralCandidates(
        environment,
        parsed.pattern,
        isCancelled,
        file => {
            if (file.matches.length > 0) {
                appendHits(
                    hits,
                    file.uri,
                    file.source,
                    file.lex,
                    file.matches,
                    limit
                );
            }

            return hits.length < limit;
        }
    );

    return answer(
        hits,
        walked.scannedFiles,
        walked.totalFiles - walked.scannedFiles,
        walked.cancelled,
        walked.stopped
    );
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
