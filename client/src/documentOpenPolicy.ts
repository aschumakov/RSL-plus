import type { TextDocument, TextEditor, Uri } from "vscode";

/**
 * Кто имеет право открыть документ в редакторе.
 *
 * Анализ кода не открывает файлы. Прежде сервер при неизвестном Import просил
 * клиента найти файл по имени и открыть его через `openTextDocument`: это
 * создавало `didOpen` для документа, который пользователь не открывал, и
 * вмешивалось в жизненный цикл preview-вкладок — открытый переходом файл
 * переставал быть предварительным и оставался в редакторе.
 *
 * Правило простое: документ открывается только вследствие явного действия
 * пользователя. Всё остальное — разбор, диагностика, загрузка Import,
 * Auto Import, индексация — работает с файлами через сервер, не трогая
 * вкладки.
 */
export type RslDocumentOpenReason =
    /** Пользователь выбрал файл в списке макросов. */
    | "quickPick"
    /** Пользователь вызвал команду перехода. */
    | "userCommand"
    /** Фоновый разбор файла. */
    | "analysis"
    /** Загрузка импортированного модуля. */
    | "importLoading"
    /** Публикация Problems. */
    | "diagnostics"
    /** Индексация проекта. */
    | "indexing";

export interface IRslDocumentOpenDecision {
    open: boolean;
    /**
     * Открывать как предварительную вкладку.
     *
     * Указывается явно: без параметра VS Code берёт поведение из настройки
     * `workbench.editor.enablePreview`, и одно и то же действие ведёт себя
     * по-разному у разных пользователей.
     */
    preview: boolean;
    /** Почему решение такое: идёт в лог и в тест. */
    explanation: string;
}

const USER_ACTIONS: ReadonlySet<RslDocumentOpenReason> = new Set([
    "quickPick",
    "userCommand"
]);

export function decideRslDocumentOpen(
    reason: RslDocumentOpenReason
): IRslDocumentOpenDecision {
    if (USER_ACTIONS.has(reason)) {
        return {
            open: true,
            preview: true,
            explanation: "явное действие пользователя"
        };
    }

    return {
        open: false,
        preview: false,
        explanation: "анализ не открывает документы"
    };
}

/**
 * Часть API редактора, которая нужна для открытия документа.
 *
 * Вынесена интерфейсом ради теста: сам модуль `vscode` в тестах недоступен, а
 * проверять надо именно то, что при фоновых причинах эти функции НЕ вызываются.
 */
export interface IRslEditorApi {
    openTextDocument(uri: Uri): Thenable<TextDocument>;
    showTextDocument(
        document: TextDocument,
        options?: { preview?: boolean }
    ): Thenable<TextEditor>;
}

/**
 * Открывает документ, если причина это позволяет.
 *
 * Возвращает принятое решение — вызывающему коду не нужно повторять правило.
 */
export async function openRslDocument(
    api: IRslEditorApi,
    uri: Uri,
    reason: RslDocumentOpenReason
): Promise<IRslDocumentOpenDecision> {
    const decision = decideRslDocumentOpen(reason);

    if (!decision.open) {
        return decision;
    }

    const document = await api.openTextDocument(uri);

    await api.showTextDocument(document, { preview: decision.preview });

    return decision;
}
