import { parentPort } from "worker_threads";

import type { IRslToken } from "../lexer";
import {
    parseRslSyntax,
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
        error: string;
    };

const port = parentPort;

if (!port) {
    throw new Error("syntaxParserWorker запущен без parentPort");
}

port.on("message", (request: IParseRequest) => {
    try {
        const parsed = parseRslSyntax(
            request.source,
            undefined,
            { buildExpressionTree: false }
        );

        /*
         * lex обратно не отправляем:
         * на основном потоке уже есть Fast Snapshot для этой версии.
         */
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
        const response: IParseResponse = {
            id: request.id,
            ok: false,
            error: errorToString(error)
        };

        port.postMessage(response);
    }
});

function errorToString(error: unknown): string {
    return error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack || ""}`
        : String(error);
}