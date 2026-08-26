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
    type IRslIncrementalParseDecision
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

/** Полный путь: модель и состояние для будущих правок. */
export function createRslModelState(
    text: string,
    parse: IRslParseResult
): IRslModelUpdate {
    const snapshot = extractDeclarationsFromSyntax(text, parse);
    const units = splitByUnit(parse.root.children, snapshot.declarations);
    const definitionRanges = new WeakMap<RslSymbol, IExternalLocationRange>();
    const builder = createRslSymbolUnitBuilder(definitionRanges);
    const unitSymbols = (units || [snapshot.declarations.slice()])
        .map(unit => builder.build(unit));
    const built = builder.finish(text.length, unitSymbols);

    return {
        model: {
            kind: "open",
            source: text,
            sourceLength: text.length,
            symbolTree: built.root,
            syntax: parse,
            lex: parse.lex,
            imports: snapshot.imports,
            definitionRanges: built.definitionRanges
        },
        state: {
            text,
            parse,
            unitSymbols: units ? unitSymbols : undefined,
            definitionRanges,
            imports: snapshot.imports
        },
        incremental: false
    };
}

/**
 * Точечное обновление модели.
 *
 * Возвращает undefined, когда точечный путь неприменим: вызывающий делает
 * полный разбор и строит состояние заново.
 */
export function tryUpdateRslModelState(
    state: IRslModelState,
    nextText: string,
    nextLex: IRslLexResult,
    onDecision?: (decision: IRslIncrementalParseDecision) => void
): IRslModelUpdate | undefined {
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

    const { parse, splice } = incremental;
    const units = parse.root.children;

    if (units.length !== state.unitSymbols.length) {
        /* Число единиц точечный путь менять не должен; проверка дешёвая. */
        return undefined;
    }

    const changed = units.slice(splice.unitIndex);
    const buckets = splitByUnit(
        changed,
        extractUnits(nextText, parse, changed)
    );

    if (!buckets) {
        return undefined;
    }

    const builder = createRslSymbolUnitBuilder(state.definitionRanges);
    const unitSymbols: IRslSymbolUnit[] = new Array(units.length);

    for (let index = 0; index < splice.unitIndex; index++) {
        unitSymbols[index] = state.unitSymbols[index];
        builder.reuse(unitSymbols[index]);
    }

    for (let index = 0; index < buckets.length; index++) {
        unitSymbols[splice.unitIndex + index] = builder.build(buckets[index]);
    }

    const built = builder.finish(nextText.length, unitSymbols);

    return {
        model: {
            kind: "open",
            source: nextText,
            sourceLength: nextText.length,
            symbolTree: built.root,
            syntax: parse,
            lex: nextLex,
            /* Import не менялся: точечный путь этого не допускает. */
            imports: state.imports,
            definitionRanges: built.definitionRanges
        },
        state: {
            text: nextText,
            parse,
            unitSymbols,
            definitionRanges: state.definitionRanges,
            imports: state.imports
        },
        incremental: true
    };
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
