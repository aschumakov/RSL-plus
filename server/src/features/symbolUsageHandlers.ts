import {
    CancellationToken,
    DocumentHighlight,
    DocumentHighlightParams,
    ErrorCodes,
    Location,
    PrepareRenameParams,
    ReferenceParams,
    RenameParams,
    ResponseError,
    WorkspaceEdit,
    type TextDocuments
} from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import { tokenAtOffset } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import type { ParseWaitMode } from "../services/documentAnalysisService";
import { findRslReferencesInWorkspace } from "../analysis/references";
import type { ReferenceIndex } from "../analysis/referenceIndex";
import type {
    RslReferenceShardStore
} from "../analysis/referenceShards";
import { isBlockedToken, requestIsStale } from "./requestHelpers";
import { buildRslDocumentHighlights } from "./documentHighlights";
import {
    buildRslRenameEdit,
    findRslRenameConflict,
    prepareRslRename,
    type IRslPrepareRenameResult
} from "./renameProvider";

/*
 * Использования символа: подсветка вхождений, поиск ссылок, переименование.
 *
 * Собраны вместе, потому что отвечают на один и тот же вопрос — где ещё
 * встречается это имя, — и всем трём нужно одно и то же: модель РОВНО той
 * версии, для которой пришёл запрос. Ответ по отставшей модели здесь не
 * «немного устаревший», а прямо неверный: подсветка ложится на чужие места, а
 * переименование правит текст по сдвинувшимся смещениям и портит файл.
 */

export interface IRslSymbolUsageEnvironment {
    documents: TextDocuments<TextDocument>;
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    referenceIndex: ReferenceIndex;
    /** Постоянные записи о ссылках, если сервер их ведёт. */
    referenceShards?: RslReferenceShardStore;
    ensureDocumentParsed(
        document: TextDocument,
        mode?: ParseWaitMode
    ): Promise<RslSymbol | undefined>;
    noteInteractiveActivity?(): void;
}

export interface IRslSymbolUsageHandlers {
    documentHighlight(
        params: DocumentHighlightParams,
        cancellationToken: CancellationToken
    ): Promise<DocumentHighlight[]>;
    references(
        params: ReferenceParams,
        cancellationToken: CancellationToken
    ): Promise<Location[]>;
    prepareRename(
        params: PrepareRenameParams,
        cancellationToken: CancellationToken
    ): Promise<IRslPrepareRenameResult | null>;
    rename(
        params: RenameParams,
        cancellationToken: CancellationToken
    ): Promise<WorkspaceEdit | null>;
}

export function createRslSymbolUsageHandlers(
    environment: IRslSymbolUsageEnvironment
): IRslSymbolUsageHandlers {
    /**
     * Модель этой самой версии документа — или undefined.
     *
     * `mode` различает действие пользователя и фон: подсветка вхождений идёт за
     * курсором и не имеет права торопить разбор, а Rename и References —
     * действия, и ждать им можно.
     */
    const awaitModel = async (
        document: TextDocument,
        version: number,
        cancellationToken: CancellationToken,
        mode?: ParseWaitMode
    ): Promise<IIndexedModule | undefined> => {
        await environment.ensureDocumentParsed(document, mode);

        if (requestIsStale(document, version, cancellationToken)) {
            return undefined;
        }

        return environment.index.getCurrentModule(document.uri, version);
    };

    const documentOf = (
        uri: string
    ): TextDocument | undefined => {
        const document = environment.documents.get(uri);

        if (document) {
            environment.noteInteractiveActivity?.();
        }

        return document;
    };

    /** Позиция в модели: смещение и токен под ним. */
    const positionIn = (
        module: IIndexedModule,
        document: TextDocument,
        position: { line: number; character: number }
    ): { offset: number; blocked: boolean } => {
        const offset = document.offsetAt(position);

        return {
            offset,
            blocked: isBlockedToken(
                tokenAtOffset(module.lex.tokens, offset, true)
            )
        };
    };

    return {
        async documentHighlight(params, cancellationToken) {
            const document = documentOf(params.textDocument.uri);

            if (!document) {
                return [];
            }

            /*
             * Подсветка вхождений идёт за курсором, а он двигается на каждый
             * набранный символ. Это фон, а не действие пользователя.
             */
            const model = await awaitModel(
                document,
                document.version,
                cancellationToken,
                "scheduled"
            );

            if (!model) {
                return [];
            }

            const at = positionIn(model, document, params.position);

            return at.blocked
                ? []
                : buildRslDocumentHighlights(
                    model,
                    environment.index,
                    environment.resolver,
                    at.offset
                );
        },

        async references(params, cancellationToken) {
            const document = documentOf(params.textDocument.uri);

            if (!document) {
                return [];
            }

            const model = await awaitModel(
                document,
                document.version,
                cancellationToken
            );

            if (!model) {
                return [];
            }

            const at = positionIn(model, document, params.position);

            if (at.blocked) {
                return [];
            }

            /* ReferenceIndex отбирает файлы до точного transient parse. */
            return findRslReferencesInWorkspace(
                environment.index,
                environment.resolver,
                environment.referenceIndex,
                document.uri,
                at.offset,
                params.context.includeDeclaration,
                () => cancellationToken.isCancellationRequested,
                environment.referenceShards
            );
        },

        async prepareRename(params, cancellationToken) {
            const document = documentOf(params.textDocument.uri);

            if (!document) {
                return null;
            }

            const model = await awaitModel(
                document,
                document.version,
                cancellationToken
            );

            return model
                ? prepareRslRename(
                    model,
                    environment.resolver,
                    document.offsetAt(params.position)
                )
                : null;
        },

        async rename(params, cancellationToken) {
            const document = documentOf(params.textDocument.uri);

            if (!document) {
                return null;
            }

            const model = await awaitModel(
                document,
                document.version,
                cancellationToken
            );

            if (!model) {
                return null;
            }

            const offset = document.offsetAt(params.position);
            /*
             * Конфликт проверяется ДО правок и сообщается ошибкой запроса, а не
             * пустым результатом: пустой результат редактор показывает как
             * «переименовать нечего», и настоящая причина до пользователя не
             * доходит.
             */
            const conflict = findRslRenameConflict(
                model,
                environment.resolver,
                offset,
                params.newName
            );

            if (conflict) {
                throw new ResponseError(ErrorCodes.InvalidRequest, conflict);
            }

            return buildRslRenameEdit(
                model,
                environment.index,
                environment.resolver,
                environment.referenceIndex,
                offset,
                params.newName,
                () => cancellationToken.isCancellationRequested,
                environment.referenceShards
            );
        }
    };
}
