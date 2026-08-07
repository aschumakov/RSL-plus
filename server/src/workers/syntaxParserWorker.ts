import { parentPort } from "worker_threads";

import type { IRslLexResult } from "../lexer";
import {
    parseRslSyntax,
    type IRslSyntaxDiagnostic,
    type IRslSyntaxNode
} from "../syntaxParser";
import {
    decodeTokens,
    encodeTokens,
    type IEncodedTokenColumns
} from "./tokenTransferCodec";

interface IParseRequestLex {
    tokens: IEncodedTokenColumns;
    eol: "\r\n" | "\n" | "\r";
    hasFinalEol: boolean;
    hasBom: boolean;
    lineStarts: number[];
}

interface IParseRequest {
    id: number;
    source: string;
    /*
     * Основной поток уже построил Fast Snapshot lex для этой версии.
     * Раньше worker не получал его и лексировал файл заново — этот проход
     * убирает повторный полный lexer pass на каждый parse.
     */
    lex: IParseRequestLex;
}

interface IWorkerSyntaxResult {
    root: IRslSyntaxNode;
    diagnostics: IRslSyntaxDiagnostic[];
    tokens: IEncodedTokenColumns;
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
        const lex: IRslLexResult = {
            tokens: decodeTokens(request.lex.tokens),
            eol: request.lex.eol,
            hasFinalEol: request.lex.hasFinalEol,
            hasBom: request.lex.hasBom,
            lineStarts: request.lex.lineStarts
        };

        const parsed = parseRslSyntax(
            request.source,
            lex,
            { buildExpressionTree: false }
        );
        const encodedTokens = encodeTokens(parsed.tokens);

        const response: IParseResponse = {
            id: request.id,
            ok: true,
            syntax: {
                root: parsed.root,
                diagnostics: parsed.diagnostics,
                tokens: encodedTokens.columns
            }
        };

        port.postMessage(response, encodedTokens.transferList);
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
