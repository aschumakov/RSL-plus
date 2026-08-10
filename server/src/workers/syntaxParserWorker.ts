import { parentPort, workerData } from "worker_threads";

import type { IRslToken } from "../lexer";
import {
    parseRslSyntax,
    RslParseCancelledError,
    type IRslSyntaxDiagnostic,
    type IRslSyntaxNode
} from "../syntaxParser";

interface IParseRequest {
    id: number;
    source: string;
}

interface IWorkerSyntaxResult {
    root: IRslSyntaxNode;
    diagnostics: IRslSyntaxDiagnostic[];
    tokens: IRslToken[];
}

type IParseResponse =
    | {
        id: number;
        ok: true;
        syntax: IWorkerSyntaxResult;
    }
    | {
        id: number;
        ok: false;
        cancelled: true;
    }
    | {
        id: number;
        ok: false;
        error: string;
    };

const port = parentPort;

if (!port) {
    throw new Error("syntaxParserWorker запущен без parentPort");
}

/*
 * Разделяемый флаг отмены. Основной поток записывает сюда id запроса,
 * результат которого больше не нужен; parser опрашивает флаг и прерывается.
 * Без этого отменённый разбор продолжал занимать worker физически, и
 * активный документ ждал не своей очереди, а завершения чужой устаревшей
 * работы (единственной альтернативой было убийство самого потока).
 */
const cancelSignal = (workerData as { cancelSignal?: Int32Array } | null)
    ?.cancelSignal;

/*
 * Раньше здесь передавался готовый lex с основного потока и токены уходили
 * через columnar transferable-кодек (см. историю файла). Замеры показали
 * обратный эффект: ответ доминирует размером дерева `root` (каждый узел
 * несёт свой срез tokens), поэтому выигрыш кодека на верхнеуровневом массиве
 * тонет в общей стоимости structured clone, а передача lex на вход добавляет
 * чистые накладные расходы. Контролируемый бенчмарк (500/150/40 замеров на
 * файлах ~1KB/15KB/160KB) показал реальную деградацию на 19-33% относительно
 * простого relex + обычного structured clone. Возврат к этому варианту —
 * не упрощение, а исправление реальной регрессии.
 */
port.on("message", (request: IParseRequest) => {
    try {
        const parsed = parseRslSyntax(
            request.source,
            undefined,
            {
                buildExpressionTree: false,
                isCancelled: cancelSignal
                    ? () => Atomics.load(cancelSignal, 0) === request.id
                    : undefined
            }
        );

        const response: IParseResponse = {
            id: request.id,
            ok: true,
            syntax: {
                root: parsed.root,
                diagnostics: parsed.diagnostics,
                tokens: parsed.tokens
            }
        };

        port.postMessage(response);
    } catch (error) {
        const response: IParseResponse = error instanceof RslParseCancelledError
            ? { id: request.id, ok: false, cancelled: true }
            : { id: request.id, ok: false, error: errorToString(error) };

        port.postMessage(response);
    }
});

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack || ""}`
        : String(error);
}
