import { CompletionItemKind } from "vscode-languageserver";

export interface IRslBuiltinDefinition {
    name: string;
    kind: CompletionItemKind;
    typeName: string;
    signature?: string;
    summary?: string;
    insertText?: string;
    /**
     * Значение константы.
     *
     * Отдельно от signature: подпись — текст для Signature Help, а значение
     * читают Hover и Completion. Раньше значение существовало только внутри
     * подписи, и в RslSymbol не доходило вообще.
     */
    value?: string;
    /**
     * Имя базового класса — только для классов.
     *
     * Члены базового класса здесь не дублируются: цепочку обходит
     * scopeResolver, тот же самый, что и для Class (Base) пользователя.
     * Копирование состава в производный класс означало бы, что правка
     * базового класса требует правки всех производных.
     */
    base?: string;
    children?: readonly IRslBuiltinDefinition[];
}

/*
 * Возвращаемый тип берётся из конца сигнатуры.
 *
 * Именно из конца, а не из первого двоеточия после закрывающей скобки:
 * двоеточия внутри сигнатуры принадлежат типам параметров, а необязательный
 * параметр может закрываться скобкой (`Date [ (day, mon, year) ]: Date`).
 *
 * Объявление стоит до каталога намеренно: const не поднимается, а массивы
 * ниже вызывают procedure() и method() уже при инициализации модуля.
 */
const TRAILING_TYPE = /:\s*(@?[\wА-Яа-яЁё]+)\s*$/u;

/**
 * Тип результата из конца готовой подписи.
 *
 * Нужен там, где подпись приходит одной строкой и разделить её при объявлении
 * нельзя: это встроенные процедуры и сгенерированные данные прикладных модулей.
 * У методов стандартных классов тип объявляется явно (см. method), и разбирать
 * его строкой не приходится.
 */
export function trailingReturnType(
    signature: string | undefined
): string | undefined {
    return signature ? TRAILING_TYPE.exec(signature)?.[1] : undefined;
}

/*
 * Каталог хранит только факты, необходимые IDE: имена, сигнатуры, типы и
 * короткие собственные описания. Текст руководства и ссылки на него сюда не
 * копируются. Массив создаётся один раз при загрузке language server.
 *
 * Одно объявление на элемент — и для процедуры, и для члена класса. Раньше
 * сигнатуры, возвращаемые типы и описания процедур лежали в трёх отдельных
 * структурах, связанных по имени в нижнем регистре: опечатка в ключе не была
 * ошибкой компиляции, а просто молча оставляла процедуру без описания или с
 * типом Variant. Возвращаемый тип теперь объявляется один раз — в конце
 * сигнатуры, где он к тому же виден в Signature Help.
 *
 * Описания — своя формулировка по существу, а не цитата руководства: одно
 * предложение о том, что элемент делает. Подробности (диапазоны, значения
 * флагов, поведение в трёхзвенной архитектуре) не переносятся — в Hover и
 * Completion они не читаются, а место занимают. Порядок и группировка
 * повторяют разделы руководства, чтобы сверка с его следующей редакцией была
 * механической.
 */
const PROCEDURE_DEFINITIONS: readonly IRslBuiltinDefinition[] = [
    /* Ввод данных с клавиатуры. */
    procedure(
        "GetInt (id [, prompt, len [, hide] ]): Bool",
        "Вводит значение Integer."
    ),
    procedure(
        "GetDouble (id [, prompt, len [, hide [, pos ] ] ]): Bool",
        "Вводит значение Double."
    ),
    procedure(
        "GetMoney (id [, prompt, len [, hide] [, pos]]): Bool",
        "Вводит значение Money."
    ),
    procedure(
        "GetNumeric (id [, prompt, len [, hide [, pos] ] ]): Bool",
        "Вводит значение Numeric."
    ),
    procedure(
        "GetString (id [, prompt, len [, hide] ]): Bool",
        "Вводит строковое значение."
    ),
    procedure(
        "GetStringR (id [, prompt, len [, hide] ]): Bool",
        "Вводит числовую строку с выравниванием вправо."
    ),
    procedure(
        "GetTime(id [, prompt [, hide ] ]): Bool",
        "Вводит значение Time."
    ),
    procedure(
        "GetDate (id [, prompt [, hide] ]): Bool",
        "Вводит значение Date."
    ),
    procedure(
        "GetTRUE (id [, prompt ]): Bool",
        "Запрашивает подтверждение и вводит Bool."
    ),

    /* Вывод и отладочная печать. */
    procedure("Print (...)", "Выводит переданные значения."),
    procedure("PrintGlobs (...)", "Выводит все глобальные переменные."),
    procedure("PrintFiles (...)", "Выводит имя, тип и файл каждого модуля."),
    procedure("PrintLn", "Выводит значения и перевод строки."),
    procedure(
        "PrintLocs (...)",
        "Выводит локальные переменные текущей процедуры."
    ),
    procedure("PrintModule (modName:String)", "Выводит тип и файл модуля."),
    procedure("PrintProps (object)", "Выводит свойства объекта."),
    procedure(
        "PrintRefs (ob: Object)",
        "Выводит объекты, ссылающиеся на заданный."
    ),
    procedure("PrintStack (...)", "Выводит стек вызова процедур."),
    procedure(
        "PrintSymModule (symbolName:String)",
        "Выводит сведения о символе и его модуле."
    ),
    procedure("Message", "Выводит строку в нижнюю строку экрана."),
    procedure("SetOutput ([ string ] [, bool ])", "Задаёт файл вывода."),
    procedure("SetColumn (integer)", "Задаёт колонку вывода отчёта."),
    procedure("FlushColumn", "Выводит буфер колонок в файл."),
    procedure("ClearColumn", "Очищает буфер печати."),
    procedure("SetDefPrec (integer)", "Задаёт число знаков после точки."),
    procedure(
        "SetOutHandler (NameMacro)",
        "Задаёт обработчик стандартного вывода."
    ),
    procedure(
        "GetPRNInfo ([escSeq:String, banner:String, " +
            "frmFeed:Bool]) : String",
        "Возвращает имя устройства печати."
    ),
    procedure(
        "SetPRNInfo (prnName: String [, escSeq: String, banner: String, " +
            "frmFeed:Bool ])",
        "Задаёт принтер и параметры печати."
    ),

    /* Преобразование типов и значений. */
    procedure("ValType (val): Integer", "Возвращает код типа значения."),
    procedure("Double (val): Double", "Преобразует значение в Double."),
    procedure("DoubleL (val): DoubleL", "Преобразует значение в DoubleL."),
    procedure("Int (val): Integer", "Преобразует значение в Integer."),
    procedure(
        "String (val {, val}): String",
        "Формирует отформатированную строку из параметров."
    ),
    procedure("Money (val): Money", "Преобразует значение в Money."),
    procedure(
        "MkStr (val1, val2): String",
        "Возвращает строку из символа-заполнителя."
    ),
    procedure("Floor (val): Integer", "Возвращает целую часть числа."),
    procedure(
        "Asize (val [, newsize]): Integer",
        "Возвращает размер массива или создаёт новый."
    ),
    procedure(
        "Date [ (day, mon, year) ]: Date",
        "Возвращает дату, заменяя её части."
    ),
    procedure(
        "DateSplit (date, day, mon, year)",
        "Разбирает дату на день, месяц, год."
    ),
    procedure(
        "Time [ (hour, min, sec, msec) ]: Time",
        "Возвращает время, заменяя его части."
    ),
    procedure(
        "TimeSplit (time, hour, min, sec)",
        "Разбирает время на часы, минуты, секунды."
    ),
    procedure(
        "DtTm (date, time): DateTime",
        "Собирает Dttm из даты и времени."
    ),
    procedure("DtTmSplit (d, dt, tm)", "Разбирает Dttm на дату и время."),
    procedure(
        "RubToStr (money [, rub, kop [, full ]], kol): String",
        "Записывает сумму в рублях прописью."
    ),
    procedure(
        "RubToStrAlt (money, [rub, kop, ] kol): String",
        "Записывает сумму прописью, альтернативный формат."
    ),
    procedure(
        "CurToStrAlt (money [, rub, kop ], ISO, kol): String",
        "Записывает сумму прописью по ISO-коду валюты."
    ),
    procedure(
        "MonName (mon): String",
        "Возвращает название месяца по номеру."
    ),
    procedure(
        "NumToStr (val, n1:String, n2:String, n3:String, isMan:Bool, " +
            "prec:Integer) : String",
        "Записывает число прописью с единицами измерения."
    ),
    procedure(
        "SetAutoMoneyFloor (auto:Bool):bool",
        "Управляет отбрасыванием долей копеек."
    ),
    procedure(
        "Round (val:Variant [, pos:Integer] , [round:Integer]):Money",
        "Округляет значение до заданной точности."
    ),
    procedure(
        "MakeDouble (p1:Integer, p2:Integer, p3:Integer):Double",
        "Собирает Double из трёх полей."
    ),
    procedure(
        "MakeMoney (p1:Integer, p2:Integer, p3:Integer):Money",
        "Собирает Money из трёх полей."
    ),
    procedure(
        "SplitMoney (mn:Money, p1:@Integer, p2:@Integer, p3:@Integer)",
        "Разбирает Money на три целых числа."
    ),

    /* Работа со строками. */
    procedure("StrLen (string): Integer", "Возвращает длину строки."),
    procedure(
        "Index (srcStr:String, fnd:String [, startPos:Integer]):Integer",
        "Возвращает позицию подстроки."
    ),
    procedure(
        "StrBrk (string1, string2): Integer",
        "Возвращает позицию первого совпавшего символа."
    ),
    procedure(
        "StrIsNumber(str:String):Bool",
        "Проверяет, состоит ли строка из цифр."
    ),
    procedure(
        "SubStr (string, integer1 [, integer2]): String",
        "Возвращает фрагмент строки."
    ),
    procedure(
        "StrSet (string1, integer, string2): String",
        "Записывает подстроку с заданной позиции."
    ),
    procedure("Trim (string): String", "Удаляет крайние пробелы."),
    procedure(
        "StrSplit (string, array, len [, len_first] [, minseg])",
        "Разбивает строку на сегменты в массив."
    ),
    procedure(
        "StrSplit2 (source:String, len:Integer [, len_first:Integer] [, " +
            "minseg:Integer]) : TArray",
        "Разбивает строку на сегменты, возвращает TArray."
    ),
    procedure(
        "StrUpr (string [,len]): String",
        "Преобразует строку в верхний регистр."
    ),
    procedure(
        "StrLwr (string [, len]): String",
        "Преобразует строку в нижний регистр."
    ),
    procedure(
        "CodeFor (string): Integer",
        "Возвращает ASCII-код первого символа."
    ),
    procedure("StrFor (number): String", "Возвращает символ по ASCII-коду."),
    procedure(
        "StrSubst (sourse, strToFind, strToReplace): String",
        "Заменяет подстроки."
    ),
    procedure("ToOEM (string [, mode])", "Конвертирует строку из ANSI в OEM."),
    procedure(
        "ToANSI (string [, mode])",
        "Конвертирует строку из OEM в ANSI."
    ),

    /* Параметры процедур. */
    procedure(
        "GetParm (num, var)",
        "Читает фактический параметр вызывающей процедуры."
    ),
    procedure(
        "IsOutParm (num:Integer):Bool",
        "Проверяет, является ли параметр выходным."
    ),
    procedure(
        "SetParm (num, expression)",
        "Записывает фактический параметр вызывающей процедуры."
    ),
    procedure(
        "Parmcount (): Integer",
        "Возвращает количество переданных параметров."
    ),

    /* Запуск программ и меню. */
    procedure(
        "Run (prog, parm, init, finish:String)",
        "Запускает внешнюю программу."
    ),
    procedure(
        "CallRemoteRsl (fileName [, procName [, parm1, parm2, ...]])",
        "Выполняет макрофайл на терминале."
    ),
    procedure(
        "Menu (array [, prompt] [, head] [, x] [, y] [, n])",
        "Показывает меню выбора из массива строк."
    ),
    procedure(
        "RunMenu (menuName, procName | procAddr [, lbrName])",
        "Выполняет меню из библиотеки ресурсов."
    ),

    /* Диалоговые панели. */
    procedure(
        "AddScroll (dlg:TRecHandler, data:Object [, numCol:Integer, " +
            "colArray:TArray, proc:Variant, rdOnly:Bool, focused:Bool] [, " +
            "NumBar:Integer])",
        "Создаёт область прокрутки диалоговой панели."
    ),
    procedure(
        "RunDialog (dlg:TRecHandler [, proc:Variant]):Bool",
        "Показывает диалоговое окно."
    ),
    procedure(
        "DisableValidation (dlg:Variant, id:Integer)",
        "Отключает проверку даты в поле диалога."
    ),
    procedure(
        "UpdateFields (dlg:TRecHandler [, id:Integer])",
        "Обновляет значения полей диалоговой панели."
    ),
    procedure(
        "SetFocus (dlg:TRecHandler, id:Integer)",
        "Устанавливает фокус ввода в поле."
    ),
    procedure("MsgBox (mes)", "Показывает сообщение."),
    procedure(
        "DisableFields (dlg:TRecHandler [, id:Integer])",
        "Запрещает редактирование полей диалога."
    ),
    procedure(
        "EnableFields (dlg:TRecHandler [, id:Integer])",
        "Разрешает редактирование полей диалога."
    ),
    procedure(
        "SetTimer (dlg:TRecHandler [, timeOut:Integer, set:Bool])",
        "Устанавливает таймер диалоговой панели."
    ),
    procedure(
        "MsgBoxEx (val:Variant [, flags:Integer, defInd:Integer, " +
            "title:String, statLn:String ])",
        "Показывает окно сообщения с кнопками."
    ),

    /*
     * Скроллинг.
     *
     * Процедуры модулей RslScr и rslx здесь НЕ объявляются. Руководство
     * помещает их в разделы «Макропроцедуры модуля RslScr» и «Макропроцедуры
     * модуля rslx» и требует подключить модуль командой IMPORT — значит без
     * Import этих имён не существует, и предлагать их наравне со встроенными
     * означало бы обещать то, чего в файле нет. Они описаны в
     * platform-modules/rslscr.json и platform-modules/rslx.json.
     */
    procedure(
        "GetScrollFieldValue(numfld:Integer, value:Undef):Bool",
        "Читает значение поля текущей строки скроллинга."
    ),
    procedure(
        "SetScrollFieldValue(numfld:Integer, newvalue:Undef, " +
            "[strlen:Integer]):Bool",
        "Задаёт значение поля текущей строки скроллинга."
    ),
    procedure(
        "IsScrollEditMode():Bool",
        "Проверяет режим редактирования внутри скроллинга."
    ),
    procedure(
        "Trace (...)",
        "Печатает параметры в окно трассировки отладчика."
    ),
    procedure("DebugBreak", "Передаёт управление отладчику."),

    /* Словари и структура таблиц. */
    procedure(
        "ConvertDDF (defName:String, outDir:String):Bool",
        "Конвертирует словарь def в формат ddf."
    ),
    procedure(
        "CopyTblDef (inDef:String, outDef:String, inStruct:String, " +
            "outStruct:String):Bool",
        "Копирует описание структуры таблицы между словарями."
    ),

    /* Таблицы базы данных и файлы. */
    procedure(
        "ExistFile (string [, integer]): Bool",
        "Проверяет существование таблицы или файла."
    ),
    procedure(
        "Open (fid, name:String, encode:String, fatal:Bool, " +
            "eolType:Integer) : Bool",
        "Открывает таблицу базы данных или файл."
    ),
    procedure("Close (id)", "Закрывает таблицу или файл."),
    procedure(
        "ClearStructs",
        "Освобождает из памяти структуры открытых таблиц."
    ),
    procedure(
        "Create (id [, filename] [, isTable:Bool] [, isP:Bool])",
        "Создаёт таблицу или DBF-файл по словарю."
    ),
    procedure(
        "Clone (id [, filename] [, isTable:Bool] [, isP:Bool])",
        "Создаёт или очищает таблицу по словарю."
    ),
    procedure(
        "ViewFile (id, name [, edit])",
        "Показывает текстовый файл или таблицу."
    ),
    procedure(
        "DelFile (string)",
        "Удаляет таблицу вместе с описанием в словаре."
    ),
    procedure(
        "DropTable (string)",
        "Удаляет таблицу, сохраняя описание в словаре."
    ),
    procedure("Next (id [, integer]): Bool", "Читает следующую запись."),
    procedure("Prev (id): Bool", "Читает предыдущую запись."),
    procedure("ReWind (id): Bool", "Сбрасывает позицию чтения таблицы."),
    procedure(
        "Insert (id [, string | size] [, integer] [, bool]): Bool",
        "Добавляет запись из буфера данных."
    ),
    procedure(
        "Update (id [, size] [, bool]): Bool",
        "Обновляет текущую запись из буфера данных."
    ),
    procedure("Delete (id, bool): Bool", "Удаляет текущую запись."),
    procedure("GetPos (id)", "Возвращает физическую позицию текущей записи."),
    procedure(
        "GetDirect (id [, recpos])",
        "Читает запись по физической позиции."
    ),
    procedure("GetEQ (id): Bool", "Ищет запись с равным ключом."),
    procedure("GetGT (id): Bool", "Ищет запись с большим ключом."),
    procedure("GetGE (id): Bool", "Ищет запись с не меньшим ключом."),
    procedure("GetLT (id): Bool", "Ищет запись с меньшим ключом."),
    procedure("GetLE (id): Bool", "Ищет запись с не большим ключом."),
    procedure(
        "SetRecordAddr (recId, fileId [, ind] [, offset] [, fix])",
        "Накладывает структуру на таблицу базы данных."
    ),
    procedure(
        "PackVarBuff (file [, size])",
        "Упаковывает переменную часть записи."
    ),
    procedure(
        "UnPackVarBuff (file)",
        "Распаковывает переменную часть записи."
    ),
    procedure(
        "GetRecordSize (id): Integer",
        "Возвращает размер записи в байтах."
    ),
    procedure(
        "GetVarSize (id): Integer",
        "Возвращает размер переменной части записи."
    ),
    procedure("FileName (id): String", "Возвращает имя таблицы или файла."),
    procedure(
        "NRecords (id [, par:Bool]): Integer",
        "Возвращает количество записей."
    ),
    procedure("FldNumber (id): Integer", "Возвращает количество полей."),
    procedure(
        "FldName (id, number): String",
        "Возвращает имя поля по индексу."
    ),
    procedure(
        "FldIndex (id, string): Integer",
        "Возвращает индекс поля по имени."
    ),
    procedure(
        "FldOffset (id, string | number): Integer",
        "Возвращает смещение поля в байтах."
    ),
    procedure("ClearRecord (id)", "Обнуляет буфер записи."),
    procedure(
        "SetBuff (id, addr)",
        "Задаёт адрес памяти для структуры RECORD."
    ),
    procedure(
        "Copy (id1, id2 [, flag:Integer])",
        "Копирует содержимое буфера записи."
    ),
    procedure("CopyBlob ()", "Копирует запись вместе с полем BLOB."),
    procedure(
        "KeyNum (id [, newkey])",
        "Возвращает или задаёт номер текущего ключа."
    ),
    procedure(
        "SetDelim (symbol, space)",
        "Задаёт символы-разделители строк текстового файла."
    ),
    procedure(
        "Status [ (parm) ]",
        "Возвращает код ошибки работы с таблицами."
    ),

    /* Транзакции. */
    procedure(
        "ProcessTrn (TrnType:Integer, MacroName:String, Variant [, " +
            "file1:File] [, file2:File] [, ...:File]):Bool",
        "Выполняет транзакцию."
    ),
    procedure("LoopInTrn (val)", "Управляет повтором транзакции при захвате."),
    procedure("AbortTrn()", "Прерывает транзакцию с откатом изменений."),

    /* Файлы и каталоги операционной системы. */
    procedure(
        "SelectFile (file [, mask, head], sort, term)",
        "Показывает стандартное окно выбора файла."
    ),
    procedure(
        "SelectFolder (folder [, mask, head, ] term)",
        "Показывает стандартное окно выбора каталога."
    ),
    procedure(
        "NeedFreeDB ()",
        "Требует закрыть словари при завершении программы."
    ),
    procedure("WriteBlob (file, value)", "Записывает значение в поле BLOB."),
    procedure(
        "ReadBlob (file, value)",
        "Читает очередное значение поля BLOB."
    ),
    procedure(
        "CopyFile (src:String, dst:String [, ind:Bool [, " +
            "indHeading:String]]) : Bool",
        "Копирует файл."
    ),
    procedure(
        "RenameFile (src:String, dst:String) : Bool",
        "Переименовывает файл."
    ),
    procedure("RemoveFile (src:String) : Bool", "Удаляет файл."),
    procedure(
        "ExistDir(name:String):Integer",
        "Проверяет существование и доступность каталога."
    ),
    procedure("MakeDir (name:String) : Bool", "Создаёт каталог."),
    procedure("RemoveDir (name:String) : Bool", "Удаляет пустой каталог."),
    procedure(
        "GetCurDir ([isRemote:Bool]) : String",
        "Возвращает текущий каталог."
    ),
    procedure(
        "SplitFile (pathName: String [, name: String [, " +
            "ext: String ] ]): String",
        "Разбирает полное имя файла на составляющие."
    ),
    procedure(
        "MergeFile (dirName: String ,name: String [, " +
            "ext: String ]): String",
        "Собирает полное имя файла из составляющих."
    ),
    procedure(
        "FindPath (name: String [, dirList: String [, defExt: String [, " +
            "curDir: Bool ] ] ]): String",
        "Ищет файл в списке каталогов."
    ),
    procedure(
        "GetSysDir ([ ndir: Integer ]): String",
        "Возвращает списки каталогов поиска файлов."
    ),
    procedure(
        "GetIniFileValue (iniFileName:String, keyName:String):String",
        "Читает строку из файла настроек."
    ),
    procedure(
        "GetFileInfo (src:String [, dt:@Date, tm:@Time, size:@Integer, " +
            "path:@String]) : Bool",
        "Возвращает дату, время, размер и путь файла."
    ),

    /* Объекты и классы. */
    procedure(
        "ActiveX (mon:String, const=1):Object",
        "Создаёт объект ActiveX по моникеру."
    ),
    procedure(
        "ClassKind (obj:Object [, mask:Integer]):Integer",
        "Определяет вид объекта."
    ),
    procedure("GenClassName (obj): String", "Возвращает имя класса объекта."),
    procedure(
        "GenAttach (id, methodName, macroName | macroAddr)",
        "Заменяет метод объекта макропроцедурой."
    ),
    procedure(
        "GenObject (className [ , parm1, parm2, ...]): Object",
        "Создаёт объект по имени класса."
    ),
    procedure(
        "GenRun (ob, methodName [, par1, par2, ...])",
        "Вызывает метод объекта по имени."
    ),
    procedure(
        "GenSetProp (ob, propName, val)",
        "Задаёт значение свойства объекта."
    ),
    procedure(
        "GenGetProp (ob, propName)",
        "Возвращает значение свойства объекта."
    ),
    procedure(
        "GetObjProps (obj:Object, [CaseSensitive:Bool]):TArray",
        "Возвращает массив имён свойств объекта."
    ),
    procedure(
        "GetObjMethods (obj:Object, [CaseSensitive:Bool]):TArray",
        "Возвращает массив имён методов объекта."
    ),
    procedure(
        "IsEqClass (className, obj): Bool",
        "Проверяет принадлежность объекта классу."
    ),
    procedure(
        "GenPropID (obj, propName)",
        "Возвращает индекс свойства объекта."
    ),
    procedure(
        "R2M (obj:Object, name:String) : MethodRef",
        "Возвращает ссылку на метод объекта."
    ),
    procedure(
        "CallR2M (oPtr:MethodRef [, par1, par2,...]) : Variant",
        "Вызывает метод по ссылке MethodRef."
    ),
    procedure(
        "GenNumProps (obj:Object) : Integer",
        "Возвращает количество свойств объекта."
    ),
    procedure(
        "ClrRmtOnRelease (proxy:Object) : Bool",
        "Удаляет удалённый объект вместе с прокси."
    ),
    procedure(
        "GetNamedChanel (name:String) : Object",
        "Возвращает коммуникационный канал по имени."
    ),

    /* Индикаторы выполнения. */
    procedure(
        "InitProgress (maxRecord:Integer [, msg:String, head:String])",
        "Показывает индикатор выполнения цикла."
    ),
    procedure("UseProgress (record)", "Обновляет индикатор выполнения."),
    procedure("RemProgress", "Убирает индикатор выполнения с экрана."),
    procedure(
        "BegAction ([tm:Integer, text:String, canClose:Bool])",
        "Показывает асинхронный индикатор занятости."
    ),
    procedure(
        "EndAction (tm:Integer)",
        "Убирает асинхронный индикатор занятости."
    ),

    /* Среда выполнения и разное. */
    procedure(
        "CheckBits (n1:Integer, n2:Integer):Integer",
        "Возвращает побитовое И двух чисел."
    ),
    procedure(
        "DateShift (inData:Date [, nDay:Integer] [, nMon:Integer] [, " +
            "nYear:Integer]):Date",
        "Смещает дату на дни, месяцы, годы."
    ),

    /* Выполнение кода и модули. */
    procedure(
        "ExecMacro (string,.....): Variant",
        "Вызывает макропроцедуру по имени."
    ),
    procedure(
        "ExecMacro2 (string, .....): Variant",
        "Вызывает макропроцедуру и возвращает её результат."
    ),
    procedure(
        "ExecMacroFile (Module [, ProcName [, Parm1,Parm2, " +
            "...] ]): Variant",
        "Вызывает макропроцедуру из файла."
    ),
    procedure(
        "ExecMacroModule (codeStr:String [, macroName, par1, par2, " +
            "...]): Variant",
        "Выполняет код RSL-модуля из строки."
    ),
    procedure(
        "ReplaceMacro (string1, [ string2 ])",
        "Перенаправляет вызовы процедуры на другую."
    ),
    procedure("ExecExp (string): Variant", "Вычисляет выражение из строки."),
    procedure(
        "GCollect (ncol:@Integer):Integer",
        "Освобождает объекты без ссылок."
    ),
    procedure(
        "GetCallStack (): TArray",
        "Возвращает названия процедур текущего стека."
    ),
    procedure(
        "GetEnv (string): String",
        "Возвращает значение переменной среды."
    ),
    procedure(
        "GetMemAddrFrom (obj:Variant):MemAddr",
        "Возвращает адрес буфера объекта."
    ),
    procedure(
        "GetUIMode () : Integer",
        "Возвращает тип пользовательского интерфейса."
    ),
    procedure(
        "InstLoadModule (moduleName:String):Bool",
        "Динамически загружает RSL-модуль."
    ),
    procedure(
        "IsWeakRef (obj:Object):Bool",
        "Проверяет, является ли ссылка слабой."
    ),

    /* Потоки байтов. */
    procedure(
        "WriteByte (stream:Object, byte:Integer):Bool",
        "Записывает байт в поток IRsStream."
    ),
    procedure(
        "ReadByte (stream:Object, byte:@Integer):Bool",
        "Читает байт из потока IRsStream."
    ),

    /* Ошибки и завершение работы. */
    procedure(
        "RunError ([ mes:String] [, userObj:Variant])",
        "Повторно генерирует текущую ошибку."
    ),
    procedure(
        "Exit ([code:Integer] [, mes:String])",
        "Прекращает выполнение макропрограммы."
    ),
    procedure(
        "SetExitFlag (code:Integer)",
        "Задаёт режим просмотра результата без выхода."
    ),
    procedure("MemSize()", "Возвращает объём свободной памяти."),
    procedure("Version()", "Возвращает номер версии RSL."),
    procedure(
        "CurrentLine ([ line ])",
        "Возвращает или задаёт номер строки вывода."
    ),
    procedure("UserNumber ()", "Возвращает номер пользователя в сети."),
    procedure("Random ([ integer ]): Integer", "Возвращает случайное число."),
    procedure(
        "SetDefMoneyPrec (newVal:Integer):Integer",
        "Задаёт число знаков после запятой для Money."
    ),
    procedure(
        "ShowDictError (show:Bool):Bool",
        "Управляет выводом сообщений о несоответствии словаря."
    ),
    procedure(
        "ShowRSCOMError (obj:TRsComErr)",
        "Показывает ошибки RSCOM в диалоговом окне."
    ),
    procedure(
        "StartProg (fileName:String [, cmdLine:String ] [, " +
            "detached:Bool]):Integer",
        "Запускает приложение на терминале или сервере."
    ),
    procedure(
        "StrongRef (par:Object):Object",
        "Возвращает сильную ссылку на объект."
    ),
    procedure(
        "SysGetProperty (key:String):String",
        "Возвращает значение глобального свойства."
    ),
    procedure(
        "SysPutProperty (key:String, val:String):Bool",
        "Задаёт значение глобального свойства."
    ),
    procedure(
        "System (Number:Integer, CodeFor:Integer|Type:String [, " +
            "CmdArgs:String])",
        "Запускает системный модуль подсистемы."
    ),
    procedure(
        "IsStandAlone",
        "Определяет двухуровневый режим работы приложения."
    ),
    procedure(
        "TestEvent ([pause])",
        "Возвращает код нажатой клавиши или ноль."
    ),
    procedure(
        "AddEvent (key:Integer)",
        "Добавляет клавиатурное сообщение в очередь."
    ),
    procedure("IsGUI: Bool", "Проверяет графическую среду выполнения."),
    procedure(
        "ErrPrint (...)",
        "Печатает параметры в стандартный поток ошибок."
    ),
    procedure(
        "ErrBox (str:TArray [, caption:String, flags:Integer]) : Integer",
        "Показывает диалоговое окно со списком строк."
    ),
    procedure(
        "ModuleFileName ([moduleName:String] [, " +
            "moduleType:@Integer]):String",
        "Возвращает имя файла модуля."
    ),
    procedure(
        "ModuleName ([symbolName:string]):string",
        "Возвращает имя модуля, где объявлен символ."
    ),
    procedure("CmdArgs : String", "Возвращает параметры командной строки."),
    procedure("GetUserName : String", "Возвращает имя текущего пользователя."),
    procedure("IsSQL : Bool", "Проверяет SQL-версию RSL."),
    procedure("UnderRCWHost : Bool", "Проверяет исполнение модулем RCWHost."),
    procedure(
        "GetLocaleInfo (id:Integer, code:Integer [, " +
            "isLocal:Bool]) : String",
        "Возвращает региональную настройку."
    ),
    procedure(
        "GetLangId (id:Integer [, isLocal:Bool]) : Integer",
        "Возвращает идентификатор языка."
    ),
    procedure(
        "ZeroValue (valtp:Integer):Variant",
        "Возвращает нулевое значение для кода типа."
    ),
    procedure(
        "StartShellProgram (fileName:Char):Integer",
        "Открывает файл зарегистрированным в ОС приложением."
    ),
];

const CLASS_DEFINITIONS: readonly IRslBuiltinDefinition[] = [
    classDef("TArray", "Динамический массив RSL.", [
        property("Size", "Integer", "Размер массива."),
        property("MarshalByVal", "Bool", "Режим передачи массива."),
        method(
            "Sort",
            "(callback, data)",
            "Bool",
            "Сортирует элементы массива."
        )
    ]),
    classDef("TRslError", "Информация об ошибке RSL.", [
        property("Code", "Integer", "Код ошибки."),
        property("Message", "String", "Текст ошибки."),
        property("Module", "String", "Имя модуля."),
        property("Line", "Integer", "Номер строки."),
        property("AxCode", "Integer", "Код ошибки ActiveX."),
        property("AxMes", "String", "Текст ошибки ActiveX."),
        property("err", "Object", "Пользовательская ошибка.")
    ]),
    classDef("TBFile", "Таблица или файл базы данных.", [
        method("AddFilter", "(cond: String)", "Bool", "Добавляет фильтр."),
        method("DropFilter", "()", "Bool", "Удаляет фильтр."),
        method("GetFldInfo", "()", "TArray", "Возвращает сведения о полях."),
        method("GetKeyInfo", "()", "TArray", "Возвращает сведения о ключах."),
        method("Clear", "()", "Bool", "Очищает буфер записи."),
        method("Delete", "([flag: Bool])", "Bool", "Удаляет текущую запись."),
        method(
            "GetDirect",
            "([recpos: Integer])",
            "Bool",
            "Читает запись по позиции."
        ),
        method("GetPos", "()", "Integer", "Возвращает позицию записи."),
        method("GetEQ", "()", "Bool", "Ищет запись с равным ключом."),
        method("GetGE", "()", "Bool", "Ищет запись с не меньшим ключом."),
        method("GetGT", "()", "Bool", "Ищет запись с большим ключом."),
        method("GetLE", "()", "Bool", "Ищет запись с не большим ключом."),
        method("GetLT", "()", "Bool", "Ищет запись с меньшим ключом."),
        method("Insert", "(...)", "Bool", "Добавляет запись."),
        method("Next", "()", "Bool", "Переходит к следующей записи."),
        method("Prev", "()", "Bool", "Переходит к предыдущей записи."),
        method("Rewind", "()", "Bool", "Сбрасывает позицию чтения."),
        method("Update", "(...)", "Bool", "Обновляет текущую запись."),
        method("ReadBlob", "(value)", "Bool", "Читает BLOB."),
        method("WriteBlob", "(value)", "Bool", "Записывает BLOB."),
        method("SetRecordAddr", "(...)", "Bool", "Связывает буфер записи."),
        method(
            "PackVarBuff",
            "([size: Integer])",
            "Bool",
            "Упаковывает переменный буфер."
        ),
        method(
            "UnPackVarBuff",
            "()",
            "Bool",
            "Распаковывает переменный буфер."
        ),
        property("Rec", "Record", "Текущая запись."),
        property("KeyNum", "Integer", "Номер текущего ключа."),
        property("NRecords", "Integer", "Количество записей."),
        property("FileName", "String", "Имя файла."),
        property("RecSize", "Integer", "Размер записи."),
        property("VarSize", "Integer", "Размер переменной части.")
    ]),
    classDef(
        "TRecHandler",
        "Структура записи как объект — альтернатива RECORD.",
        [
            property("Rec", "Record", "Связанная запись."),
            method(
                "SetRecordAddr",
                "(file, ind, offs, isFix)",
                "Bool",
                "Связывает структуру с буфером записи файла."
            )
        ]
    ),
    classDef(
        "TVarRecord",
        "Запись с переменной частью ограниченной длины.",
        [
            property(
                "varPart",
                "TRecHandler",
                "Переменная часть; доступна после setVarPartFormat."
            ),
            method(
                "setVarPartFormat",
                "(structName: String, [dicName: String])",
                "Bool",
                "Задаёт формат переменной части из словаря."
            )
        ],
        "TRecHandler"
    ),
    classDef(
        "RsdEnvironment",
        "Окружение RSD: драйвер, соединения и коллекция ошибок.",
        [
            property("Driver", "String", "Имя интерфейса драйвера."),
            property("Library", "String", "Имя файла драйвера ODBC."),
            property("ErrorCount", "Integer", "Количество ошибок в коллекции."),
            property("Error", "RsdError", "Ошибка по индексу."),
            method(
                "Open",
                "([driver: String], [library: String])",
                "Bool",
                "Открывает окружение и загружает драйвер."
            ),
            method("Close", "()", "Bool", "Закрывает окружение."),
            method("ClearErrors", "()", "Bool", "Очищает коллекцию ошибок.")
        ]
    ),
    classDef("RsdConnection", "Соединение с источником данных ODBC.", [
        property("Environment", "RsdEnvironment", "Окружение соединения."),
        property("ConString", "String", "Строка соединения или имя DSN."),
        property("User", "String", "Имя пользователя."),
        property("Password", "String", "Пароль пользователя."),
        method("Open", "()", "Bool", "Открывает соединение."),
        method("Close", "()", "Bool", "Закрывает соединение."),
        method("BeginTrans", "()", "Bool", "Начинает транзакцию."),
        method("CommitTrans", "()", "Bool", "Фиксирует транзакцию."),
        method("RollbackTrans", "()", "Bool", "Откатывает транзакцию."),
        method(
            "IsInTrans",
            "()",
            "Bool",
            "Проверяет, выполняется ли транзакция."
        )
    ]),
    classDef("RsdCommand", "SQL-запрос к источнику данных.", [
        property("Connection", "RsdConnection", "Соединение команды."),
        property("CmdText", "String", "Текст команды."),
        property("CursorType", "Integer", "Тип курсора набора данных."),
        property("BlockSize", "Integer", "Число записей за одно обращение."),
        property("NullConversion", "Bool", "Преобразовывать спецзначения в NULL."),
        property("ParamCount", "Integer", "Количество параметров команды."),
        property("Param", "RsdParameter", "Параметр по индексу или имени."),
        property("Value", "Variant", "Значение параметра по индексу или имени."),
        method(
            "Execute",
            "([parm1], [parm2], ...)",
            "RsdRecordset",
            "Выполняет команду с именованными параметрами."
        ),
        method(
            "AddParam",
            "(name: String, [dir: Integer], [val], [len: Integer])",
            "RsdParameter",
            "Добавляет в команду именованный параметр."
        ),
        method(
            "DeleteParam",
            "(indexOrName)",
            "Bool",
            "Удаляет параметр по номеру или имени."
        ),
        method(
            "RefreshParams",
            "()",
            "Bool",
            "Заполняет параметры из хранимой процедуры."
        ),
        method("Close", "()", "Bool", "Закрывает команду.")
    ]),
    classDef("RsdRecordset", "Набор записей результата SQL-запроса.", [
        property("Command", "RsdCommand", "Команда, породившая набор."),
        property("CursorLocation", "Integer", "Местоположение курсора."),
        property("CursorType", "Integer", "Тип курсора."),
        property("BOF", "Bool", "Позиция до первой записи."),
        property("EOF", "Bool", "Позиция после последней записи."),
        property("BookMark", "Variant", "Закладка текущей записи."),
        property("FldCount", "Integer", "Количество полей в наборе."),
        property("Fld", "RsdField", "Поле по номеру или имени."),
        property("Value", "Variant", "Значение поля по номеру или имени."),
        property("RecCount", "Integer", "Количество записей; –1 для динамического курсора."),
        property("PageSize", "Integer", "Число записей в странице кэша."),
        property("MaxPages", "Integer", "Предел страниц кэша в памяти."),
        property("AutoRefresh", "RsdCommand", "Команда автоматического обновления записи."),
        property("InsertCommand", "RsdCommand", "Пользовательская команда вставки."),
        property("UpdateCommand", "RsdCommand", "Пользовательская команда изменения."),
        property("DeleteCommand", "RsdCommand", "Пользовательская команда удаления."),
        property("InsupdCommand", "RsdCommand", "Команда чтения данных после вставки."),
        method("Open", "()", "Bool", "Открывает набор данных."),
        method("Close", "()", "Bool", "Закрывает набор данных."),
        method("MoveFirst", "()", "Bool", "Переходит к первой записи."),
        method("MoveLast", "()", "Bool", "Переходит к последней записи."),
        method("MoveNext", "()", "Bool", "Переходит к следующей записи."),
        method("MovePrev", "()", "Bool", "Переходит к предыдущей записи."),
        method(
            "Move",
            "(numRec, moveDirect)",
            "Bool",
            "Переходит к записи по смещению или закладке."
        ),
        method("AddNew", "()", "Bool", "Вставляет новую запись."),
        method("Edit", "()", "Bool", "Начинает редактирование текущей записи."),
        method("Update", "()", "Bool", "Сохраняет изменения записи."),
        method("CancelEdit", "()", "Bool", "Отменяет ввод или редактирование."),
        method("Delete", "()", "Bool", "Удаляет запись из набора."),
        method(
            "AddUserCmdParam",
            "(nameParm: String, nameField: String, versionValue: Integer)",
            "Bool",
            "Добавляет параметр пользовательской команде набора."
        )
    ]),
    classDef("RsdError", "SQL-ошибка при работе с базой данных.", [
        property("Code", "Integer", "Код ошибки."),
        property("Descr", "String", "Описание ошибки."),
        property("Source", "String", "Тип объекта, где произошла ошибка.")
    ]),
    classDef("RsdField", "Поле набора записей RSD.", [
        property("Name", "String", "Имя поля."),
        property("Value", "Variant", "Значение поля."),
        property("BlobFilename", "String", "Файл для чтения и записи BLOB."),
        property("NullVal", "Variant", "Значение вместо NULL из SQL."),
        method(
            "Read",
            "(out, [count: Integer])",
            "Bool",
            "Читает поле типа BLOB."
        ),
        method(
            "Write",
            "(value, [count: Integer])",
            "Bool",
            "Записывает поле типа BLOB."
        )
    ]),
    classDef("RsdParameter", "Именованный параметр SQL-запроса.", [
        property("Name", "String", "Наименование параметра."),
        property("Direction", "Integer", "Входящий, исходящий или возвращаемый."),
        property("Type", "Integer", "Тип параметра."),
        property("Value", "Variant", "Значение параметра."),
        method(
            "SetSelfAlloc",
            "([...])",
            "Variant",
            "Управляет внутренним буфером."
        ),
        method(
            "SetStatusPtr",
            "(pStatus)",
            "Variant",
            "Управляет внутренним буфером."
        )
    ]),
    classDef("TStream", "Двоичный поток файла или RSCOM-объекта.", [
        property("Name", "String", "Имя файла потока либо null."),
        property("Stream", "Object", "RSCOM-объект с интерфейсом IRsStream."),
        method(
            "Write",
            "(from, [type: Integer], [size: Integer], [decPoint: Integer])",
            "Bool",
            "Записывает в поток значение заданного типа."
        ),
        method(
            "Read",
            "(out, [type: Integer], [size: Integer], [decPoint: Integer])",
            "Bool",
            "Читает из потока значение заданного типа."
        ),
        method(
            "Write2",
            "(from: Object)",
            "Bool",
            "Записывает в поток структуру записи."
        ),
        method(
            "Read2",
            "(to: Object)",
            "Bool",
            "Читает из потока структуру записи."
        ),
        method(
            "WriteVal",
            "(from)",
            "Bool",
            "Записывает значение вместе с его типом."
        ),
        method(
            "ReadVal",
            "(to)",
            "Bool",
            "Читает значение, сохранённое WriteVal."
        ),
        method(
            "Copy",
            "(from: Object, [numBytes: Integer])",
            "Bool",
            "Копирует данные из другого потока."
        ),
        method(
            "SetPos",
            "(pos: Integer, [from: Integer])",
            "Bool",
            "Устанавливает позицию в потоке."
        ),
        method(
            "GetPos",
            "()",
            "Integer",
            "Возвращает позицию от начала потока."
        ),
        method(
            "SetSize",
            "(size: Integer)",
            "Bool",
            "Устанавливает размер потока."
        ),
        method("GetSize", "()", "Integer", "Возвращает размер потока."),
        method(
            "Flush",
            "()",
            "Bool",
            "Сбрасывает несохранённые изменения на диск."
        )
    ]),
    classDef("TStreamDoc", "Текстовый поток строк с признаком конца строки.", [
        property("Name", "String", "Имя файла потока либо null."),
        property("Stream", "Object", "RSCOM-объект с интерфейсом IRsStream."),
        property("Str", "String", "Строка, прочитанная последним ReadLine."),
        method(
            "WriteLine",
            "(value: String)",
            "Bool",
            "Записывает строку и признак конца строки."
        ),
        method(
            "ReadLine",
            "(result: @String)",
            "Bool",
            "Читает строку без признака конца строки."
        ),
        method(
            "WriteVal",
            "(from)",
            "Bool",
            "Записывает значение вместе с его типом."
        ),
        method(
            "ReadVal",
            "(to)",
            "Bool",
            "Читает значение, сохранённое WriteVal."
        ),
        method(
            "Flush",
            "()",
            "Bool",
            "Сбрасывает несохранённые изменения на диск."
        )
    ]),
    classDef("TDirList", "Список файлов и каталогов, отобранных по маске.", [
        property("Count", "Integer", "Количество элементов в списке."),
        method("Name", "(index: Integer)", "String", "Имя файла или каталога."),
        method("Size", "(index: Integer)", "Integer", "Размер файла."),
        /* SizeEx в руководстве не описан; оставлен как известное расширение. */
        method(
            "SizeEx",
            "(index: Integer)",
            "Integer",
            "Размер файла без ограничения 2 ГБ."
        ),
        method(
            "FDate",
            "(index: Integer)",
            "Date",
            "Дата последней модификации."
        ),
        method(
            "FTime",
            "(index: Integer)",
            "Time",
            "Время последней модификации."
        ),
        method(
            "IsDir",
            "(index: Integer)",
            "Bool",
            "Элемент является каталогом."
        ),
        method(
            "IsCopy",
            "(index: Integer)",
            "Bool",
            "Файл был успешно скопирован."
        ),
        method("IsDel", "(index: Integer)", "Bool", "Файл был успешно удалён."),
        method(
            "Copy",
            "(srcMask: String, attr: String, dstDir: String, " +
                "[move: Bool], [indic: Bool], [header: String])",
            "Bool",
            "Копирует отобранные по маске файлы в каталог."
        ),
        method(
            "List",
            "(mask: String, [attr: String], [newSizeMode: Bool])",
            "Bool",
            "Наполняет список файлами по маске."
        ),
        method(
            "Remove",
            "(mask: String, [attr: String])",
            "Bool",
            "Удаляет отобранные по маске файлы."
        ),
        method(
            "Sort",
            "([sortBy: Integer], [dirFirst: Bool])",
            "Bool",
            "Сортирует список по имени, размеру или дате."
        )
    ]),
    classDef("TRslEvHandler", "Обработчик событий ActiveX-объектов.", [
        property("EvSource", "Object", "Коллекция объектов — источников событий."),
        property("TypeLib", "Object", "Файл библиотеки типов источников."),
        method(
            "SetHandler",
            "(pref, proc, id)",
            "Bool",
            "Связывает событие с процедурой обработки."
        ),
        method(
            "RemHandler",
            "(pref, id)",
            "Bool",
            "Разрывает связь события и обработчика."
        ),
        method(
            "Raise",
            "(...)",
            "Bool",
            "Возбуждает событие объекта Object RSL."
        )
    ]),
    classDef("RslTimer", "Таймеры для вызова обработчиков по интервалу.", [
        method(
            "SetTimer",
            "(timeout: Integer, id: Integer, handler, [isSys: Bool])",
            "Bool",
            "Устанавливает таймер с заданным интервалом."
        ),
        method(
            "RemTimer",
            "(id: Integer)",
            "Bool",
            "Удаляет таймер по идентификатору."
        )
    ]),
    classDef("TRepForm", "Отчёт по текстовому шаблону форм.", [
        method(
            "Value",
            "(nameOrId)",
            "Variant",
            "Значение поля по имени или номеру."
        ),
        method("Index", "(name: String)", "Integer", "Номер поля по имени."),
        method(
            "Field",
            "(nameOrId)",
            "TPattFieldR",
            "Поле по имени или номеру."
        ),
        method(
            "newLine",
            "()",
            "Bool",
            "Отделяет одну форму отчёта от другой."
        ),
        method(
            "writeFields",
            "(name: String, col: Integer, data, flags: Integer, " +
                "w: Integer, p: Integer)",
            "Bool",
            "Выводит поля формы в отчёт."
        )
    ]),
    classDef("TPattFieldR", "Поле формы отчёта из файла шаблона.", [
        property("Name", "String", "Имя поля."),
        property("Value", "Variant", "Значение, связанное с полем."),
        property("Attr", "Integer", "Выравнивание: влево, вправо, по центру.")
    ]),
    classDef(
        "ToolsDataAdapter",
        "Произвольный источник данных для RunScroll.",
        [
            method(
                "setCurrentRecord",
                "(rec: TRecHandler)",
                "Bool",
                "Задаёт объект с текущей записью набора."
            ),
            method(
                "getColumnsInfo",
                "()",
                "TArray",
                "Визуальные атрибуты колонок."
            ),
            method(
                "getLastStatus",
                "()",
                "Integer",
                "Код последней ошибки источника."
            ),
            method(
                "getFileName",
                "()",
                "String",
                "Имя файла источника данных."
            ),
            method("moveFirst", "()", "Bool", "Переходит к первой записи."),
            method("moveLast", "()", "Bool", "Переходит к последней записи."),
            method("moveNext", "()", "Bool", "Переходит к следующей записи."),
            method("movePrev", "()", "Bool", "Переходит к предыдущей записи."),
            method("moveToBookmark", "(bmk)", "Bool", "Переходит к закладке."),
            method("getBookmark", "()", "Variant", "Закладка текущей записи."),
            method(
                "RecordInsert",
                "()",
                "Bool",
                "Вставляет запись в источник."
            ),
            method(
                "RecordUpdate",
                "()",
                "Bool",
                "Обновляет запись в источнике."
            ),
            method(
                "RecordDelete",
                "()",
                "Bool",
                "Удаляет запись из источника."
            ),
            method(
                "AddColumn",
                "(name, head, width, kind, dec)",
                "Bool",
                "Добавляет колонку в описание набора."
            ),
            method("prepareColumns", "()", "Bool", "Готовит описание колонок."),
            method(
                "initCurRecord",
                "()",
                "Bool",
                "Инициализирует текущую запись."
            ),
            method(
                "initAdapter",
                "()",
                "Bool",
                "Инициализирует источник данных."
            )
        ]
    ),
    classDef("TRslChanel", "Канал связи с сервером приложений RSCOM.", [
        property("Name", "String", "Имя канала; повторное имя переиспользуется."),
        property("Protocol", "String", "Протокол соединения."),
        property("Server", "String", "Имя сервера приложений."),
        property("KeyPath", "String", "Путь к ключу соединения."),
        property("PipeName", "String", "Имя именованного канала."),
        property("Ip", "String", "IP-адрес сервера."),
        property("Spx", "String", "Адрес SPX."),
        property("NBPref", "String", "Префикс NetBIOS."),
        property("Lana", "Integer", "Номер адаптера NetBIOS."),
        property("Port", "Integer", "Порт сервера."),
        property("TermNumber", "Integer", "Номер терминала."),
        property("User", "String", "Имя пользователя."),
        property("Domain", "String", "Домен пользователя."),
        property("Password", "String", "Пароль пользователя."),
        property("HostApp", "String", "Имя приложения-хоста."),
        method("Connect", "()", "Bool", "Соединяется с сервером приложений."),
        method(
            "LoadConfig",
            "(iniFile: String)",
            "Bool",
            "Загружает параметры соединения из ini-файла."
        )
    ]),
    classDef(
        "TRcwSite",
        "Обработчик интерактивных сообщений от RcwHost.",
        []
    ),
    classDef("TRsAxServer", "Сервер создания ActiveX-объектов.", [
        method(
            "CreateComObject",
            "(progID: String, [useActive: Bool], [evId])",
            "Object",
            "Создаёт ActiveX-объект по программному идентификатору."
        )
    ]),
    classDef("TRcwHost", "Экземпляр интерпретатора RSL через RSCOM.", [
        property("Version", "String", "Номер версии модуля."),
        property("SQLMode", "Bool", "Модуль является SQL-модулем."),
        method(
            "AttachSite",
            "(site: TRcwSite)",
            "Bool",
            "Устанавливает объект обработки сообщений."
        ),
        method("DetachSite", "()", "Bool", "Удаляет ранее установленный сайт."),
        method(
            "AddModule",
            "(moduleName: String)",
            "Bool",
            "Загружает RSL-модуль в интерпретатор."
        ),
        method("Execute", "()", "Bool", "Исполняет загруженные модули."),
        method(
            "Stop",
            "()",
            "Bool",
            "Деинициализирует экземпляр интерпретатора."
        ),
        method(
            "TestExist",
            "(moduleName: String)",
            "Bool",
            "Проверяет, загружен ли модуль в память."
        ),
        method(
            "Call",
            "(methodName: String, par1, par2, ...)",
            "Variant",
            "Вызывает процедуру, конструктор или читает переменную."
        )
    ]),
    classDef("TClrHost", "Хост .NET: создание объектов из сборок.", [
        method(
            "CreateCLRObject",
            "(assembly: String, className: String)",
            "Object",
            "Создаёт объект класса .NET из сборки."
        )
    ]),
    classDef(
        "TJavaHost",
        "Доступ к Java-машине через RSCOM.",
        []
    ),
    classDef("TJavaObj", "Объект Java, полученный от TJavaHost.", [])
];

/*
 * Константы интерактивного режима: сообщения диалога, коды возврата обработчика
 * и параметры окна сообщения.
 *
 * Числовых значений здесь нет намеренно: руководство их не приводит ни в разделе
 * «Поддержка интерактивного режима», ни в описании MsgBoxEx. Придумать их можно
 * было бы по аналогии с Turbo Vision, откуда конструкция происходит, но
 * подставить в подсказку неподтверждённое число хуже, чем не подставить ничего:
 * пользователь сравнит его с полученным от системы и получит неверный ответ.
 * Поэтому у констант есть тип и описание, а значение появится, когда найдётся
 * источник, который его называет.
 */
const DIALOG_MESSAGE_CONSTANTS: readonly IRslBuiltinDefinition[] = [
    constant(
        "DLG_PREINIT",
        "Первое сообщение: панель создана, но не отображена. При его " +
            "обработке создаётся область прокрутки процедурой AddScroll."
    ),
    constant(
        "DLG_INIT",
        "Панель готова к отображению: можно выполнить инициализацию и " +
            "установить фокус ввода процедурой SetFocus."
    ),
    constant("DLG_INREC", "Фокус ввода установлен в текущее поле."),
    constant("DLG_OUTREC", "Фокус ввода переносится из текущего поля."),
    constant("DLG_REMFOCUS", "Фокус ввода вот-вот уйдёт из поля обработчика."),
    constant(
        "DLG_SETFOCUS",
        "Фокус ввода вот-вот будет установлен в текущее поле."
    ),
    constant("DLG_KEY", "Пользователь нажал клавишу на клавиатуре."),
    constant("DLG_BUTTON", "Пользователь щёлкнул мышью на экранной кнопке."),
    constant("DLG_MOUSE", "Пользователь работает мышью."),
    constant(
        "DLG_TIMER",
        "Истёк интервал, установленный последним вызовом SetTimer."
    ),
    constant(
        "DLG_SAVE",
        "Запрос на выход из диалога с сохранением внесённых изменений."
    ),
    constant(
        "DLG_DESTROY",
        "Окно вот-вот будет удалено с экрана; в параметре key передаётся " +
            "статус завершения: 0 — без сохранения, 1 — с сохранением."
    ),
    constant(
        "DLG_INLOOP",
        "Вход панели или области прокрутки в цикл выборки сообщений."
    ),
    constant(
        "DLG_OUTLOOP",
        "Выход панели или области прокрутки из цикла выборки сообщений."
    ),
    constant(
        "DLG_SWITCH",
        "Переключение между скроллингом и панелью; обработчик может вернуть " +
            "CM_IGNORE и отменить переключение."
    ),
    constant(
        "DLG_MSELSTART",
        "Начало обработки выделенных записей; GetMultiCount возвращает их " +
            "количество."
    ),
    constant("DLG_MSEL", "Очередная выделенная запись стала текущей."),
    constant("DLG_MSELEND", "Обработка выделенных записей завершена.")
];

const DIALOG_RESULT_CONSTANTS: readonly IRslBuiltinDefinition[] = [
    constant(
        "CM_DEFAULT",
        "Выполнить действия по умолчанию. Возвращается обработчиком, который " +
            "сообщение не обрабатывает."
    ),
    constant(
        "CM_CANCEL",
        "Завершить работу с диалоговым окном без сохранения изменений; для " +
            "DLG_OUTREC и DLG_REMFOCUS — запретить перенос фокуса."
    ),
    constant(
        "CM_SAVE",
        "Завершить работу с диалоговым окном и сохранить изменения."
    ),
    constant(
        "CM_IGNORE",
        "Игнорировать нажатие клавиши или кнопки; при DLG_INIT — запретить " +
            "автоматическую установку фокуса ввода."
    ),
    constant(
        "CM_INSERT",
        "Вставить новую запись в область прокрутки, встроенную в диалоговую " +
            "панель, где клавиша [F9] занята выходом с сохранением."
    ),
    constant(
        "CM_SELECT",
        "Закрыть окно прокрутки, запущенное процедурой RunScroll, с выбором " +
            "текущей записи."
    ),
    constant(
        "CM_UPDATE_ADDSCROLL",
        "Обновить скроллинг, добавленный процедурой AddScroll."
    ),
    constant(
        "CM_MSEL_CONT_CLEAR",
        "Продолжить обработку выделенных записей, сняв выделение с текущей."
    ),
    constant(
        "CM_MSEL_STOP_KEEP",
        "Прервать обработку выделенных записей, сохранив выделение текущей."
    ),
    constant(
        "CM_MSEL_STOP_CLEAR",
        "Прервать обработку выделенных записей, сняв выделение с текущей."
    ),
    constant(
        "CM_MSEL_STOP_CLEARALL",
        "Прервать обработку выделенных записей и снять выделение со всех."
    )
];

const MESSAGE_BOX_CONSTANTS: readonly IRslBuiltinDefinition[] = [
    constant("MB_OK", "Кнопка «ОК» в окне сообщения."),
    constant("MB_YES", "Кнопка «Да» в окне сообщения."),
    constant("MB_NO", "Кнопка «Нет» в окне сообщения."),
    constant("MB_CANCEL", "Кнопка «Отмена» в окне сообщения."),
    constant(
        "MB_ERROR",
        "Цвет фона окна сообщения, применяемый для сообщений об ошибках."
    ),
    constant("IND_OK", "Кнопка «ОК» выбрана по умолчанию или нажата."),
    constant("IND_YES", "Кнопка «Да» выбрана по умолчанию или нажата."),
    constant("IND_NO", "Кнопка «Нет» выбрана по умолчанию или нажата."),
    constant("IND_CANCEL", "Кнопка «Отмена» выбрана по умолчанию или нажата."),
    constant("IND_ERROR", "Код ошибки выполнения процедуры MsgBoxEx.")
];

export const RSL_STANDARD_LIBRARY: readonly IRslBuiltinDefinition[] =
    Object.freeze([
        ...CLASS_DEFINITIONS,
        ...PROCEDURE_DEFINITIONS,
        ...DIALOG_MESSAGE_CONSTANTS,
        ...DIALOG_RESULT_CONSTANTS,
        ...MESSAGE_BOX_CONSTANTS
    ]);

/**
 * Константа интерактивного режима.
 *
 * Тип Integer: все они сравниваются с числовыми параметрами обработчика и
 * возвращаются из него. Значение не указывается — см. комментарий выше.
 */
function constant(
    name: string,
    summary: string
): IRslBuiltinDefinition {
    return {
        name,
        kind: CompletionItemKind.Constant,
        typeName: "Integer",
        summary
    };
}

function procedure(
    signature: string,
    summary: string
): IRslBuiltinDefinition {
    const name = signature.match(/^([^\s(:[]+)/)?.[1] || signature;
    return {
        name,
        kind: CompletionItemKind.Function,
        typeName: TRAILING_TYPE.exec(signature)?.[1] || "Variant",
        signature: balancedSignature(signature)
            ? signature
            : `${name}(...)`,
        summary
    };
}

function balancedSignature(value: string): boolean {
    const stack: string[] = [];
    const pairs: Readonly<Record<string, string>> = {
        ")": "(",
        "]": "[",
        "}": "{"
    };
    for (const character of value) {
        if (character === "(" || character === "[" || character === "{") {
            stack.push(character);
        } else if (character in pairs && stack.pop() !== pairs[character]) {
            return false;
        }
    }
    return stack.length === 0;
}

function classDef(
    name: string,
    summary: string,
    children: readonly IRslBuiltinDefinition[] = [],
    base?: string
): IRslBuiltinDefinition {
    return {
        name,
        kind: CompletionItemKind.Class,
        typeName: name,
        signature: `${name}(...)`,
        summary,
        base,
        children
    };
}

/**
 * Метод класса: имя, параметры, тип результата и описание — по отдельности.
 *
 * Раньше всё это лежало одной строкой, и тип результата вынимался из неё
 * регулярным выражением. Тип нужен не только подсказке, но и выводу типа
 * переменной, которой присвоили результат вызова, — то есть это факт каталога,
 * а не оформление подписи, и объявляться он должен так же явно, как у property.
 *
 * Параметры со скобками: в этом виде их ждёт Signature Help (parameterText) и в
 * этом же виде их даёт разбор пользовательских Macro, так что встроенные и свои
 * методы описываются одинаково.
 */
function method(
    name: string,
    parameters: string,
    typeName: string,
    summary: string
): IRslBuiltinDefinition {
    return {
        name,
        kind: CompletionItemKind.Method,
        typeName,
        /* Подпись собирается из частей: разойтись с ними она уже не может. */
        signature: typeName && typeName !== "Variant"
            ? `${name}${parameters}: ${typeName}`
            : `${name}${parameters}`,
        summary
    };
}

function property(
    name: string,
    typeName: string,
    summary: string
): IRslBuiltinDefinition {
    return {
        name,
        kind: CompletionItemKind.Property,
        typeName,
        summary
    };
}
