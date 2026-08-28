import type { IRslSnapshotDependencies } from "./computationSnapshot";

/**
 * Реестр проверок: что за проверка, когда её результат устаревает и что нужно
 * посчитать до неё.
 *
 * Раньше это знание было размазано по плану: включённость — в таблице этапов,
 * кэшируемость — в отдельном множестве имён, отпечаток настроек — в выписанном
 * вручную списке полей, порядок — в порядке строк таблицы. Списки расходились с
 * таблицей молча: добавленная проверка не попадала в отпечаток, и снятая
 * галочка не пересчитывала ничего.
 *
 * Теперь описание одно, а производные считаются из него: множество кэшируемых
 * проверок, отпечаток настроек кэша, зависимость фазы от Import и каталога.
 * Тест сверяет реестр с фактической таблицей этапов — иначе реестр стал бы
 * документацией, которая врёт.
 */

export type RslDiagnosticPhase = "local" | "workspace";

/**
 * Граница переиспользования результата.
 *
 * "unit" — результат зависит ровно от своей единицы документа (тело Macro,
 * поле класса) и переносится на новую версию сдвигом смещений.
 * "file" — зависит от всего файла: правка в любом месте требует пересчёта.
 * "none" — результат не запоминается вовсе: этап ничего не находит, а готовит.
 */
export type RslDiagnosticCacheBoundary = "unit" | "file" | "none";

export interface IRslDiagnosticRule {
    /** Имя этапа в плане: по нему же идут замеры длительности порций. */
    id: string;
    phase: RslDiagnosticPhase;
    /**
     * Настройки, от которых зависит результат.
     *
     * Из них складывается отпечаток кэша: при смене любой из них прошлая
     * запись не годится.
     */
    settings: readonly string[];
    /** Этапы, которые обязаны отработать раньше. */
    requires: readonly string[];
    /** Из чего складывается ключ переиспользования. */
    depends: IRslSnapshotDependencies;
    cache: RslDiagnosticCacheBoundary;
    /**
     * Отдаёт ли этап управление внутри себя.
     *
     * Непрерываемый этап на большом файле занимает поток целиком: между этапами
     * управление возвращается, внутри — нет.
     */
    resumable: boolean;
    /**
     * Находит ли этап что-нибудь.
     *
     * Подготовительные этапы — индекс идентификаторов, прогрев резолвера —
     * ничего не сообщают пользователю, но без них не работают те, кто сообщает.
     * Отличие нужно частичному пересчёту: пропускать можно только то, что
     * находит, и только вместе с ненужной ему подготовкой.
     */
    produces: boolean;
}

/** Зависимость только от текста и настроек. */
const TEXT_ONLY: IRslSnapshotDependencies = { text: true, settings: true };
/** Текст и замыкание Import: проверка читает импортированные модули. */
const WITH_IMPORTS: IRslSnapshotDependencies = {
    text: true,
    importClosure: true,
    settings: true
};
/** Ещё и состав проекта: проверка отвечает про проект, а не про импорты. */
const WITH_CATALOG: IRslSnapshotDependencies = {
    text: true,
    importClosure: true,
    catalog: true,
    settings: true
};

export const RSL_DIAGNOSTIC_RULES: readonly IRslDiagnosticRule[] = [
    {
        id: "parser",
        phase: "local",
        settings: [],
        requires: [],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "limits",
        phase: "local",
        settings: [],
        requires: [],
        depends: TEXT_ONLY,
        cache: "unit",
        resumable: true,
        produces: true
    },
    {
        id: "unterminated",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "unit",
        resumable: true,
        produces: true
    },
    {
        id: "brackets",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "end",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "unreachable",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "duplicates",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "significantTokens",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "none",
        resumable: true,
        produces: false
    },
    {
        id: "importReferences",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "none",
        resumable: true,
        produces: false
    },
    {
        id: "imports",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "importPlacement",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "resolverWarmup",
        phase: "local",
        settings: ["structure"],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "none",
        resumable: false,
        produces: false
    },
    {
        id: "constantAssignment",
        phase: "local",
        settings: ["structure"],
        requires: ["resolverWarmup"],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "localVisibility",
        phase: "local",
        settings: ["structure"],
        requires: ["resolverWarmup"],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "scalarMembers",
        phase: "local",
        settings: ["structure"],
        requires: ["resolverWarmup"],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        /*
         * Число аргументов сверяется с однозначно разрешённой сигнатурой,
         * поэтому проверка зависит от импортов и не кэшируется по единицам:
         * сигнатура может прийти из другого файла.
         */
        id: "argumentCount",
        phase: "local",
        settings: ["argumentCount"],
        requires: ["resolverWarmup"],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "incompatibleOverride",
        phase: "local",
        settings: ["incompatibleOverride"],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "coreDialect",
        phase: "local",
        settings: ["structure", "dialect"],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "identifierIndex",
        phase: "local",
        settings: ["useBeforeDeclaration", "unusedVariables"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "none",
        resumable: true,
        produces: false
    },
    {
        id: "declarationFacts",
        phase: "local",
        settings: ["useBeforeDeclaration", "unusedVariables"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "none",
        resumable: true,
        produces: false
    },
    {
        id: "useBeforeDeclaration",
        phase: "local",
        settings: ["useBeforeDeclaration"],
        requires: ["identifierIndex", "declarationFacts"],
        depends: TEXT_ONLY,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        /*
         * Пять проверок одного оператора: присваивание самому себе,
         * сравнение с самим собой, постоянное условие, повторное условие
         * ветки, выражение без эффекта. Настройки у них разные, обход
         * общий — поэтому в плане это один этап.
         */
        id: "statements",
        phase: "local",
        settings: [
            "selfAssignment",
            "selfComparison",
            "constantCondition",
            "duplicateBranchCondition",
            "unusedExpression",
            "overwrittenValue"
        ],
        requires: [],
        depends: TEXT_ONLY,
        /*
         * Оператор и цепочка if/elif целиком лежат в своей единице, и
         * ответ правил зависит ровно от её текста: правка в одной
         * процедуре не меняет находок в остальных.
         */
        cache: "unit",
        resumable: true,
        produces: true
    },
    {
        id: "deprecated",
        phase: "local",
        settings: ["deprecatedDeclarations"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "unit",
        resumable: true,
        produces: true
    },
    {
        id: "debugBreak",
        phase: "local",
        settings: ["debugBreak"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "unit",
        resumable: true,
        produces: true
    },
    {
        id: "unused",
        phase: "local",
        settings: ["unusedVariables"],
        requires: ["identifierIndex", "declarationFacts", "resolverWarmup"],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        /*
         * Присваивание необъявленной переменной.
         *
         * Единственная кэшируемая по единицам проверка, которая читает импорты:
         * переменную может объявлять импортированный модуль. Поэтому её лента
         * кэша отдельная — дочитанный Import обнуляет её, но не трогает
         * проверки, зависящие только от текста.
         */
        id: "undeclaredAssignments",
        phase: "local",
        settings: [
            "unknownVariables",
            "unknownVariablesAuditFile",
            "unknownVariablesKnownGlobalsFile"
        ],
        requires: ["resolverWarmup"],
        depends: WITH_IMPORTS,
        cache: "unit",
        resumable: true,
        produces: true
    },
    {
        id: "importReferences",
        phase: "workspace",
        settings: ["structure", "unusedImports"],
        requires: [],
        depends: TEXT_ONLY,
        cache: "none",
        resumable: true,
        produces: false
    },
    {
        id: "selfImport",
        phase: "workspace",
        settings: ["structure"],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "ambiguousReferences",
        phase: "workspace",
        settings: ["ambiguousReferences"],
        requires: [],
        depends: WITH_CATALOG,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "unusedImports",
        phase: "workspace",
        settings: ["unusedImports"],
        requires: ["importReferences"],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: true,
        produces: true
    },
    {
        id: "redundantImports",
        phase: "workspace",
        settings: ["redundantImports"],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "specialVariables",
        phase: "workspace",
        settings: [
            "unknownSpecialVariables",
            "unknownVariablesKnownGlobalsFile"
        ],
        requires: [],
        depends: WITH_IMPORTS,
        cache: "file",
        resumable: false,
        produces: true
    },
    {
        id: "unknownVariables",
        phase: "workspace",
        settings: [
            "unknownVariables",
            "unknownMembers",
            "unknownVariablesAuditFile",
            "unknownVariablesKnownGlobalsFile"
        ],
        requires: [],
        depends: WITH_CATALOG,
        cache: "file",
        resumable: false,
        produces: true
    }
];

/** Описание проверки по имени этапа: имена уникальны внутри фазы. */
export function rslDiagnosticRule(
    phase: RslDiagnosticPhase,
    id: string
): IRslDiagnosticRule | undefined {
    return RSL_DIAGNOSTIC_RULES.find(
        rule => rule.phase === phase && rule.id === id
    );
}

export function rslDiagnosticRules(
    phase: RslDiagnosticPhase
): readonly IRslDiagnosticRule[] {
    return RSL_DIAGNOSTIC_RULES.filter(rule => rule.phase === phase);
}

/**
 * Лента кэша по единицам.
 *
 * Проверки, кэшируемые по единицам, делятся на две ленты: одни зависят только
 * от текста, другие ещё и от импортов. Ленты хранятся отдельно, поэтому
 * дочитанный импорт обнуляет вторую и не трогает первую.
 */
export type RslUnitCacheLane = "text" | "imports";

export function rslUnitCacheLane(rule: IRslDiagnosticRule): RslUnitCacheLane {
    return rule.depends.importClosure ? "imports" : "text";
}

/** Проверки одной ленты: по ним же считается её отпечаток настроек. */
export function rslUnitCacheLaneRules(
    lane: RslUnitCacheLane
): readonly IRslDiagnosticRule[] {
    return RSL_DIAGNOSTIC_RULES.filter(
        rule => rule.cache === "unit" && rslUnitCacheLane(rule) === lane
    );
}

/**
 * Отпечаток настроек ленты.
 *
 * В него входят настройки её проверок, общий выключатель и лимит Problems:
 * выключенная проверка не даёт находок, а не «те же находки, что и раньше».
 */
export function rslUnitCacheFingerprint(
    lane: RslUnitCacheLane,
    options: Record<string, unknown>
): string {
    const names = new Set<string>(["enabled", "maxProblems"]);

    for (const rule of rslUnitCacheLaneRules(lane)) {
        for (const name of rule.settings) {
            names.add(name);
        }
    }

    return [...names]
        .sort()
        .map(name => name + "=" + String(options[name]))
        .join("|");
}

/**
 * Замыкание подготовки.
 *
 * Частичный пересчёт запускает выбранные проверки и ровно ту подготовку,
 * которая им нужна, — а не всю таблицу и не выбранные проверки без подготовки.
 */
export function rslRequiredStageIds(
    phase: RslDiagnosticPhase,
    selected: Iterable<string>
): Set<string> {
    const result = new Set<string>();
    const queue = [...selected];

    while (queue.length > 0) {
        const id = queue.pop() as string;

        if (result.has(id)) {
            continue;
        }

        result.add(id);

        for (const required of rslDiagnosticRule(phase, id)?.requires || []) {
            queue.push(required);
        }
    }

    return result;
}
