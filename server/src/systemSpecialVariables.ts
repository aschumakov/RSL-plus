import { normalizeIdentifier } from "./lexer";

export type RslSystemSpecialVariableType =
    | "string"
    | "integer"
    | "bool"
    | "date";

export interface IRslSystemSpecialVariable {
    name: string;
    type: RslSystemSpecialVariableType;
    description: string;
}

/**
 * Общесистемные спецпеременные RS-Bank.
 *
 * Фигурные скобки входят в синтаксис ссылки, но не в имя, которое хранится
 * здесь. Список также используется для completion и семантической проверки.
 */
export const RSL_SYSTEM_SPECIAL_VARIABLES:
IRslSystemSpecialVariable[] = [
    {
        name: "BranchCurDate",
        type: "string",
        description: "Дата операционного дня, открытого последним в филиале работающего пользователя."
    },
    {
        name: "BPromUse",
        type: "bool",
        description: "Признак работы ИБС RS-Bank в режиме промышленной эксплуатации."
    },
    {
        name: "CCYNatCur",
        type: "string",
        description: "Буквенный ISO-код национальной валюты."
    },
    {
        name: "CORAC_Bank",
        type: "string",
        description: "Корсчёт банка в расчётном центре."
    },
    {
        name: "cRealTypePerson",
        type: "string",
        description: "Наименование актуального уровня доступа текущего пользователя."
    },
    {
        name: "cTypePerson",
        type: "string",
        description: "Код уровня доступа текущего пользователя."
    },
    {
        name: "curdate",
        type: "date",
        description: "Дата текущего операционного дня."
    },
    {
        name: "FIO_Book",
        type: "string",
        description: "ФИО главного бухгалтера."
    },
    {
        name: "FIO_Boss",
        type: "string",
        description: "ФИО управляющего."
    },
    {
        name: "GroupOperF",
        type: "string",
        description: "Нижняя граница диапазона номеров подчинённых пользователей."
    },
    {
        name: "GroupOperL",
        type: "string",
        description: "Верхняя граница диапазона номеров подчинённых пользователей."
    },
    {
        name: "INN_Bank",
        type: "string",
        description: "ИНН банка."
    },
    {
        name: "ISONatCur",
        type: "string",
        description: "Цифровой ISO-код национальной валюты."
    },
    {
        name: "Legal_Addr",
        type: "string",
        description: "Юридический адрес банка."
    },
    {
        name: "MFO_Bank",
        type: "string",
        description: "БИК банка."
    },
    {
        name: "MFO_RCC",
        type: "string",
        description: "БИК расчётного центра."
    },
    {
        name: "Name_Bank",
        type: "string",
        description: "Название банка."
    },
    {
        name: "Name_Book",
        type: "string",
        description: "Должность главного бухгалтера."
    },
    {
        name: "Name_Boss",
        type: "string",
        description: "Должность управляющего."
    },
    {
        name: "NumDprt",
        type: "integer",
        description: "Номер головного отделения банка."
    },
    {
        name: "oper",
        type: "integer",
        description: "Номер исполнителя, с которым пользователь зарегистрировался в системе."
    },
    {
        name: "OperDprt",
        type: "integer",
        description: "Идентификатор филиала текущего пользователя."
    },
    {
        name: "OperDprtNode",
        type: "string",
        description: "Идентификатор подразделения текущего пользователя."
    },
    {
        name: "OurBank",
        type: "integer",
        description: "Идентификатор связанного субъекта филиала текущего пользователя."
    },
    {
        name: "Post_Addr",
        type: "string",
        description: "Почтовый адрес банка."
    },
    {
        name: "Real_Addr",
        type: "string",
        description: "Фактический адрес банка."
    },
    {
        name: "ResidentCountryCode",
        type: "string",
        description: "Трёхбуквенный код страны резидентности."
    },
    {
        name: "Version",
        type: "string",
        description: "Номер версии системы."
    }
];

const RSL_SYSTEM_SPECIAL_VARIABLE_NAMES = new Set(
    RSL_SYSTEM_SPECIAL_VARIABLES.map(variable =>
        normalizeIdentifier(variable.name)
    )
);

export function isRslSystemSpecialVariableName(name: string): boolean {
    const normalized = normalizeIdentifier(name);
    const bareName = normalized.startsWith("{") &&
        normalized.endsWith("}")
        ? normalized.substring(1, normalized.length - 1)
        : normalized;

    return RSL_SYSTEM_SPECIAL_VARIABLE_NAMES.has(bareName);
}
