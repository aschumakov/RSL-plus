import {
    type IRslWorkSlice
} from "../core/timeSlice";
import {
    IRslToken
} from "../lexer";
import {
    RslSymbol
} from "../symbols/rslSymbol";
import {
    Diagnostic
} from "vscode-languageserver";
import {
    walkScopes
} from "./diagnosticFactory";

/*
 * Исполнение плана: этапы, порции, бюджет.
 *
 * План — это список этапов; способ его исполнения один для обоих режимов,
 * синхронного и порционного. Иначе прерываемый расчёт проверял бы не то
 * же, что непрерываемый.
 */

/**
 * Этап расчёта диагностик.
 *
 * Этапы объявляются списком, а исполняются двумя разными способами: синхронно
 * (тесты, batch-клиенты) и порциями с возвратом в event loop (сервер). Список
 * при этом один — иначе прерываемый расчёт проверял бы не то же самое, что
 * непрерываемый.
 */
export interface IRslDiagnosticPlan {
    /**
     * Этапы получают признак отмены от драйвера.
     *
     * Большинству он не нужен: этап короткий и прерывается на своей границе. Но
     * проверка, обходящая весь поток токенов, обязана спрашивать сама — иначе
     * один этап становится неделимым куском в сотни миллисекунд.
     */
    stages: readonly IRslNamedDiagnosticStage[];
    /** Не пора ли остановиться: лимит Problems исчерпан. */
    hasCapacity(): boolean;
    /**
     * Итог расчёта; complete отвечает, дошли ли до конца.
     *
     * Отменённый расчёт и расчёт, упёршийся в лимит Problems, дают неполный
     * ответ: показать его можно, а запоминать нельзя. Признак передаёт
     * драйвер — только он знает, сам ли план дошёл до последнего этапа.
     */
    finish(complete: boolean): Diagnostic[];
}

/**
 * Этап с именем.
 *
 * Имя нужно не для порядка: без него замер длительности порций отвечал «самая
 * долгая — двадцать вторая», и приходилось пересчитывать этапы вручную, чтобы
 * понять, какую проверку смотреть.
 */
export interface IRslNamedDiagnosticStage {
    name: string;
    run: IRslDiagnosticStage;
}

/** Строка таблицы этапов: имя, признак включённости, работа. */
export type IRslDiagnosticStageEntry = [string, boolean, IRslDiagnosticStage];

/** Кому сообщать длительность порции: см. IRslNamedDiagnosticStage. */
export type RslDiagnosticStageObserver = (
    name: string,
    milliseconds: number
) => void;

/**
 * Этап расчёта; true в ответе означает «работа не окончена».
 *
 * Обходы, которые идут по всему файлу, на большом модуле занимают поток на
 * десятки миллисекунд подряд, а управление возвращается event loop только МЕЖДУ
 * этапами — значит такой обход целиком стоит в очереди перед запросом
 * пользователя. Возвращая true, этап отдаёт управление и продолжает с того же
 * места при следующем вызове.
 *
 * Когда прерваться, решает shouldYield — то есть время, а не число элементов.
 * Порция фиксированного размера ничего не гарантирует: «6000 токенов» на
 * загруженной машине выполняются сколько угодно долго, и именно это и
 * наблюдалось — отдельные порции по 19–36 мс.
 *
 * Способ один для обоих режимов: синхронный драйвер не даёт shouldYield вовсе,
 * и этап идёт до конца одним вызовом; порционный передаёт бюджет и делает паузу
 * между вызовами. Иначе прерываемый расчёт проверял бы не то же самое, что
 * непрерываемый.
 */
export type IRslDiagnosticStage = (
    isCancelled?: () => boolean,
    shouldYield?: () => boolean
) => void | boolean;

/*
 * Через сколько элементов сверяться с бюджетом.
 *
 * Date.now() на каждом токене заметен на горячем пути, а раз в 64 — нет: при
 * бюджете 8 мс это доли процента от порции, зато перерасход ограничен временем
 * обработки 64 элементов.
 */
export const BUDGET_CHECK_INTERVAL = 64;

/** Пора ли прерваться: бюджет проверяется не на каждом элементе. */
export function budgetExpired(
    processed: number,
    shouldYield: (() => boolean) | undefined,
    interval: number = BUDGET_CHECK_INTERVAL
): boolean {
    return shouldYield !== undefined &&
        processed % interval === 0 &&
        processed > 0 &&
        shouldYield();
}

/*
 * Шаг сверки бюджета по областям видимости.
 *
 * На область приходится либо поиск границ её сигнатуры, либо разбор её
 * объявлений — работа не на токен, а на область, поэтому шаг мелкий.
 */
export const SCOPE_CHECK_INTERVAL = 4;

/**
 * Возобновляемый обход областей видимости.
 *
 * Дерево символов обходится один раз, до первой паузы: сам обход дешёвый,
 * дорога работа на области. Дальше области перебираются по порядку, и между
 * ними расчёт волен вернуть управление редактору.
 */
export function createScopeScanStage(
    tree: RslSymbol,
    step: (scope: RslSymbol) => void,
    finish?: () => void
): IRslDiagnosticStage {
    let scopes: RslSymbol[] | undefined;
    let cursor = 0;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!scopes) {
            const list: RslSymbol[] = [];
            walkScopes(tree, scope => {
                list.push(scope);
            });
            scopes = list;
        }

        while (cursor < scopes.length) {
            if (budgetExpired(cursor, shouldYield, SCOPE_CHECK_INTERVAL)) {
                return true;
            }

            step(scopes[cursor]);
            cursor++;
        }

        finish?.();

        return false;
    };
}

/**
 * Возобновляемый обход токенов для проверок с обращением к резолверу.
 *
 * Такие проверки состоят из дешёвого отбора и дорогой части: разрешение имени
 * стоит от десятков микросекунд на знакомом имени до нескольких миллисекунд на
 * первом обращении в файле. Поэтому бюджет сверяется по-разному: на просмотре —
 * изредка, перед дорогой частью — каждый раз. Сама сверка стоит десятки
 * наносекунд, то есть рядом с разрешением имени она бесплатна.
 *
 * prepare выполняется один раз перед обходом и может отменить его целиком:
 * например, когда в файле нет ни одного local-объявления, проверять нечего.
 */
export function createResolverScanStage(
    items: () => readonly IRslToken[],
    isCandidate: (tokens: readonly IRslToken[], index: number) => boolean,
    inspect: (tokens: readonly IRslToken[], index: number) => void,
    prepare?: () => boolean,
    /* Вызывается один раз, когда обход дошёл до конца: см. createScanStage. */
    finish?: () => void
): IRslDiagnosticStage {
    let cursor = 0;
    let prepared = false;
    let skip = false;
    let finished = false;

    return (_isCancelled, shouldYield) => {
        /* Бюджет уже израсходован соседним этапом: см. createScanStage. */
        if (shouldYield?.() === true) {
            return true;
        }

        if (!prepared) {
            skip = prepare !== undefined && prepare() === false;
            prepared = true;
        }

        if (skip) {
            return false;
        }

        const tokens = items();
        let processed = 0;

        while (cursor < tokens.length) {
            const candidate = isCandidate(tokens, cursor);

            if (
                candidate
                    ? shouldYield?.() === true
                    : budgetExpired(processed, shouldYield)
            ) {
                return true;
            }

            if (candidate) {
                inspect(tokens, cursor);
            }

            cursor++;
            processed++;
        }

        if (!finished) {
            finished = true;
            finish?.();
        }

        return false;
    };
}

/**
 * Возобновляемый обход последовательности.
 *
 * Состояние проверки живёт в замыкании вызывающего и переживает паузы, поэтому
 * обход, разорванный на порции, видит ровно то же, что видел бы целиком: стек
 * скобок, предыдущий токен, текущая строка — всё продолжается с того же места.
 *
 * finish вызывается один раз после последнего элемента: там, где проверка
 * сообщает о незакрытом до конца файла — например о непарной скобке.
 */
export function createScanStage<T>(
    items: () => readonly T[],
    step: (item: T, index: number) => void,
    finish?: () => void
): IRslDiagnosticStage {
    let cursor = 0;
    let finished = false;

    return (_isCancelled, shouldYield) => {
        /*
         * Бюджет мог быть израсходован предыдущим этапом этой же порции. Начать
         * работу сейчас значит превысить бюджет на всю свою длительность,
         * поэтому этап отдаёт управление, ничего не сделав: драйвер сделает
         * паузу, и этап продолжит с того же места в следующей порции.
         */
        if (shouldYield?.() === true) {
            return true;
        }

        const list = items();
        let processed = 0;

        while (cursor < list.length) {
            if (budgetExpired(processed, shouldYield)) {
                return true;
            }

            step(list[cursor], cursor);
            cursor++;
            processed++;
        }

        if (!finished) {
            finished = true;
            finish?.();
        }

        return false;
    };
}

export function runDiagnosticPlan(
    plan: IRslDiagnosticPlan,
    isCancelled?: () => boolean
): Diagnostic[] {
    for (const stage of plan.stages) {
        let unfinished = true;

        while (unfinished) {
            if (!plan.hasCapacity() || isCancelled?.()) {
                return plan.finish(false);
            }
            /* Без паузы порции идут подряд: работа та же, что и одним куском. */
            unfinished = stage.run(isCancelled) === true;
        }
    }

    return plan.finish(true);
}

export async function runDiagnosticPlanChunked(
    plan: IRslDiagnosticPlan,
    isCancelled: (() => boolean) | undefined,
    slice: IRslWorkSlice,
    onStage?: RslDiagnosticStageObserver
): Promise<Diagnostic[]> {
    for (const stage of plan.stages) {
        let unfinished = true;

        while (unfinished) {
            /*
             * Проверка ПОСЛЕ паузы, а не только до неё: за время паузы могли
             * прийти и смена версии документа, и смена активной вкладки, и
             * отмена запроса.
             */
            await slice.yieldIfNeeded();

            if (!plan.hasCapacity() || isCancelled?.()) {
                return plan.finish(false);
            }

            const started = onStage ? performance.now() : 0;
            unfinished = stage.run(
                isCancelled,
                () => slice.shouldYield()
            ) === true;
            onStage?.(stage.name, performance.now() - started);
        }
    }

    return plan.finish(true);
}

export function enabledStages(
    stages: readonly IRslDiagnosticStageEntry[]
): readonly IRslNamedDiagnosticStage[] {
    return stages
        .filter(([, enabled]) => enabled)
        .map(([name, , run]) => ({ name, run }));
}

/** План выключенной фазы: этапов нет, результат пуст. */
export function emptyPlan(): IRslDiagnosticPlan {
    return {
        stages: [],
        hasCapacity: () => false,
        finish: () => []
    };
}
