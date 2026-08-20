import {
    CompletionParams,
    CompletionTriggerKind,
    CancellationToken
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import type { IRslToken } from "../lexer";

/*
 * Мелочи, общие для обработчиков запросов.
 *
 * Живут отдельно от обоих потребителей — реестра возможностей и обработчика
 * Completion, — потому что нужны обоим: класть их в один из них значило бы
 * заставить второй импортировать первый по кругу.
 */

/** Причина запроса: её видно в журнале рядом со временем ответа. */
export function completionTrigger(params: CompletionParams): string {
    switch (params.context?.triggerKind) {
        case CompletionTriggerKind.TriggerCharacter:
            return "символ " + (params.context?.triggerCharacter || "");
        case CompletionTriggerKind.TriggerForIncompleteCompletions:
            return "повтор";
        default:
            return "вызов";
    }
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Запрос устарел: документ уже другой версии или запрос отменён.
 *
 * Отвечать по устаревшему состоянию нельзя: смещение позиции считается по
 * текущему тексту, а модель — по прежнему.
 */
export function requestIsStale(
    document: TextDocument,
    version: number,
    cancellationToken?: CancellationToken
): boolean {
    return document.version !== version ||
        cancellationToken?.isCancellationRequested === true;
}

/**
 * Позиция, где подсказок не бывает: строка, комментарий, квадратный блок.
 *
 * Это не код, и предлагать там имена языка значит мешать набору текста.
 */
export function isBlockedToken(token?: IRslToken): boolean {
    return !!token && (
        token.kind === "string" ||
        token.kind === "square" ||
        token.kind === "comment"
    );
}
