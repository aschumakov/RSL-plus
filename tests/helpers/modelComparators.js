"use strict";

/**
 * Компараторы модели документа: AST, symbol tree и диагностика.
 *
 * Каждый возвращает описание ПЕРВОГО расхождения с путём до него, либо
 * undefined. Путь важнее самого факта: «children[3].children[1].start»
 * находится глазами, «деревья не равны» — нет.
 *
 * Общий модуль, потому что этим сравнением пользуются и тест на серии
 * искусственных правок, и прогон по реальному репозиторию макросов. Две копии
 * такой логики разошлись бы, и одна из проверок начала бы врать.
 */

/** Поля узла AST, которые обязаны совпадать. */
const NODE_FIELDS = [
    "kind", "start", "end", "name", "modifier", "typeName", "elementTypeName",
    "baseClassName", "variableRole", "parameterListStart", "parameterListEnd",
    "valueStart", "valueEnd", "operator", "objectName", "dictionaryName",
    "missingSemicolon"
];

const SYMBOL_FIELDS = [
    "name", "kind", "visibility", "typeName", "isTypeVariant", "value",
    "parameterText", "baseClassName"
];

function compareSyntaxNodes(left, right, path = "root") {
    if (!left || !right) {
        return left === right ? undefined : `${path}: один из узлов отсутствует`;
    }

    for (const field of NODE_FIELDS) {
        if (left[field] !== right[field]) {
            return `${path}.${field}: ` +
                `${JSON.stringify(left[field])} против ` +
                `${JSON.stringify(right[field])}`;
        }
    }

    /* Токены узла сравниваются по составу: на них держатся все позиции. */
    if (left.tokens.length !== right.tokens.length) {
        return `${path}.tokens: ${left.tokens.length} против ` +
            `${right.tokens.length}`;
    }

    for (let index = 0; index < left.tokens.length; index++) {
        const a = left.tokens[index];
        const b = right.tokens[index];

        if (a.start !== b.start || a.end !== b.end || a.raw !== b.raw) {
            return `${path}.tokens[${index}]: ` +
                `${JSON.stringify(a.raw)}@${a.start} против ` +
                `${JSON.stringify(b.raw)}@${b.start}`;
        }
    }

    if (left.children.length !== right.children.length) {
        return `${path}.children: ${left.children.length} против ` +
            `${right.children.length}`;
    }

    for (let index = 0; index < left.children.length; index++) {
        const difference = compareSyntaxNodes(
            left.children[index],
            right.children[index],
            `${path}.children[${index}]`
        );

        if (difference) {
            return difference;
        }
    }

    return undefined;
}

function compareSymbols(left, right, path = "symbolTree") {
    for (const field of SYMBOL_FIELDS) {
        if (left[field] !== right[field]) {
            return `${path}.${field}: ` +
                `${JSON.stringify(left[field])} против ` +
                `${JSON.stringify(right[field])}`;
        }
    }

    for (const field of ["range", "selectionRange"]) {
        if (
            left[field].start !== right[field].start ||
            left[field].end !== right[field].end
        ) {
            return `${path}.${field}: ` +
                `${left[field].start}..${left[field].end} против ` +
                `${right[field].start}..${right[field].end}`;
        }
    }

    if (left.children.length !== right.children.length) {
        return `${path}.children: ${left.children.length} против ` +
            `${right.children.length}`;
    }

    for (let index = 0; index < left.children.length; index++) {
        const difference = compareSymbols(
            left.children[index],
            right.children[index],
            `${path}.${left.children[index].name || index}`
        );

        if (difference) {
            return difference;
        }
    }

    return undefined;
}

function describeDiagnostic(item) {
    return [
        item.code,
        item.severity,
        item.range.start.line,
        item.range.start.character,
        item.range.end.line,
        item.range.end.character,
        item.message
    ].join("|");
}

function compareDiagnostics(left, right) {
    const a = left.map(describeDiagnostic).sort();
    const b = right.map(describeDiagnostic).sort();

    if (a.length !== b.length) {
        const missing = a.filter(item => !b.includes(item));
        const extra = b.filter(item => !a.includes(item));
        return `диагностик ${a.length} против ${b.length}; ` +
            `лишние: ${extra.slice(0, 2).join(" / ") || "нет"}; ` +
            `пропали: ${missing.slice(0, 2).join(" / ") || "нет"}`;
    }

    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {
            return `диагностика ${index}: ${a[index]} против ${b[index]}`;
        }
    }

    return undefined;
}

/** Зеркало символа из простых объектов: RslSymbol неизменяем. */
function mirrorSymbol(symbol) {
    return {
        ...Object.fromEntries(
            SYMBOL_FIELDS.map(field => [field, symbol[field]])
        ),
        range: { ...symbol.range },
        selectionRange: { ...symbol.selectionRange },
        children: symbol.children.map(mirrorSymbol)
    };
}

module.exports = {
    NODE_FIELDS,
    SYMBOL_FIELDS,
    compareSyntaxNodes,
    compareSymbols,
    compareDiagnostics,
    mirrorSymbol
};
