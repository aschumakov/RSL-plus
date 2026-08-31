"use strict";

/**
 * Разбор справки: то, на чём каталог терял содержимое.
 *
 * Каждая проверка соответствует найденной причине пропуска: страницы искались
 * по имени файла и только у классов, имена принимались только латиницей, а
 * заголовок раздела с кириллицей («Модуль Календарь») не опознавался вовсе.
 * Образцы — куски настоящих страниц; распакованная справка для теста не нужна.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
    readContents, moduleKeyOf, parseProcedure, parseConstants,
    parseInlineConstants, parseSpecialVariables, toText
} = require("../build/import-chm.js");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

/** Страница справки: разметка выброшена, остаётся текст построчно. */
function page(lines) {
    return toText(lines.join("\n"));
}

const CONTENTS = [
    "<HTML><BODY>",
    "<UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Модуль ReportInter\">",
    "  <param name=\"Local\" value=\"reportinter.htm\">",
    "</OBJECT>",
    "<UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Процедура ПолучитьИнформациюПоДокументу\">",
    "  <param name=\"Local\" value=\"reportinter_proc_put_inf_doc.htm\">",
    "</OBJECT>",
    "</UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Модуль Календарь\">",
    "  <param name=\"Local\" value=\"calendar.htm\">",
    "</OBJECT>",
    "<UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Константы\">",
    "</OBJECT>",
    "<UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Виды документов\">",
    "  <param name=\"Local\" value=\"calendar_ret_kinds.htm\">",
    "</OBJECT>",
    "</UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Класс TDepClient\">",
    "  <param name=\"Local\" value=\"tdepclient.htm\">",
    "</OBJECT>",
    "<UL>",
    "<LI><OBJECT type=\"text/sitemap\">",
    "  <param name=\"Name\" value=\"Методы класса\">",
    "  <param name=\"Local\" value=\"tdepclient_met.htm\">",
    "</OBJECT>",
    "</UL>",
    "</UL>",
    "</UL>",
    "</BODY></HTML>"
].join("\n");

/* Оглавление читается из файла: тест кладёт его во временный каталог. */
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rsl-chm-"));
fs.writeFileSync(
    path.join(directory, "RSLENG.hhc"),
    Buffer.from(
        CONTENTS.split("").map(character => {
            const code = character.charCodeAt(0);

            /* Справка хранится в CP1251: кириллица кодируется обратно. */
            return code >= 0x0410 && code <= 0x044F
                ? code - 0x0410 + 0xC0
                : code;
        })
    )
);

const contents = readContents(directory);

test("страница относится к модулю своего раздела, а не к префиксу имени", () => {
    assert.strictEqual(
        contents.ownerByPage.get("reportinter_proc_put_inf_doc.htm"),
        "ReportInter"
    );
    assert.strictEqual(
        contents.ownerByPage.get("calendar_ret_kinds.htm"),
        "Календарь"
    );
});

test("кириллическое название модуля даёт ключ по корневой странице", () => {
    const known = new Map([["calendar", "calendar"]]);
    assert.strictEqual(
        moduleKeyOf("Календарь", contents.rootByModule.get("Календарь"), known),
        "calendar"
    );
    assert.strictEqual(
        moduleKeyOf("ReportInter", "reportinter.htm", known),
        "ReportInter"
    );
    /* Расширение в названии раздела ключом не становится: Import пишут без него. */
    assert.strictEqual(moduleKeyOf("total.mac", "total_mac.htm", new Map()),
        "total");
});

test("страница констант опознаётся по разделу, а не по виду списка", () => {
    assert.ok(contents.constantPages.has("calendar_ret_kinds.htm"));
    assert.ok(!contents.constantPages.has("reportinter_proc_put_inf_doc.htm"));
});

test("класс берётся и со страницы без _class_ в имени", () => {
    const topic = contents.classTopics.find(item => item.main ===
        "tdepclient.htm");
    assert.ok(topic, "топик класса не найден");
    assert.strictEqual(topic.topicName, "TDepClient");
    assert.deepStrictEqual(topic.continuations, ["tdepclient_met.htm"]);
});

test("процедура с кириллическим именем разбирается", () => {
    const parsed = parseProcedure(page([
        "Процедура ПогрешностьОкругления",
        "Процедура ПогрешностьОкругления",
        "Содержание",
        "ПогрешностьОкругления (val:Variant):MoneyL",
        "Процедура определяет погрешность округления значения.",
        "Параметры:",
        "val – значение переменной в копейках."
    ]));

    assert.strictEqual(parsed.name, "ПогрешностьОкругления");
    assert.strictEqual(parsed.signature,
        "ПогрешностьОкругления(val:Variant):MoneyL");
    assert.strictEqual(parsed.description,
        "Процедура определяет погрешность округления значения.");
});

test("тип итога через пробел и точка с запятой в конце", () => {
    const spaced = parseProcedure(page([
        "Процедура УстановитьВидыКредитов",
        "УстановитьВидыКредитов ([Crd_Kind:Integer]) Integer",
        "Процедура позволяет установить виды кредитов для отчетов."
    ]));
    assert.strictEqual(spaced.signature,
        "УстановитьВидыКредитов([Crd_Kind:Integer]):Integer");

    const closed = parseProcedure(page([
        "Процедура DepoAcc_FindClose",
        "DepoAcc_FindClose ();",
        "Процедура предназначена для окончания поиска."
    ]));
    assert.strictEqual(closed.signature, "DepoAcc_FindClose()");
});

test("процедура без скобок принимается только со своим именем", () => {
    const own = parseProcedure(page([
        "Процедура UOL_WEB_SEARCH",
        "Процедура UOL_WEB_SEARCH",
        "UOL_WEB_SEARCH:Integer",
        "Процедура предназначена для идентификации клиента."
    ]));
    assert.strictEqual(own.signature, "UOL_WEB_SEARCH:Integer");

    /* Строка «Внимание: текст» имеет тот же вид и объявлением быть не должна. */
    const foreign = parseProcedure(page([
        "Процедура SomeName",
        "Процедура SomeName",
        "Внимание: описание",
        "SomeName (value:Integer):Integer",
        "Процедура делает что-то полезное."
    ]));
    assert.strictEqual(foreign.signature, "SomeName(value:Integer):Integer");
});

test("чужое объявление не становится подписью процедуры", () => {
    const parsed = parseProcedure(page([
        "Процедура CB_GetFormattedAcnt",
        "Процедура CB_GetFormattedAcnt",
        "CB_CloseAccount (Chapter:Integer):Integer",
        "Процедура предназначена для форматирования номера лицевого счета."
    ]));

    assert.strictEqual(parsed.name, "CB_GetFormattedAcnt");
    assert.strictEqual(parsed.signature, "CB_GetFormattedAcnt");
});

test("опечатка в заголовке страницы уступает подтверждённому имени", () => {
    const parsed = parseProcedure(page([
        "Процедура IsHolyday",
        "Процедура IsHoliday",
        "IsHoliday (d:Date):Integer",
        "Процедура предназначена для проверки выходного дня."
    ]));

    assert.strictEqual(parsed.name, "IsHoliday");
});

test("имя из фразы-заголовка", () => {
    const parsed = parseProcedure(page([
        "Процедура выполнения операции из макроса MakeOperation",
        "Процедура выполнения операции из макроса MakeOperation",
        "MakeOperation (OpType:Integer):Integer",
        "Процедура выполняет операцию, заданную параметром OpType."
    ]));

    assert.strictEqual(parsed.name, "MakeOperation");
});

test("константы с значением и без него", () => {
    const parsed = parseConstants(page([
        "RSB_EV_MOUSE =2 – идентификатор события мыши.",
        "RCB_VT_DATE – дата. Используется для хранения показателей формы.",
        "OBJTYPE_VASTATEOBJTYPE_VASTATE – состояние учтенного векселя."
    ]));

    assert.strictEqual(parsed.length, 3);
    assert.deepStrictEqual(
        { name: parsed[0].name, value: parsed[0].value },
        { name: "RSB_EV_MOUSE", value: "2" }
    );
    assert.strictEqual(parsed[1].value, "");
    /* Короткое первое предложение дополняется следующим. */
    assert.strictEqual(parsed[1].description,
        "Дата. Используется для хранения показателей формы.");
    /* Имя, набранное в справке дважды подряд, — опечатка вёрстки. */
    assert.strictEqual(parsed[2].name, "OBJTYPE_VASTATE");
});

/*
 * Перечисление констант внутри описания метода.
 *
 * Так описано направление параметра RSDBP_*: не в разделе констант, а
 * пунктами списка в описании AddParam, и между пунктами стоят примеры.
 * Пока разбор их не видел, RSDBP_OUT из документации попадал в Problems
 * как необъявленное имя.
 */
test("константы из перечисления в описании метода", () => {
    const parsed = parseInlineConstants(page([
        "AddParam (name:String [, dir:Integer]) – метод добавляет в " +
            "команду именованный параметр. Метод вызывается с параметрами:",
        "·name – наименование параметра;",
        "·dir – характеристика параметра, которая задается одной из " +
            "констант.",
        "·RSDBP_IN – входящий параметр;",
        "·RSDBP_OUT – параметр может использоваться для возвращения " +
            "значения;",
        "Пример.",
        "cmd.addParam('p1', RSDBP_OUT, V_INTEGER)",
        "·RSDBP_RETVAL – параметр используется для возвращения значения " +
            "хранимой процедуры, указанной в SQL-запросе."
    ]));

    assert.deepStrictEqual(
        parsed.map(item => item.name),
        ["RSDBP_IN", "RSDBP_OUT", "RSDBP_RETVAL"],
        "Пример между пунктами не прерывает перечисление"
    );
    /* Пункт кончается точкой с запятой, описание — одной точкой. */
    assert.strictEqual(parsed[0].description, "Входящий параметр.");
    /* Строчное имя в том же списке — параметр метода, не константа. */
    assert.ok(!parsed.some(item => item.name === "name"));
});

/*
 * Список свойств класса рядом с фразой о константах.
 *
 * У BoBankPaymentParm свойства перечислены тем же видом строк, что и
 * константы, и `VO_FIID – идентификатор валюты операции` попадал в
 * каталог константой. От константы его отличает то, что он не пункт
 * списка и не продолжает перечисление, начатое сразу за фразой.
 */
test("список свойств не принимается за перечисление констант", () => {
    const parsed = parseInlineConstants(page([
        "Kind – вид документа, который задается одной из констант.",
        "Свойства:",
        "ValueDate – дата значения платежа; тип Date.",
        "VO_Accept – состояние акцепта; тип Integer.",
        "VO_FIID – идентификатор валюты операции; тип Integer."
    ]));

    assert.deepStrictEqual(parsed, []);
});

test("спецпеременные модуля: имя со скобками, тип из текста", () => {
    const parsed = parseSpecialVariables(page([
        "{GROUP_MODE} – признак пакетного выполнения операции." +
            " Спецпеременная имеет тип Bool.",
        "{BaseCur} – внутрисистемный код базовой валюты. Переменная типа Integer.",
        "{РЕЗЕРВ_ПО_ПОРТФЕЛЮ} – резерв по просроченному долгу по портфелю.",
        "{Название отчета} – название отчетной формы."
    ]));

    assert.strictEqual(parsed.length, 4);
    assert.deepStrictEqual(
        parsed.map(item => item.name),
        ["{GROUP_MODE}", "{BaseCur}", "{РЕЗЕРВ_ПО_ПОРТФЕЛЮ}", "{Название отчета}"]
    );
    assert.strictEqual(parsed[0].typeName, "Bool");
    assert.strictEqual(parsed[1].typeName, "Integer");
    /* Тип не назван — выдумывать его нечем. */
    assert.strictEqual(parsed[2].typeName, "");
});

fs.rmSync(directory, {
            recursive: true,
            force: true,
            /*
             * Повторы обязательны на Windows: rm падает с ENOTEMPTY, если
             * файл в каталоге создан только что — дескриптор ещё держится.
             */
            maxRetries: 20,
            retryDelay: 25
        });

console.log("\nПройдено: " + passed + ", провалено: " + failed);

if (failed > 0) {
    process.exitCode = 1;
}
