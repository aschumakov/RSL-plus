/**
 * Определение дуфолтных функций, классов и констант,
 * которые могут использоваться в любом месте кода без подгрузки какого-либо макроса или интера
 */

import {
    BuiltinClassSymbol,
    BuiltinFunctionSymbol,
    BuiltinSymbol
} from "./builtins/builtinSymbol";
import { InsertTextFormat, CompletionItemKind, MarkupKind } from 'vscode-languageserver';
import { RSL_SYSTEM_SPECIAL_VARIABLES } from "./systemSpecialVariables";


/**
 * Массив дефолтных классов, функций, переменных
 */
export class BuiltinCatalog {
    private items: BuiltinSymbol[] = [];

    add(symbol: BuiltinSymbol): void { this.items.push(symbol); }
    upsert(symbol: BuiltinSymbol): void {
        const index = this.items.findIndex(current =>
            current.name.toLowerCase() === symbol.name.toLowerCase()
        );
        if (index >= 0) this.items[index] = symbol;
        else this.items.push(symbol);
    }
    find(name: string): BuiltinSymbol | undefined {
        const normalized = name.toLowerCase();
        return this.items.find(item => item.name.toLowerCase() === normalized);
    }
    get completionItems() { return this.items.map(item => item.completionItem); }
}

/**
 * Возвращает дефолтные функции, классы, переменные
 */
export function getDefaults(): BuiltinCatalog { return DefaultsArray; }

/**
 * Содержит дефолтные функции, классы, переменные
 */
const DefaultsArray = new BuiltinCatalog();


/*───────────────────────────────────────────────────────────────────────────────────────────────────*/
/* Описание Класса TBFile*/
let TBfile: BuiltinClassSymbol = new BuiltinClassSymbol(
    "TBFile",
    "tbfile",
    "Класс TBFile",
    {kind: MarkupKind.Markdown, value: "Стандартный класс ```TBfile``` предназначен для работы с таблицами баз данных и представляет собой объектную альтернативу стандартной конструкции языка FILE."},
    "TBfile ( ${1:TableName}${2:[, AttrStr]}${3:[, KeyNum]}${4:[, FileName]}${5:[, DicName]} ); $0" /*подставляемый текст*/
);

/* все методы класса TBfile:
addFilter fldoffset getLE ReadBlob Clear fldsize getLT RecSize delete
getdirect getpos rewind dropFilter getEQ insert SetRecordAddr FileName
GetFldInfo next UnPackVarBuff fldindex getGE Nrecords update fldname
getGT PackVarBuff VarSize fldnumber GetKeyInfo prev WriteBlob */

TBfile.addChild(new BuiltinFunctionSymbol(
    "Update",
    "integer",
    "Метод класса TBFile: bFile.Update();",
	{kind: MarkupKind.Markdown, value: "Процедура обновляет текущую запись в файле ```id```, используя значения полей из буфера данных."},
    "Update (${1:id}${2:[, size]}${3:[, bool]})$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
));

TBfile.addChild(new BuiltinFunctionSymbol(
    "Insert",
    "integer",
    "Метод класса TBFile: bFile.Insert();",
	{kind: MarkupKind.Markdown, value: "Процедура помещает в таблицу (файл) новую запись, используя значения полей из буфера данных. \
	Добавление происходит в соответствии с заданными ключевыми последовательностями."},
    "Insert(${1:id}${2:[, string | size]}${3:[, integer]}${4:[, bool]})$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
));

TBfile.addChild(new BuiltinFunctionSymbol(
    "ReWind",
    "integer",
    "Метод класса TBFile: bFile.ReWind();",
	{kind: MarkupKind.Markdown, value: "Процедура переустанавливает таблицу или файл таким образом, что текущая позиция не изменяется,\
	 но изменяется поведение вызванных после ```rewind``` процедур ```next``` или ```prev```: ```next``` извлечет первую запись, а ```prev``` – последнюю."},
    "ReWind()$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
));

TBfile.addChild(new BuiltinFunctionSymbol(
    "Prev",
    "integer",
    "Метод класса TBFile: bFile.Prev();",
    {kind: MarkupKind.Markdown, value: "Процедура считывает из таблицы или файла предыдущую запись или последнюю, если вызывается после процедуры ```rewind```."},
    "Prev()$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
));

TBfile.addChild(new BuiltinFunctionSymbol(
    "Next",
    "integer",
    "Метод класса TBFile: bFile.Next();",
    {kind: MarkupKind.Markdown, value: "Процедура считывает из таблицы или файла следующую за текущей запись или первую запись, если вызывается после процедуры ```rewind```."},
    "Next()$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
));

TBfile.addChild(new BuiltinFunctionSymbol(
    "getLE",
    "integer",
    "Метод класса TBFile: bFile.getLE();",
    {kind: MarkupKind.Markdown, value: "Осуществляет поиск записи таблицы, значение ключа для которой меньше или равно указанному"},
    "getLE();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
));

TBfile.addChild(new BuiltinFunctionSymbol(
    "getLT",
    "integer",
    "Метод класса TBFile: bFile.getLT();",
    {kind: MarkupKind.Markdown, value: "Осуществляет поиск записи таблицы, значение ключа для которой меньше указанного"},
    "getLT();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
    ));

TBfile.addChild(new BuiltinFunctionSymbol(
    "getEQ",
    "integer",
    "Метод класса TBFile: bFile.getEQ();",
    {kind: MarkupKind.Markdown, value: "Осуществляет поиск записи таблицы, значение ключа для которой равно указанному"},
    "getEQ();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
    ));

TBfile.addChild(new BuiltinFunctionSymbol(
    "getGE",
    "integer",
    "Метод класса TBFile: bFile.getGE()",
    {kind: MarkupKind.Markdown, value: "Осуществляет поиск записи таблицы, значение ключа для которой больше или равно указанному"},
    "getGE();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
    ));

TBfile.addChild(new BuiltinFunctionSymbol(
    "getGT",
    "integer",
    "Метод класса TBFile: bFile.getGT()",
    {kind: MarkupKind.Markdown, value: "Осуществляет поиск записи таблицы, значение ключа для которой больше указанного"},
    "getGT();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
    ));

TBfile.addChild(new BuiltinFunctionSymbol(
    "Clear",
    "integer",
    "Метод класса TBFile: bFile.Clear()",
    {kind: MarkupKind.Markdown, value: "Обнуляет буфер записи таблицы базы данных "},
    "Clear();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
    ));

TBfile.addChild(new BuiltinFunctionSymbol(
    "Delete",
    "integer",
    "Метод класса TBFile: bFile.Delete();",
    {kind: MarkupKind.Markdown, value: "Удаляет текущую запись из файла БД"},
    "Delete();$0",
    InsertTextFormat.Snippet,
    CompletionItemKind.Method
    ));

TBfile.addChild(new BuiltinSymbol(
    "Rec",
    "variable",
    "Свойство класса TBFile: bFile.Rec",
    {kind: MarkupKind.Markdown, value: "Ссылка на объект типа ```RECORD```, при обращении к которому осуществляется доступ к полям записи."},
    "Rec.$0"
    ));

TBfile.addChild(new BuiltinSymbol(
    "KeyNum",
    "integer",
    "Свойство класса TBFile: bFile.KeyNum",
    {kind: MarkupKind.Markdown, value: "Устанавливает или возвращает текущий индекс в таблице."},
    "KeyNum($0)",
    InsertTextFormat.Snippet
    ));

DefaultsArray.add(TBfile);

/*───────────────────────────────────────────────────────────────────────────────────────────────────*/
/*Конец описания класса TBFile*/

/* Описание Класса TArray*/
let TArray: BuiltinClassSymbol = new BuiltinClassSymbol(
    "TArray",
    "tarray",
    "Класс TArray",
    {kind: MarkupKind.Markdown, value: "Стандартный класс TArray языка RSL используется для реализации динамического массива. Динамический массив ```TArray``` представляет собой объектную альтернативу стандартной конструкции языка ```ARRAY```. "},
    "TArray ($0);" /*подставляемый текст*/
);

TArray.addChild(new BuiltinSymbol(
    "MarshalByVal",
    "bool",
    "Свойство класса TArray",
    {kind: MarkupKind.Markdown, value: "Определяет, каким образом объекты этого класса передаются в RSCOM. Если свойству присвоено значение TRUE, то объекты передаются по значению. По умолчанию свойство имеет значение FALSE, и, соответственно, объекты класса ```TArray по умолчанию передаются по ссылке.```"},
    "MarshalByVal(${1|true,false|});$0"
    ));

TArray.addChild(new BuiltinFunctionSymbol(
    "Sort",
    "integer",
    "Метод класса TArray",
    {kind: MarkupKind.Markdown, value: "Выполняет сортировку массива ```в соответствии с порядком```, определяемым пользовательским обработчиком. В случае успешного завершения возвращает ```TRUE```. При неудаче – ```FALSE```. Причиной неудачи могут быть неверно заданные параметры."},
    "Sort(${1:callback}, ${2:data});$0"
    ));

DefaultsArray.add(TArray);
/*───────────────────────────────────────────────────────────────────────────────────────────────────*/
/*Конец описания класса TArray*/


/* Описание стандартных фунций*/
let func: BuiltinFunctionSymbol = new BuiltinFunctionSymbol(
    "GetInt",
    "integer",
    "Функция GetInt ( id [, prompt, len [, hide ] ] )",
    {kind: MarkupKind.Markdown, value: "Процедура присваивает введенное пользователем значение переменной типа Integer с именем ```id```. По умолчанию ширина поля ввода равна 12 символам."},
    "GetInt ( ${1:id} ${2:, prompt, len ${3:, hide}} );$0" /*подставляемый текст*/
);
DefaultsArray.add(func);

func = new BuiltinFunctionSymbol(
    "GetDouble",
    "double",
    "Функция GetDouble ( id [, prompt, len [, hide [, pos ] ] ] )",
    {kind: MarkupKind.Markdown, value: "Процедура присваивает введенное пользователем значение переменной типа Double с именем ```id```. По умолчанию ширина поля ввода равна 24 символам."},
    "GetDouble ( ${1:id} ${2:, prompt, len ${3:, hide ${4:, pos}}});$0" /*подставляемый текст*/
);
DefaultsArray.add(func);

func = new BuiltinFunctionSymbol(
	"GetValue",
	"variable",
	"Функция GetValue(param.ReqFindClient.AddressFIAS.RegionCode, \"\");",
	{kind: MarkupKind.Markdown, value: "Получить значение параметра"},
	"GetValue( ${1:value}, ${2:\"\"} );$0" /*подставляемый текст*/
);
DefaultsArray.add(func);

func = new BuiltinFunctionSymbol(
	"StrSubst",
	"variable",
	"Функция StrSubst ( sourse, strToFind, strToReplace)",
	{kind: MarkupKind.Markdown, value: "Процедура ищет в строке source подстроки strToFind и заменяет их строками strToReplace. Возвращаемым значением является результирующая строка."},
	"StrSubst( ${1:sourse}, ${2:\"\"}, ${3:\"\"} );$0" /*подставляемый текст*/
);
DefaultsArray.add(func);

/*ListChapter */





















/*───────────────────────────────────────────────────────────────────────────────────────────────────*/
/*Конец описания стандартных фунций*/


/* Описание спецпеременных*/
let specVar: BuiltinSymbol = new BuiltinSymbol(
    "MFO_Bank",
    "integer",
    "Спецпеременная {MFO_Bank}",
    {kind: MarkupKind.Markdown, value: "БИК банка."},
    "{MFO_Bank}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "KU_Bank",
    "integer",
    "Спецпеременная {KU_Bank}",
    {kind: MarkupKind.Markdown, value: "Код участника банка."},
    "{KU_Bank}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "CORAC_Bank",
    "integer",
    "Спецпеременная {CORAC_Bank}",
    {kind: MarkupKind.Markdown, value: "Корсчет банка в РЦ."},
    "{CORAC_Bank}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "NumDprt",
    "integer",
    "Спецпеременная {NumDprt}",
    {kind: MarkupKind.Markdown, value: "Номер отделения банка."},
    "{NumDprt}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "MFO_RCC",
    "integer",
    "Спецпеременная {MFO_RCC}",
    {kind: MarkupKind.Markdown, value: "БИК банка."},
    "{MFO_RCC}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "KU_RCC",
    "integer",
    "Спецпеременная {KU_RCC}",
    {kind: MarkupKind.Markdown, value: "Код участника РЦ банка."},
    "{KU_RCC}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "Name_Bank",
    "string",
    "Спецпеременная {Name_Bank}",
    {kind: MarkupKind.Markdown, value: "Название банка."},
    "{Name_Bank}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "DEBETRATE",
    "integer",
    "Спецпеременная {DEBETRATE}",
    {kind: MarkupKind.Markdown, value: "Дебетовый счет переоценки."},
    "{DEBETRATE}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "KREDITRATE",
    "integer",
    "Спецпеременная {KREDITRATE}",
    {kind: MarkupKind.Markdown, value: "Кредитовый счет переоценки."},
    "{KREDITRATE}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "CALCRATE",
    "integer",
    "Спецпеременная {CALCRATE}",
    {kind: MarkupKind.Markdown, value: "Счет переоценки рублевых покрытий."},
    "{CALCRATE}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "BASECASH",
    "integer",
    "Спецпеременная {BASECASH}",
    {kind: MarkupKind.Markdown, value: "Счет кассы."},
    "{BASECASH}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "CASHDEP",
    "integer",
    "Спецпеременная {CASHDEP}",
    {kind: MarkupKind.Markdown, value: "Счет кассы вкладчиков."},
    "{CASHDEP}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "TRANDEP",
    "integer",
    "Спецпеременная {TRANDEP}",
    {kind: MarkupKind.Markdown, value: "Транзитный счет вкладчиков."},
    "{TRANDEP}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "IOBAccount",
    "integer",
    "Спецпеременная {IOBAccount}",
    {kind: MarkupKind.Markdown, value: "Счет корреспонденции с очередями."},
    "{IOBAccount}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "OBalance_Index1",
    "integer",
    "Спецпеременная {OBalance_Index1}",
    {kind: MarkupKind.Markdown, value: "Балансовый счет очереди №1."},
    "{OBalance_Index1}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "OBalance_Index2",
    "integer",
    "Спецпеременная {OBalance_Index2}",
    {kind: MarkupKind.Markdown, value: "Балансовый счет очереди №2."},
    "{OBalance_Index2}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "OBalance_IndexU",
    "integer",
    "Спецпеременная {OBalance_IndexU}",
    {kind: MarkupKind.Markdown, value: "Балансовый счет очереди корсчета."},
    "{OBalance_IndexU}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "OBalance_Sys",
    "integer",
    "Спецпеременная {OBalance_Sys}",
    {kind: MarkupKind.Markdown, value: "Системный счет корреспонденции с очередями."},
    "{OBalance_Sys}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "FIO_Book",
    "string",
    "Спецпеременная {FIO_Book}",
    {kind: MarkupKind.Markdown, value: "ФИО главного бухгалтера."},
    "{FIO_Book}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "Name_Boss",
    "string",
    "Спецпеременная {Name_Boss}",
    {kind: MarkupKind.Markdown, value: "Должность управляющего."},
    "{Name_Boss}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "FIO_Boss",
    "string",
    "Спецпеременная {FIO_Boss}",
    {kind: MarkupKind.Markdown, value: "ФИО управляющего."},
    "{FIO_Boss}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "curdate",
    "date",
    "Спецпеременная {curdate}",
    {kind: MarkupKind.Markdown, value: "Дата текущего операционного дня."},
    "{curdate}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "oper",
    "integer",
    "Спецпеременная {oper}",
    {kind: MarkupKind.Markdown, value: "Номер исполнителя, с которым пользователь зарегистрировался в системе."},
    "{oper}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "Version",
    "integer",
    "Спецпеременная {Version}",
    {kind: MarkupKind.Markdown, value: "Номер версии системы."},
    "{Version}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "ModuleNum",
    "integer",
    "Спецпеременная {ModuleNum}",
    {kind: MarkupKind.Markdown, value: "Номер текущего модуля."},
    "{ModuleNum}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "BatchMode",
    "bool",
    "Спецпеременная {BatchMode}",
    {kind: MarkupKind.Markdown, value: "Признак работы в пакетном режиме."},
    "{BatchMode}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "OperDprt",
    "integer",
    "Спецпеременная {OperDprt}",
    {kind: MarkupKind.Markdown, value: "Код филиала, к которому относится операционист."},
    "{OperDprt}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "Post_Addr",
    "string",
    "Спецпеременная {Post_Addr}",
    {kind: MarkupKind.Markdown, value: "Почтовый адрес банка."},
    "{Post_Addr}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

specVar = new BuiltinSymbol(
    "CreditsOn",
    "bool",
    "Спецпеременная {CreditsOn}",
    {kind: MarkupKind.Markdown, value: "Дополнительная функция - кредиты."},
    "{CreditsOn}", /*подставляемый текст*/
    InsertTextFormat.PlainText
);
DefaultsArray.add(specVar);

/*
 * Официальный список общесистемных переменных является источником истины.
 * upsert сохраняет дополнительные исторические переменные выше, но исправляет
 * типы старых записей и добавляет отсутствующие системные имена.
 */
RSL_SYSTEM_SPECIAL_VARIABLES.forEach(variable => {
    DefaultsArray.upsert(new BuiltinSymbol(
        variable.name,
        variable.type,
        `Спецпеременная {${variable.name}}`,
        {
            kind: MarkupKind.Markdown,
            value: variable.description
        },
        `{${variable.name}}`,
        InsertTextFormat.PlainText
    ));
});
