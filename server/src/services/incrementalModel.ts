import {
    createRslSymbolUnitBuilder,
    extractDeclarationsFromSyntax,
    type IExternalLocationRange,
    type IRslDeclarationDescriptor,
    type IRslSymbolUnit
} from "../analysis/declarationExtractor";
import type { IRslLexResult } from "../lexer";
import type { IRslModuleModel } from "../moduleModel";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IRslParseResult, IRslSyntaxNode } from "../syntaxParser";
import {
    tryIncrementalRslParse,
    type IRslIncrementalParseDecision,
    type IRslParseSplice
} from "./incrementalParse";

/**
 * Модель открытого файла с переиспользованием прошлой версии.
 *
 * Разбор — не единственная дорогая фаза. На файле 651 КБ полный путь стоит:
 * разбор 37 мс, объявления из дерева 9 мс, дерево символов 17 мс. Точечный
 * разбор без точечной модели экономит меньше половины.
 *
 * Символы хранятся по единицам верхнего уровня. При правке заново считаются
 * изменённая единица и всё, что за ней: их смещения сдвинулись. То, что перед
 * правкой, берётся по ссылке — там та же версия текста и те же смещения.
 *
 * Сборка идёт порциями. Пользователь чувствует не сумму времени, а самый
 * длинный кусок, в который поток занят непрерывно: модель на 2600 процедур,
 * собранная одним куском, — это десятки миллисекунд, в которые редактор не
 * отвечает ни на подсказку, ни на переход. Поэтому сборка отдаёт управление
 * между единицами, а вызывающий между порциями проверяет, нужна ли ещё эта
 * версия документа.
 *
 * Объявления между правками не хранятся: они нужны только как заготовка для
 * символов, а держать их для открытого документа — лишние 3,5 МБ на 651 КБ.
 */

export interface IRslModelState {
    text: string;
    parse: IRslParseResult;
    /**
     * Символы по единицам верхнего уровня: индексы совпадают с root.children.
     *
     * undefined — объявления не разложились по единицам, и точечный путь для
     * этого файла недоступен.
     */
    unitSymbols?: IRslSymbolUnit[];
    /**
     * Позиции определений всех версий файла.
     *
     * WeakMap живёт вместе с состоянием: символы неизменившихся единиц уже в
     * нём, символы прошлых версий уходят вместе с самими символами. Пересборка
     * 13 000 записей на каждую правку стоила бы дороже самой правки.
     */
    definitionRanges: WeakMap<RslSymbol, IExternalLocationRange>;
    imports: string[];
}

export interface IRslModelUpdate {
    model: IRslModuleModel;
    state: IRslModelState;
    /** Что произошло: точечный путь или полный. */
    incremental: boolean;
}

/** Точечный разбор без сборки модели: первая половина работы. */
export interface IRslParsedUpdate {
    parse: IRslParseResult;
    splice: IRslParseSplice;
}

/**
 * Точечный разбор правки.
 *
 * Отдельно от сборки модели: между ними вызывающий возвращает управление
 * редактору и проверяет, нужна ли ещё эта версия. Слитые в один вызов, они
 * занимали поток непрерывно — а разбор большого файла и так самая долгая фаза.
 */
export function tryUpdateRslParse(
    state: IRslModelState,
    nextText: string,
    nextLex: IRslLexResult,
    onDecision?: (decision: IRslIncrementalParseDecision) => void
): IRslParsedUpdate | undefined {
    if (!state.unitSymbols) {
        return undefined;
    }

    const incremental = tryIncrementalRslParse(
        state.text,
        state.parse,
        nextText,
        nextLex,
        onDecision
    );

    if (!incremental) {
        return undefined;
    }

    if (
        incremental.parse.root.children.length !== state.unitSymbols.length
    ) {
        /* Число единиц точечный путь менять не должен; проверка дешёвая. */
        return undefined;
    }

    return incremental;
}

export interface IRslModelBuildOptions {
    text: string;
    parse: IRslParseResult;
    lex: IRslLexResult;
    /** Прошлое состояние: только для точечного пути. */
    previous?: IRslModelState;
    /** Что именно изменилось: только для точечного пути. */
    splice?: IRslParseSplice;
}

/**
 * Сборка модели порциями.
 *
 * step делает работу не дольше бюджета и отвечает, осталось ли ещё. result
 * отдаёт готовую модель — и только целиком: половина модели не годится ни
 * для навигации, ни для диагностик, поэтому наружу она не выходит.
 */
export interface IRslModelBuild {
    step(budgetMs: number): boolean;
    result(): IRslModelUpdate;
}

export function createRslModelBuild(
    options: IRslModelBuildOptions
): IRslModelBuild {
    const { text, parse, lex, previous, splice } = options;
    const units = parse.root.children;
    const incremental = !!(previous?.unitSymbols && splice);
    const definitionRanges = incremental
        ? previous!.definitionRanges
        : new WeakMap<RslSymbol, IExternalLocationRange>();
    const builder = createRslSymbolUnitBuilder(definitionRanges);
    const unitSymbols: IRslSymbolUnit[] = new Array(units.length);

    /*
     * Объявления берутся одним проходом: у полного пути по всему файлу, у
     * точечного — по изменённой единице и хвосту. Резать его порциями нечем,
     * зато он дешевле сборки символов втрое.
     */
    let buckets: IRslDeclarationDescriptor[][] | undefined;
    let imports: string[] = [];
    let cursor = 0;
    let prepared = false;
    let finished: IRslModelUpdate | undefined;

    const prepare = (): boolean => {
        if (incremental) {
            const changed = units.slice(splice!.unitIndex);
            const split = splitByUnit(
                changed,
                extractUnits(text, parse, changed)
            );

            if (!split) {
                return false;
            }

            buckets = split;
            imports = previous!.imports;

            return true;
        }

        const snapshot = extractDeclarationsFromSyntax(text, parse);
        const split = splitByUnit(units, snapshot.declarations);

        imports = snapshot.imports;
        buckets = split || [snapshot.declarations.slice()];

        return true;
    };

    const first = incremental ? splice!.unitIndex : 0;

    return {
        step(budgetMs: number): boolean {
            if (finished) {
                return false;
            }

            const started = process.hrtime.bigint();

            if (!prepared) {
                if (!prepare()) {
                    /*
                     * Раскладка не сложилась: точечный путь для этого файла
                     * недоступен. Модель собирается полным путём, иначе
                     * плоский список объявлений не собрать обратно тем же.
                     */
                    return fallback();
                }

                prepared = true;

                if (elapsed(started) >= budgetMs) {
                    return true;
                }
            }

            /* Единицы до правки: их символы уже есть, нужен только порядок. */
            while (cursor < first) {
                unitSymbols[cursor] = previous!.unitSymbols![cursor];
                builder.reuse(unitSymbols[cursor]);
                cursor++;

                if (elapsed(started) >= budgetMs) {
                    return true;
                }
            }

            while (cursor < units.length) {
                const bucket = buckets![cursor - first] || [];

                unitSymbols[cursor] = builder.build(bucket);
                cursor++;

                if (elapsed(started) >= budgetMs) {
                    return cursor < units.length;
                }
            }

            return false;
        },
        result(): IRslModelUpdate {
            if (finished) {
                return finished;
            }

            /* Незаконченную сборку доводим до конца: без бюджета. */
            while (this.step(Number.POSITIVE_INFINITY)) {
                /* Пустое тело: step сам двигает курсор. */
            }

            const built = builder.finish(text.length, unitSymbols);

            finished = {
                model: {
                    kind: "open",
                    source: text,
                    sourceLength: text.length,
                    symbolTree: built.root,
                    syntax: parse,
                    lex,
                    /* Import не менялся: точечный путь этого не допускает. */
                    imports,
                    definitionRanges: built.definitionRanges
                },
                state: {
                    text,
                    parse,
                    unitSymbols: buckets && buckets.length === units.length - first
                        ? unitSymbols
                        : undefined,
                    definitionRanges,
                    imports
                },
                incremental
            };

            return finished;
        }
    };

    /** Раскладка не сложилась: считаем всё заново полным путём. */
    function fallback(): boolean {
        const snapshot = extractDeclarationsFromSyntax(text, parse);

        imports = snapshot.imports;
        buckets = [snapshot.declarations.slice()];
        prepared = true;
        cursor = 0;

        return true;
    }
}

function elapsed(started: bigint): number {
    return Number(process.hrtime.bigint() - started) / 1e6;
}

/** Полный путь одним вызовом: для тестов и прямых вызовов. */
export function createRslModelState(
    text: string,
    parse: IRslParseResult
): IRslModelUpdate {
    return createRslModelBuild({
        text,
        parse,
        lex: parse.lex
    }).result();
}

/**
 * Точечное обновление модели одним вызовом.
 *
 * Порционный путь живёт в createRslModelBuild; здесь он же, но без паузы —
 * так вызывают тесты и сверки, которым порционность не нужна.
 */
export function tryUpdateRslModelState(
    state: IRslModelState,
    nextText: string,
    nextLex: IRslLexResult,
    onDecision?: (decision: IRslIncrementalParseDecision) => void
): IRslModelUpdate | undefined {
    const parsed = tryUpdateRslParse(state, nextText, nextLex, onDecision);

    if (!parsed) {
        return undefined;
    }

    return createRslModelBuild({
        text: nextText,
        parse: parsed.parse,
        lex: nextLex,
        previous: state,
        splice: parsed.splice
    }).result();
}

/**
 * Раскладка готовых объявлений по единицам верхнего уровня.
 *
 * Раскладка строгая: каждое объявление обязано лежать внутри своей единицы.
 * Не сложилось — точечный путь отключается, потому что собрать плоский список
 * обратно тем же уже нельзя.
 */
function splitByUnit(
    units: readonly IRslSyntaxNode[],
    declarations: readonly IRslDeclarationDescriptor[]
): IRslDeclarationDescriptor[][] | undefined {
    const result: IRslDeclarationDescriptor[][] = units.map(() => []);
    let unitIndex = 0;

    for (const descriptor of declarations) {
        while (
            unitIndex < units.length &&
            descriptor.start >= units[unitIndex].end
        ) {
            unitIndex++;
        }

        if (
            unitIndex >= units.length ||
            descriptor.start < units[unitIndex].start
        ) {
            return undefined;
        }

        result[unitIndex].push(descriptor);
    }

    return result;
}

/**
 * Объявления перечисленных единиц одним проходом.
 *
 * Разбор не копируется целиком: чтение поля tokens заставило бы отобрать
 * значащие токены всего файла (10 мс на 651 КБ), а извлечению нужны только
 * дерево и полный поток из lex.
 */
function extractUnits(
    text: string,
    parse: IRslParseResult,
    units: readonly IRslSyntaxNode[]
): IRslDeclarationDescriptor[] {
    const snapshot = extractDeclarationsFromSyntax(text, {
        root: { ...parse.root, children: units as IRslSyntaxNode[] },
        lex: parse.lex,
        diagnostics: [],
        tokens: []
    });

    return snapshot.declarations;
}
