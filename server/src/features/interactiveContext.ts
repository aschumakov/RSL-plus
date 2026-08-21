import type { TextDocument } from "vscode-languageserver-textdocument";

import { tokenAtOffset, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type {
    IIndexedModule,
    WorkspaceIndex
} from "../workspaceIndex";
import type {
    IFastDocumentSnapshot
} from "../services/fastDocumentSnapshot";
import {
    getFastCompletionIndex,
    type IFastCompletionIndex
} from "./fastCompletionIndex";

/**
 * Состояние документа, по которому отвечает интерактивный запрос.
 *
 * Ctrl+Click, Hover и подсказка параметров приходят сразу после набора текста,
 * когда полная модель этой версии ещё считается. Ждать её значило заставлять
 * пользователя ждать вместе с ней: на модуле 584 КБ это 120–260 мс, то есть
 * переход «не работает», а подсказка появляется с опозданием.
 *
 * Поэтому у запроса есть контекст из того, что уже готово. Собирается он
 * ЛЕНИВО: переходу по Import достаточно токенов, и строить ради него индекс
 * версии — это лишние десятки миллисекунд на большом файле. Индекс появляется
 * только там, где нужны области видимости, типы и члены.
 */
export interface IRslInteractiveContext {
    document: TextDocument;
    uri: string;
    /** Версия документа на момент запроса: по ней проверяется устаревание. */
    version: number;
    offset: number;
    /** Токены ТЕКУЩЕЙ версии: из модели, если она есть, иначе из снимка. */
    readonly tokens: readonly IRslToken[];
    readonly token?: IRslToken;
    /** Модель ровно этой версии; undefined — она ещё считается. */
    module?: IIndexedModule;
    /** Import ТЕКУЩЕГО текста: из модели этой версии либо из индекса версии. */
    readonly imports: readonly string[];
    /** Индекс версии: строится при первом обращении. */
    readonly fastIndex: IFastCompletionIndex;
    /** Запрос устарел: документ изменился или запрос отменён. */
    isStale(): boolean;
}

export interface IRslInteractiveEnvironment {
    index: WorkspaceIndex;
    resolver: RslScopeResolver;
    getFastDocumentSnapshot(document: TextDocument): IFastDocumentSnapshot;
    getCurrentModule(document: TextDocument): IIndexedModule | undefined;
}

export function createRslInteractiveContext(
    environment: IRslInteractiveEnvironment,
    document: TextDocument,
    offset: number,
    isCancelled: () => boolean
): IRslInteractiveContext {
    const version = document.version;
    const module = environment.getCurrentModule(document);
    let snapshot: IFastDocumentSnapshot | undefined;
    let fastIndex: IFastCompletionIndex | undefined;
    let tokens: readonly IRslToken[] | undefined = module
        ? module.lex.tokens
        : undefined;
    let token: IRslToken | undefined;
    let tokenResolved = false;

    const ensureSnapshot = (): IFastDocumentSnapshot => {
        if (!snapshot) {
            snapshot = environment.getFastDocumentSnapshot(document);
        }

        return snapshot;
    };

    return {
        document,
        uri: document.uri,
        version,
        offset,
        module,
        get tokens(): readonly IRslToken[] {
            if (!tokens) {
                tokens = ensureSnapshot().lex.tokens;
            }

            return tokens;
        },
        get token(): IRslToken | undefined {
            if (!tokenResolved) {
                token = tokenAtOffset(this.tokens, offset, true);
                tokenResolved = true;
            }

            return token;
        },
        get imports(): readonly string[] {
            /*
             * У готовой модели Import того же текста, что и у документа:
             * строить ради них индекс версии незачем.
             */
            return module ? module.imports : this.fastIndex.imports;
        },
        get fastIndex(): IFastCompletionIndex {
            if (!fastIndex) {
                fastIndex = getFastCompletionIndex(ensureSnapshot());
            }

            return fastIndex;
        },
        isStale: () => document.version !== version || isCancelled()
    };
}

/**
 * Переход, для которого достаточно токенов и индекса проекта.
 *
 * Это переходы между файлами, ради которых Ctrl+Click в этом языке и нужен:
 * имя модуля в Import, имя процедуры в строке ExecMacro и имя, объявленное не в
 * этом файле. Локальные переходы остаются полной модели: там она и так готова к
 * моменту, когда пользователь целится в имя.
 */
