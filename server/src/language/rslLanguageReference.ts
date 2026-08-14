/**
 * Единый справочник языка RSL.
 *
 * Ключевые слова, типы, модификаторы, границы блоков, системные константы и
 * устаревшие конструкции описаны здесь один раз. Раньше эти списки были
 * продублированы в lexer-обвязке, parser, formatter, folding, diagnostics,
 * Semantic Tokens, Completion и в TextMate-грамматике — восемь копий, которые
 * расходились по составу. Например `public` числился ключевым словом и
 * модификатором в четырёх местах, отсутствовал в parser и в грамматике, из-за
 * чего открытая и compact-модель по-разному разбирали один и тот же файл.
 *
 * Модуль намеренно не зависит ни от чего, кроме нормализации идентификатора:
 * его импортируют и сервер, и build-скрипт генерации грамматики.
 */
import { normalizeIdentifier } from "../lexer";

/*
 * ─── Модификаторы объявлений ────────────────────────────────────────────────
 *
 * PUBLIC модификатором НЕ является: компилятор RSL во всех проверенных случаях
 * отвечает «неопределенный идентификатор Public». Публичная видимость — это
 * отсутствие LOCAL и PRIVATE, а не отдельное слово.
 */
export const DECLARATION_MODIFIERS: readonly string[] = Object.freeze([
    "local",
    "private"
]);

/** Слова, которые начинают объявление (после необязательного модификатора). */
export const DECLARATION_KEYWORDS: readonly string[] = Object.freeze([
    "macro",
    "class",
    "var",
    "const",
    "file",
    "record",
    "array"
]);

/** Слова, открывающие блок, который закрывается END. */
export const BLOCK_START_KEYWORDS: readonly string[] = Object.freeze([
    "class",
    "macro",
    "if",
    "for",
    "while",
    "with"
]);

/** Ветви внутри уже открытого блока. */
export const BRANCH_KEYWORDS: readonly string[] = Object.freeze([
    "else",
    "elif",
    "onerror"
]);

export const END_KEYWORD = "end";

/** END и все ветви: на них останавливается разбор тела блока. */
export const BLOCK_BOUNDARY_KEYWORDS: readonly string[] = Object.freeze([
    END_KEYWORD,
    ...BRANCH_KEYWORDS
]);

/** Слова-операторы; идентификаторами они быть не могут. */
export const WORD_OPERATORS: readonly string[] = Object.freeze([
    "and",
    "or",
    "not"
]);

/** Слова, с которых может начинаться оператор. */
export const STATEMENT_KEYWORDS: readonly string[] = Object.freeze([
    "import",
    ...DECLARATION_KEYWORDS,
    "if",
    "while",
    "for",
    "with",
    "return",
    "break",
    "continue",
    "onerror",
    ...DECLARATION_MODIFIERS
]);

/** Спецификаторы режима в объявлении FILE и RECORD. */
export const FILE_RECORD_SPECIFIERS: readonly string[] = Object.freeze([
    "normal",
    "sort",
    "key",
    "write",
    "append",
    "mem",
    "txt",
    "dbf",
    "dialog",
    "blob",
    "btr"
]);

/** Литералы языка. */
export const LITERAL_KEYWORDS: readonly string[] = Object.freeze([
    "true",
    "false",
    "null"
]);

/**
 * Слова, которые нельзя использовать как имя объявления.
 *
 * Отдельно от KEYWORDS: CPDOS и CPWIN задают кодовую страницу строкового
 * литерала и в позиции имени не встречаются, поэтому запрещать их как имя
 * значило бы выдавать ошибку там, где компилятор её не выдаёт.
 */
export const RESERVED_WORDS: readonly string[] = Object.freeze(
    dedupe([
        ...STATEMENT_KEYWORDS,
        ...BLOCK_BOUNDARY_KEYWORDS,
        ...WORD_OPERATORS,
        ...LITERAL_KEYWORDS,
        "this"
    ])
);

/**
 * Полный список ключевых слов языка.
 *
 * Порядок здесь не важен, важна полнота: список используется и как «это не имя
 * пользователя», и как источник подсветки.
 */
export const KEYWORDS: readonly string[] = Object.freeze(
    dedupe([...RESERVED_WORDS, "cpdos", "cpwin"])
);

/*
 * ─── Типы ───────────────────────────────────────────────────────────────────
 */

/** Описание скалярного типа из таблицы руководства. */
export interface IRslScalarType {
    /** Ключевое слово для декларации. */
    keyword: string;
    /** Константа кода типа; пусто, если её не существует. */
    typeCode: string;
    /** Название типа так, как его называет руководство. */
    title: string;
}

/**
 * Скалярные типы данных — по таблице руководства, а не по догадке.
 *
 * Руководство делит все типы на скалярные и объектные, и члены есть только у
 * объектных: со скалярным значением работают процедуры (`StrLen (s)`, а не
 * `s.Len`). Поэтому этот же список отвечает на вопрос «может ли у переменной
 * такого типа быть член».
 *
 * V_UNDEF в таблице есть, но ключевого слова для декларации у него нет
 * («-----»), поэтому объявить переменную этого типа нельзя и в списке его нет.
 */
export const SCALAR_TYPES: readonly IRslScalarType[] = Object.freeze([
    { keyword: "Integer", typeCode: "V_INTEGER", title: "Целое число" },
    {
        keyword: "Double",
        typeCode: "V_DOUBLE",
        title: "Число с плавающей точкой"
    },
    {
        keyword: "DoubleL",
        typeCode: "V_DOUBLEL",
        title: "Число с плавающей точкой длинное"
    },
    { keyword: "String", typeCode: "V_STRING", title: "Строка символов" },
    { keyword: "Bool", typeCode: "V_BOOL", title: "Логическая величина" },
    { keyword: "Date", typeCode: "V_DATE", title: "Дата" },
    { keyword: "Time", typeCode: "V_TIME", title: "Время" },
    { keyword: "DateTime", typeCode: "V_DTTM", title: "Дата и время" },
    { keyword: "MemAddr", typeCode: "V_MEMADDR", title: "Адрес памяти" },
    {
        keyword: "ProcRef",
        typeCode: "V_PROC",
        title: "Ссылка на процедуру RSL"
    },
    {
        keyword: "MethodRef",
        typeCode: "V_R2M",
        title: "Ссылка на метод объекта RSL"
    },
    {
        keyword: "Decimal",
        typeCode: "V_DECIMAL",
        title: "Двоично-десятичное число с 4-мя знаками после запятой"
    },
    {
        keyword: "Numeric",
        typeCode: "V_NUMERIC",
        title: "Двоично-десятичное число с плавающей точкой"
    },
    {
        keyword: "Money",
        typeCode: "V_MONEY",
        title: "Тип для денежных величин"
    },
    {
        keyword: "MoneyL",
        typeCode: "V_MONEYL",
        title: "Длинный тип для денежных величин"
    },
    {
        keyword: "SpecVal",
        typeCode: "",
        title: "Специальное значение «Нулевое» или «Умалчиваемое»"
    }
]);

/**
 * Синонимы типов из подраздела «Особенности реализации типов».
 *
 * Оставлены только для совместимости исходного кода: DoubleL — синоним Double,
 * MoneyL — Money, Decimal — Numeric, а внутреннее представление Money — Numeric.
 */
export const TYPE_SYNONYMS: ReadonlyMap<string, string> =
    Object.freeze(new Map<string, string>([
        ["doublel", "double"],
        ["moneyl", "money"],
        ["decimal", "numeric"],
        ["money", "numeric"]
    ]));

/**
 * Типы, которые можно написать в позиции типа.
 *
 * Скалярные — по таблице руководства (см. SCALAR_TYPES), плюс два, которые
 * скалярными не являются: VARIANT — «значение любого типа», OBJECT — ссылка на
 * обобщённый объект любого RSL-класса.
 *
 * R2M здесь нет: руководство знает только процедуру `R2M (объект, "Метод")`, а
 * тип называется MethodRef — код типа у него как раз V_R2M. Устаревших
 * ссылочных типов (BtFileRef и прочих) тоже нет: они существуют, но предлагать
 * их в подсказке значит советовать то, о чём диагностика тут же предупредит.
 */
export const PRIMITIVE_TYPES: readonly string[] = Object.freeze([
    "variant",
    "object",
    ...SCALAR_TYPES.map(item => item.keyword.toLowerCase())
]);

/**
 * Написание типа для показа пользователю.
 *
 * Хранится тип в нижнем регистре, чтобы `Var x: INTEGER` и `Var y: integer` не
 * выглядели разными. Написание берётся из таблицы руководства, а не заводится
 * вторым списком: расходиться им незачем.
 */
export const PRIMITIVE_TYPE_DISPLAY_NAMES: ReadonlyMap<string, string> =
    Object.freeze(new Map<string, string>([
        ["variant", "Variant"],
        ["object", "Object"],
        ...SCALAR_TYPES.map(item =>
            [item.keyword.toLowerCase(), item.keyword] as [string, string]
        )
    ]));

/*
 * ─── Системные константы ────────────────────────────────────────────────────
 */

/** Коды типа значения: результат VALTYPE. */
export const VALUE_TYPE_CONSTANTS: readonly string[] = Object.freeze([
    "V_UNDEF",
    "V_INTEGER",
    "V_MONEY",
    "V_MONEYL",
    "V_NUMERIC",
    "V_DECIMAL",
    "V_DOUBLE",
    "V_DOUBLEL",
    "V_STRING",
    "V_BOOL",
    "V_DATE",
    "V_TIME",
    "V_DTTM",
    "V_FILE",
    "V_STRUC",
    "V_ARRAY",
    "V_TXTFILE",
    "V_DBFFILE",
    "V_PROC",
    "V_R2M",
    "V_MEMADDR",
    "V_GENOBJ"
]);

/**
 * Имена, которые нельзя объявить: литералы, VALTYPE и коды типа значения.
 *
 * Отдельно от KEYWORDS: `valtype` — обычная встроенная процедура с точки
 * зрения вызова, но объявить переменную с таким именем нельзя.
 */
export const SYSTEM_CONSTANTS: readonly string[] = Object.freeze(
    dedupe([
        ...LITERAL_KEYWORDS,
        "undefined",
        "valtype",
        ...VALUE_TYPE_CONSTANTS
    ])
);

/*
 * ─── Устаревшие конструкции ─────────────────────────────────────────────────
 *
 * RECORD руководством устаревшим НЕ объявлен — только ARRAY, FILE и
 * специализированные ссылочные типы.
 */
export const DEPRECATED_CONSTRUCTS: ReadonlyMap<string, string> =
    Object.freeze(new Map<string, string>([
        [
            "array",
            "Определение ARRAY устарело, от него желательно избавляться по " +
                "возможности"
        ],
        [
            "file",
            "Объект типа FILE — устаревшая конструкция; " +
                "рекомендуется использовать конструкцию Tbfile"
        ],
        [
            "btfileref",
            "BtFileRef — устаревший специализированный тип; " +
                "рекомендуется использовать обобщённый объект (TBfile)"
        ],
        [
            "strucref",
            "StrucRef — устаревший специализированный тип; " +
                "рекомендуется использовать обобщённый объект (TRecHandler)"
        ],
        [
            "arrayref",
            "ArrayRef — устаревший специализированный тип; " +
                "рекомендуется использовать обобщённый объект (TArray)"
        ],
        [
            "txtfileref",
            "TxtFileRef — устаревший специализированный тип; " +
                "рекомендуется использовать обобщённый объект"
        ],
        [
            "dbffileref",
            "DbfFileRef — устаревший специализированный тип; " +
                "рекомендуется использовать обобщённый объект"
        ]
    ]));

/**
 * Идентификаторы, которые не являются ссылкой на символ.
 *
 * Semantic Tokens пропускает их до разрешения имён: разрешать `end` или `sort`
 * бессмысленно, а стоит это столько же, сколько разрешение настоящего имени.
 */
export const NON_SYMBOL_IDENTIFIERS: readonly string[] = Object.freeze(
    dedupe([...KEYWORDS, ...FILE_RECORD_SPECIFIERS])
);

/*
 * ─── Предикаты ──────────────────────────────────────────────────────────────
 *
 * Set-ы строятся один раз: предикаты вызываются на каждый токен горячего пути.
 */
const KEYWORD_SET = toSet(KEYWORDS);
const RESERVED_WORD_SET = toSet(RESERVED_WORDS);
const PRIMITIVE_TYPE_SET = toSet(PRIMITIVE_TYPES);
const SCALAR_TYPE_SET = toSet(SCALAR_TYPES.map(item => item.keyword));
const MODIFIER_SET = toSet(DECLARATION_MODIFIERS);
const DECLARATION_KEYWORD_SET = toSet(DECLARATION_KEYWORDS);
const STATEMENT_KEYWORD_SET = toSet(STATEMENT_KEYWORDS);
const BLOCK_START_SET = toSet(BLOCK_START_KEYWORDS);
const BLOCK_BOUNDARY_SET = toSet(BLOCK_BOUNDARY_KEYWORDS);
const BRANCH_SET = toSet(BRANCH_KEYWORDS);
const WORD_OPERATOR_SET = toSet(WORD_OPERATORS);
const FILE_RECORD_SPECIFIER_SET = toSet(FILE_RECORD_SPECIFIERS);
const SYSTEM_CONSTANT_SET = toSet(SYSTEM_CONSTANTS);
const NON_SYMBOL_IDENTIFIER_SET = toSet(NON_SYMBOL_IDENTIFIERS);

export function isRslKeyword(value: string): boolean {
    return KEYWORD_SET.has(normalizeIdentifier(value));
}

/** Нельзя ли использовать это слово как имя объявления. */
export function isReservedWord(value: string): boolean {
    return RESERVED_WORD_SET.has(normalizeIdentifier(value));
}

export function isRslType(value: string): boolean {
    return PRIMITIVE_TYPE_SET.has(stripReferenceMark(value));
}

/** Значение такого типа членов не имеет: см. SCALAR_TYPES. */
export function isScalarRslType(value: string): boolean {
    return SCALAR_TYPE_SET.has(stripReferenceMark(value));
}

export function isDeclarationModifier(value: string): boolean {
    return MODIFIER_SET.has(normalizeIdentifier(value));
}

export function isDeclarationKeyword(value: string): boolean {
    return DECLARATION_KEYWORD_SET.has(normalizeIdentifier(value));
}

export function isStatementKeyword(value: string): boolean {
    return STATEMENT_KEYWORD_SET.has(normalizeIdentifier(value));
}

export function isBlockStartKeyword(value: string): boolean {
    return BLOCK_START_SET.has(normalizeIdentifier(value));
}

export function isBlockBoundaryKeyword(value: string): boolean {
    return BLOCK_BOUNDARY_SET.has(normalizeIdentifier(value));
}

export function isBranchKeyword(value: string): boolean {
    return BRANCH_SET.has(normalizeIdentifier(value));
}

export function isWordOperator(value: string): boolean {
    return WORD_OPERATOR_SET.has(normalizeIdentifier(value));
}

export function isFileRecordSpecifier(value: string): boolean {
    return FILE_RECORD_SPECIFIER_SET.has(normalizeIdentifier(value));
}

export function isRslSystemConstant(value: string): boolean {
    return SYSTEM_CONSTANT_SET.has(normalizeIdentifier(value));
}

export function isNonSymbolIdentifier(value: string): boolean {
    return NON_SYMBOL_IDENTIFIER_SET.has(normalizeIdentifier(value));
}

export function deprecatedConstructMessage(
    value: string
): string | undefined {
    return DEPRECATED_CONSTRUCTS.get(normalizeIdentifier(value));
}

/**
 * Канонический вид объявленного типа.
 *
 * Примитив приводится к нижнему регистру — так он хранится в RslSymbol и
 * сравнивается в выводе типов. Имя класса остаётся как написано: регистр в нём
 * содержателен для пользователя.
 */
export function canonicalTypeName(value: string): string {
    const normalized = stripReferenceMark(value);
    return PRIMITIVE_TYPE_SET.has(normalized)
        ? normalized
        : (value || "").replace(/^@/, "");
}

/**
 * Тип числовой константы по её записи.
 *
 * Руководство, раздел «Типы данных»:
 *
 *   Целочисленные константы типа Integer … задаются следующим образом: 2345,
 *   1236 и т.п. Числа с плавающей точкой имеют тип Double … При их записи
 *   используются точка и латинская буква «e», например: 4356.234, 345., .1234,
 *   1231.2341e-23. При записи денежных сумм в начале ставят знак доллара «$».
 *   Эти константы имеют тип Money … Например: $146, $765.23, -$12.34. Для
 *   записи шестнадцатеричных констант используется знак «#». Например, #F2.
 *
 * Тип шестнадцатеричной константы руководство прямо не называет, но числовых
 * типов в языке всего три, и ни Double, ни Money записью через «#» не
 * задаются.
 *
 * Пустая строка — это не число: `$` без единой цифры недействителен, и
 * называть его тип значило бы приписать типу недействительную константу
 * (см. invalid-money-constant).
 */
export function numericLiteralType(raw: string): string {
    const text = (raw || "").trim();

    if (!text) {
        return "";
    }

    if (text.startsWith("$")) {
        return /[0-9]/.test(text) ? "money" : "";
    }

    if (text.startsWith("#")) {
        return /[0-9a-f]/i.test(text.slice(1)) ? "integer" : "";
    }

    if (!/[0-9]/.test(text)) {
        return "";
    }

    /* Точка или экспонента — признак Double: «4356.234, 345., .1234». */
    return /[.]|[0-9]e[+-]?[0-9]/i.test(text) ? "double" : "integer";
}

/** Написание примитивного типа для показа пользователю. */
export function displayTypeName(value: string): string {
    const normalized = stripReferenceMark(value);
    return PRIMITIVE_TYPE_DISPLAY_NAMES.get(normalized) ||
        (value || "").replace(/^@/, "");
}

function stripReferenceMark(value: string): string {
    return normalizeIdentifier(value).replace(/^@/, "");
}

function toSet(values: readonly string[]): ReadonlySet<string> {
    return new Set(values.map(value => normalizeIdentifier(value)));
}

function dedupe(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const value of values) {
        const key = normalizeIdentifier(value);

        if (!seen.has(key)) {
            seen.add(key);
            result.push(value);
        }
    }

    return result;
}
