import { moduleIdOf } from "../core/identity/uriKey";
import type {
    PlatformModuleCatalog
} from "../builtins/platformModuleCatalog";
import {
    isRslDirectImportComplete,
    resolveRslImportContext
} from "../analysis/resolvedImportContext";
import {
    GetDynamicMacroReferencesFromTokens,
    GetImportDefinitionTargetsFromTokens,
    IImportDefinitionTarget
} from "../execMacroDefinition";
import {
    IRslToken,
    normalizeIdentifier
} from "../lexer";
import {
    RslScopeResolver
} from "../scopeResolver";
import {
    IIndexedModule,
    WorkspaceIndex
} from "../workspaceIndex";
import {
    CompletionItemKind,
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";
import {
    createImportDiagnostic,
    normalizeModuleReference
} from "./diagnosticFactory";
import {
    type IRslDiagnosticStage,
    budgetExpired
} from "./stages";

/*
 * Проверки Import.
 *
 * Существование импортированного модуля, импорт самого себя,
 * неиспользуемый Import.
 */

/**
 * Повторный и конфликтующий по расширению Import.
 *
 * Строго локальная проверка: смотрит только на текст Import текущего файла и
 * не обращается к индексу, поэтому её результат не зависит от готовности
 * обхода workspace (см. addSelfImportDiagnostics).
 */
export function addBasicImportDiagnostics(
    module: IIndexedModule,
    result: Diagnostic[]
): void {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const seenImports = new Set<string>();
    const importedByStem = new Map<string, string>();

    for (const reference of references) {
        const normalizedImport = normalizeModuleReference(reference.moduleName);

        if (seenImports.has(normalizedImport)) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Information,
                `Модуль ${reference.moduleName} импортирован повторно`,
                "duplicate-import",
                true,
                {
                    start: reference.start,
                    end: reference.end,
                    moduleName: reference.moduleName
                }
            ));
        } else {
            seenImports.add(normalizedImport);
        }

        const stem = normalizedImport
            .replace(/^.*\//u, "")
            /* Resolver добавляет .mac к неизвестному расширению. */
            .replace(/\.(?:mac|rsm|d32|dlm)$/iu, "")
            .replace(/\.(?:mac|rsm|d32|dlm)$/iu, "");
        const previous = importedByStem.get(stem);
        if (previous && previous !== normalizedImport) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Error,
                "Нельзя импортировать файлы с одинаковым именем и " +
                    "разными расширениями",
                "duplicate-import-basename"
            ));
        } else if (stem) {
            importedByStem.set(stem, normalizedImport);
        }

        /*
         * Отсутствие файла в workspace не является ошибкой:
         * модуль может входить в базовую поставку RS-Bank.
         */
    }
}

/**
 * Файл импортирует сам себя.
 *
 * Проверка workspace-фазы, а не локальной: имя из Import сопоставляется с
 * файлом через каталог workspace и загруженные модули, то есть результат
 * зависит от готовности индекса. В локальной фазе она молча пропадала бы на
 * файлах, открытых до завершения обхода workspace — ключ локального кэша
 * состояние индекса не учитывает и пересчёта бы не случилось.
 */
export function addSelfImportDiagnostics(
    module: IIndexedModule,
    index: WorkspaceIndex,
    result: Diagnostic[]
): void {
    for (const reference of GetImportDefinitionTargetsFromTokens(
        module.lex.tokens
    )) {
        const imported = index.findModuleByName(reference.moduleName);
        const workspaceUri = index.findWorkspaceFileUri(reference.moduleName);

        if (
            (imported && imported.uri === module.uri) ||
            workspaceUri === module.uri
        ) {
            result.push(createImportDiagnostic(
                module,
                reference,
                DiagnosticSeverity.Warning,
                `Файл импортирует сам себя: ${reference.moduleName}`,
                "self-import"
            ));
        }
    }
}

export interface IUnusedImportContext {
    references: readonly IImportDefinitionTarget[];
    importInfos: Array<{
        reference: IImportDefinitionTarget;
        closureUris: Set<string>;
        publicNames: Set<string>;
        /**
         * Полон ли контекст ЭТОГО Import.
         *
         * Пока нет — вывод «не используется» делать нельзя: имя, которым
         * Import оправдан, может лежать в непрочитанной части его цепочки.
         */
        complete: boolean;
    }>;
    allPublicNames: Set<string>;
    usedImportedUris: Set<string>;
}

/**
 * Неиспользуемые Import — порциями.
 *
 * Проверка идёт по всем идентификаторам файла и для похожих на импортированное
 * имя обращается к резолверу. Одним куском на модуле 700 КБ это занимало поток
 * на двадцать миллисекунд; теперь бюджет сверяется перед каждым обращением, а
 * дешёвый просмотр — изредка, как и в остальных таких проверках.
 *
 * Резолвер берётся общий: свой означал бы холодные кэши на каждый пересчёт.
 */
export function createUnusedImportStage(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    result: Diagnostic[]
): IRslDiagnosticStage {
    let context: IUnusedImportContext | undefined;
    let cursor = 0;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!context) {
            context = prepareUnusedImports(module, index);
        }

        const tokens = module.lex.tokens;
        let processed = 0;

        while (cursor < tokens.length) {
            const token = tokens[cursor];
            const candidate = token.kind === "identifier" &&
                context.allPublicNames.has(
                    normalizeIdentifier(token.value)
                ) &&
                !context.references.some(reference =>
                    reference.start <= token.start && token.end <= reference.end
                );

            if (
                candidate
                    ? shouldYield?.() === true
                    : budgetExpired(processed, shouldYield)
            ) {
                return true;
            }

            if (candidate) {
                markUsedImport(module, index, resolver, token, context);
            }

            cursor++;
            processed++;
        }

        reportUnusedImports(module, context, result);

        return false;
    };
}

/** Что импортировано и какие имена оттуда видны: считается один раз. */
export function prepareUnusedImports(
    module: IIndexedModule,
    index: WorkspaceIndex,
    platformModules?: PlatformModuleCatalog
): IUnusedImportContext {
    const references = GetImportDefinitionTargetsFromTokens(module.lex.tokens);
    const dynamicMacroNames = GetDynamicMacroReferencesFromTokens(module.lex.tokens);
    const importInfos: IUnusedImportContext["importInfos"] = [];

    /*
     * Полнота считается отдельно для каждого прямого Import: см.
     * resolveRslImportContext. Соседний непрозрачный Import на вывод про
     * этот влиять не должен.
     */
    const context = resolveRslImportContext(index, module.uri, {
        platformModules
    });
    /*
     * Ключ — каноническая идентичность модуля, а не написание: ссылка даёт
     * `beta.mac`, директива `beta`, и это один и тот же модуль.
     */
    const byName = new Map(context.directImports.map(item =>
        [moduleIdOf(item.name) as string, item]));

    for (const reference of references) {
        const direct = byName.get(
            moduleIdOf(reference.moduleName) as string
        );

        /*
         * Имя разрешает общий resolver — он один знает порядок «проект,
         * потом библиотеки». Поиск среди загруженных по базовому имени
         * этого порядка не знает.
         */
        if (!direct || direct.kind !== "workspace" || !direct.uri) {
            continue;
        }

        const imported = index.getModule(direct.uri);

        /* Проверяем только модули, известные текущему проекту. */
        if (!imported || imported.uri === module.uri) {
            continue;
        }

        const closure = [...direct.closureUris]
            .map(item => index.getModule(item))
            .filter((item): item is IIndexedModule => item !== undefined);
        const closureUris = new Set(closure.map(item => item.uri));
        const publicNames = new Set<string>();

        closure.forEach(item => {
            item.symbolTree.children
                .filter(child => !child.isPrivate)
                .filter(child =>
                    child.kind === CompletionItemKind.Variable ||
                    child.kind === CompletionItemKind.Constant ||
                    child.kind === CompletionItemKind.Function ||
                    child.kind === CompletionItemKind.Class
                )
                .forEach(child =>
                    publicNames.add(normalizeIdentifier(child.name))
                );
        });

        importInfos.push({
            reference,
            closureUris,
            publicNames,
            complete: isRslDirectImportComplete(direct)
        });
    }

    const allPublicNames = new Set<string>();
    importInfos.forEach(info =>
        info.publicNames.forEach(name => allPublicNames.add(name))
    );

    const usedImportedUris = new Set<string>();

    /*
     * Динамические вызовы учитываются сразу: их немного, и они не зависят от
     * обхода токенов.
     */
    dynamicMacroNames.forEach(name => {
        index.findImportedSymbols(module.uri, name)
            .forEach(resolved => usedImportedUris.add(resolved.uri));
    });

    return { references, importInfos, allPublicNames, usedImportedUris };
}

/** Одна ссылка: из какого импортированного модуля пришло это имя. */
export function markUsedImport(
    module: IIndexedModule,
    index: WorkspaceIndex,
    resolver: RslScopeResolver,
    token: IRslToken,
    context: IUnusedImportContext
): void {
    const candidates = index.findImportedSymbols(module.uri, token.value);

    if (candidates.length > 1) {
        candidates.forEach(candidate =>
            context.usedImportedUris.add(candidate.uri)
        );

        return;
    }

    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        token.start
    );

    if (resolved && resolved.uri !== module.uri) {
        context.usedImportedUris.add(resolved.uri);
    }
}

/** Итог обхода: какие Import остались невостребованными. */
export function reportUnusedImports(
    module: IIndexedModule,
    context: IUnusedImportContext,
    result: Diagnostic[]
): void {
    const { importInfos, usedImportedUris } = context;

    importInfos.forEach(info => {
        /*
         * Контекст этого Import неполон: часть его цепочки ещё не
         * прочитана, неоднозначна или непрозрачна. Имя, которым он
         * оправдан, может лежать именно там — и «не используется» тогда
         * неправда. Сосед с таким же изъяном проверку не выключает: у
         * каждого Import полнота своя.
         */
        if (!info.complete) {
            return;
        }

        /* Модуль без публичных объявлений может импортироваться ради side effects. */
        if (info.publicNames.size === 0) {
            return;
        }

        const used = Array.from(info.closureUris)
            .some(uri => usedImportedUris.has(uri));

        if (used) {
            return;
        }

        result.push(createImportDiagnostic(
            module,
            info.reference,
            DiagnosticSeverity.Warning,
            `Импорт ${info.reference.moduleName}, возможно, не используется`,
            "unused-import",
            true,
            {
                start: info.reference.start,
                end: info.reference.end,
                moduleName: info.reference.moduleName
            }
        ));
    });
}
