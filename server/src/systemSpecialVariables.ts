import { normalizeIdentifier } from "./lexer";

export type RslSystemSpecialVariableType =
    | "String"
    | "Integer"
    | "Bool"
    | "Date"
    /* Тип известен не всегда: globals.mac объявляет имена без типов. */
    | "Variant";

export interface IRslSystemSpecialVariable {
    name: string;
    type: RslSystemSpecialVariableType;
    description: string;
}

/**
 * Общесистемные спецпеременные RS-Bank: из справки и из globals.mac поставки.
 *
 * Фигурные скобки входят в синтаксис ссылки, но не в имя, которое хранится
 * здесь. Список также используется для completion и семантической проверки.
 */
export const RSL_SYSTEM_SPECIAL_VARIABLES:
IRslSystemSpecialVariable[] = [
    {
        name: "BranchCurDate",
        type: "String",
        description: "Дата операционного дня, открытого последним в филиале работающего пользователя."
    },
    {
        name: "BPromUse",
        type: "Bool",
        description: "Признак работы ИБС RS-Bank в режиме промышленной эксплуатации."
    },
    {
        name: "CCYNatCur",
        type: "String",
        description: "Буквенный ISO-код национальной валюты."
    },
    {
        name: "CORAC_Bank",
        type: "String",
        description: "Корсчёт банка в расчётном центре."
    },
    {
        name: "cRealTypePerson",
        type: "String",
        description: "Наименование актуального уровня доступа текущего пользователя."
    },
    {
        name: "cTypePerson",
        type: "String",
        description: "Код уровня доступа текущего пользователя."
    },
    {
        name: "curdate",
        type: "Date",
        description: "Дата текущего операционного дня."
    },
    {
        name: "FIO_Book",
        type: "String",
        description: "ФИО главного бухгалтера."
    },
    {
        name: "FIO_Boss",
        type: "String",
        description: "ФИО управляющего."
    },
    {
        name: "GroupOperF",
        type: "String",
        description: "Нижняя граница диапазона номеров подчинённых пользователей."
    },
    {
        name: "GroupOperL",
        type: "String",
        description: "Верхняя граница диапазона номеров подчинённых пользователей."
    },
    {
        name: "INN_Bank",
        type: "String",
        description: "ИНН банка."
    },
    {
        name: "ISONatCur",
        type: "String",
        description: "Цифровой ISO-код национальной валюты."
    },
    {
        name: "Legal_Addr",
        type: "String",
        description: "Юридический адрес банка."
    },
    {
        name: "MFO_Bank",
        type: "String",
        description: "БИК банка."
    },
    {
        name: "MFO_RCC",
        type: "String",
        description: "БИК расчётного центра."
    },
    {
        name: "Name_Bank",
        type: "String",
        description: "Название банка."
    },
    {
        name: "Name_Book",
        type: "String",
        description: "Должность главного бухгалтера."
    },
    {
        name: "Name_Boss",
        type: "String",
        description: "Должность управляющего."
    },
    {
        name: "NumDprt",
        type: "Integer",
        description: "Номер головного отделения банка."
    },
    {
        name: "oper",
        type: "Integer",
        description: "Номер исполнителя, с которым пользователь зарегистрировался в системе."
    },
    {
        name: "OperDprt",
        type: "Integer",
        description: "Идентификатор филиала текущего пользователя."
    },
    {
        name: "OperDprtNode",
        type: "String",
        description: "Идентификатор подразделения текущего пользователя."
    },
    {
        name: "OurBank",
        type: "Integer",
        description: "Идентификатор связанного субъекта филиала текущего пользователя."
    },
    {
        name: "Post_Addr",
        type: "String",
        description: "Почтовый адрес банка."
    },
    {
        name: "Real_Addr",
        type: "String",
        description: "Фактический адрес банка."
    },
    {
        name: "ResidentCountryCode",
        type: "String",
        description: "Трёхбуквенный код страны резидентности."
    },
    {
        name: "Version",
        type: "String",
        description: "Номер версии системы."
    },
    /*
     * Дальше — те, что объявлены в globals.mac поставки RS-Bank, но в справку
     * не попали. Тип и смысл там не указаны: файл только объявляет имена, —
     * поэтому тип Variant, а описание говорит ровно то, что известно. В коде
     * их пишут наравне с описанными: `p.Name_Oper = {Name_Oper};` стоит рядом
     * с `p.curdate = {curdate};`.
     */
    {
        name: "Name_Oper",
        type: "Variant",
        description: "Объявлена в globals.mac; в справке не описана."
    },
    {
        name: "ResidentCountryCodeNum",
        type: "Variant",
        description: "Объявлена в globals.mac; в справке не описана."
    },
    {
        name: "HeadBankID",
        type: "Variant",
        description: "Объявлена в globals.mac; в справке не описана."
    },
    {
        name: "DprtCurDate",
        type: "Variant",
        description: "Объявлена в globals.mac; в справке не описана."
    },
    {
        name: "OperCloseDateRestrict",
        type: "Variant",
        description: "Объявлена в globals.mac; в справке не описана."
    },
    {
        name: "WebSessionID",
        type: "Variant",
        description: "Объявлена в globals.mac; в справке не описана."
    }
];

const RSL_SYSTEM_SPECIAL_VARIABLE_NAMES = new Set(
    RSL_SYSTEM_SPECIAL_VARIABLES.map(variable =>
        normalizeIdentifier(variable.name)
    )
);

/**
 * Спецпеременные, которые справка показывает только в примерах.
 *
 * Описания и типа у них нет: {CNum} стоит в примере обращения к другому
 * макросу, {SelfID} — в примерах PTInter. Придумывать им смысл нельзя, но и
 * считать неизвестными неправильно: справка их всё-таки называет.
 */
export const RSL_SPECIAL_VARIABLES_FROM_EXAMPLES: readonly string[] = [
    "CNum",
    "SelfID"
];

const EXAMPLE_NAMES = new Set(
    RSL_SPECIAL_VARIABLES_FROM_EXAMPLES.map(name => name.toLowerCase())
);

/** Имя из примеров справки; скобки в имени не обязательны. */
export function isRslSpecialVariableFromExamples(name: string): boolean {
    const text = String(name || "").trim();
    const bare = text.startsWith("{") && text.endsWith("}")
        ? text.slice(1, -1)
        : text;

    return EXAMPLE_NAMES.has(bare.toLowerCase());
}

/**
 * Ссылка на спецпеременную: любая последовательность символов в фигурных
 * скобках.
 *
 * Сводка синтаксиса RSL определяет SPNAME именно так, поэтому именами
 * являются и {curdate}, и {Филиал}, и {Название отчета}. Знать их все
 * невозможно: часть приходит из общесистемного globals.mac, часть — из
 * прикладного модуля, часть заводит сам банк, а объявлять их в макросе не
 * требуется. Поэтому проверки, требующие объявления, к ним не применяются.
 */
export function isRslSpecialVariableReference(value: string): boolean {
    const text = String(value || "").trim();

    return text.length > 2 && text.startsWith("{") && text.endsWith("}");
}

/** Спецпеременная из общесистемного списка: у неё известны тип и описание. */
export function isRslSystemSpecialVariableName(name: string): boolean {
    const normalized = normalizeIdentifier(name);
    const bareName = normalized.startsWith("{") &&
        normalized.endsWith("}")
        ? normalized.substring(1, normalized.length - 1)
        : normalized;

    return RSL_SYSTEM_SPECIAL_VARIABLE_NAMES.has(bareName);
}
