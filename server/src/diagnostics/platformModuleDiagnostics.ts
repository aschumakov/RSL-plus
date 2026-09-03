import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver";

import { createTokenDiagnostic } from "./diagnosticFactory";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { PlatformModuleCatalog } from "../builtins/platformModuleCatalog";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Имя описано в прикладном модуле, который файл не подключает.
 *
 * Отличается от обычного «имя неизвестно» тем, что ответ здесь есть: справка
 * платформы знает, где это имя объявлено. Сказать «RSBParty описан в модуле
 * PTInter, который не подключён» полезнее, чем «RSBParty неизвестен», и рядом
 * с таким сообщением уместно готовое исправление.
 *
 * Проверка молчит в трёх случаях, и это существенно:
 *
 *   имя разрешается — значит оно доступно и без этого Import;
 *   модуль уже подключён — тогда причина не в нём;
 *   имя объявлено в нескольких модулях сразу — выбрать за пользователя один
 *   из них значит соврать, а предложить пять исправлений значит переложить на
 *   него ту же догадку.
 *
 * Цена ограничена обратным указателем каталога: сперва имя ищется в нём —
 * одна проверка по множеству, — и только найденное разрешается резолвером. В
 * обычном файле таких имён нет вовсе, и разрешать ничего не приходится.
 */

export const RSL_PLATFORM_MODULE_NOT_IMPORTED_CODE = "platform-module-not-imported";

export interface IRslPlatformModuleCheckOptions {
    platformModules?: PlatformModuleCatalog;
    /** Прикладные модули, видимые из документа: их подключать не надо. */
    visibleModules: readonly string[];
    limit?: number;
}

export function buildRslPlatformModuleDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    options: IRslPlatformModuleCheckOptions
): Diagnostic[] {
    const catalog = options.platformModules;

    if (!catalog) {
        return [];
    }

    const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
    const visible = new Set(
        options.visibleModules.map(name => normalizeIdentifier(name))
    );
    const result: Diagnostic[] = [];
    /* Одно сообщение на имя: повторять его на каждом вхождении незачем. */
    const reported = new Set<string>();

    for (const token of module.syntax.tokens) {
        if (result.length >= limit) {
            break;
        }

        if (token.kind !== "identifier" || isMemberAccess(module, token)) {
            continue;
        }

        const name = normalizeIdentifier(token.value);

        if (!name || reported.has(name)) {
            continue;
        }

        const owners = catalog.modulesDeclaring(name);

        if (owners.length !== 1) {
            /* Неизвестно каталогу или объявлено сразу в нескольких модулях. */
            continue;
        }

        const owner = owners[0];

        if (visible.has(normalizeIdentifier(owner))) {
            continue;
        }

        /*
         * Разрешение спрашивается последним: оно дороже всего остального, а
         * дойти до него успевают только имена из справки платформы.
         */
        if (resolver.resolveAt(module.uri, module.symbolTree, token.start)) {
            continue;
        }

        reported.add(name);
        result.push(createTokenDiagnostic(
            token,
            DiagnosticSeverity.Warning,
            token.value + " описан в модуле " + owner + ", который не подключён",
            RSL_PLATFORM_MODULE_NOT_IMPORTED_CODE,
            false,
            { moduleName: owner, name: token.value }
        ));
    }

    return result;
}

/**
 * Обращение к члену: `payment.Sum`.
 *
 * Имя члена к прикладному модулю отношения не имеет — его ищут в классе
 * получателя, а не среди имён модуля. Без этой проверки любое совпадение
 * имени члена с именем из справки давало бы ложное сообщение.
 */
function isMemberAccess(module: IIndexedModule, token: IRslToken): boolean {
    const tokens = module.syntax.tokens;
    let at = lowerBound(tokens, token.start) - 1;

    while (at >= 0) {
        const previous = tokens[at];

        if (
            previous.kind === "whitespace" ||
            previous.kind === "newline" ||
            previous.kind === "comment"
        ) {
            at--;
            continue;
        }

        return previous.kind === "symbol" && previous.raw === ".";
    }

    return false;
}

/** Первый токен, начинающийся не раньше смещения. */
function lowerBound(tokens: readonly IRslToken[], offset: number): number {
    let low = 0;
    let high = tokens.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (tokens[middle].start < offset) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    return low;
}
