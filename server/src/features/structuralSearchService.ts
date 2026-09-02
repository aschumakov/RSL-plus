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
 * заранее, обход идёт порциями и его можно отменить. Иначе одна команда на
 * проекте в шесть тысяч файлов занимает поток на секунды, и всё это время
 * редактор не отвечает.
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
    /** Уступка интерактивным запросам между порциями. */
    yieldToInteractive(): Promise<void>;
    /** Чтение файла; отдельно, чтобы стенд не зависел от диска. */
    readSource(uri: string): Promise<string | undefined>;
}

const FILES_PER_CHUNK = 24;
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

    for (let at = 0; at < candidates.length; at += FILES_PER_CHUNK) {
        if (isCancelled()) {
            return answer(hits, scanned, all.length - scanned, true, false);
        }

        const chunk = candidates.slice(at, at + FILES_PER_CHUNK);

        for (const candidate of chunk) {
            const source = candidate.source ??
                await environment.readSource(candidate.uri);

            if (source === undefined) {
                continue;
            }

            scanned++;

            const found = findRslStructuralMatches(
                parsed.pattern,
                source,
                lexRsl(source).tokens,
                isCancelled
            );

            if (found.length > 0) {
                appendHits(hits, candidate.uri, source, found, limit);
            }

            if (hits.length >= limit) {
                return answer(
                    hits,
                    scanned,
                    all.length - scanned,
                    false,
                    true
                );
            }
        }

        /* Порция кончилась — уступаем поток тому, кто ждёт ответа. */
        await environment.yieldToInteractive();
    }

    return answer(hits, scanned, all.length - scanned, false, false);
}

function appendHits(
    hits: IRslStructuralSearchHit[],
    uri: string,
    source: string,
    found: readonly IRslStructuralMatch[],
    limit: number
): void {
    const lineStarts = lexRsl(source).lineStarts;

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
