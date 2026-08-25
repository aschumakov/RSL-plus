"use strict";

/**
 * Пополнение каталога прикладных модулей из справки.
 *
 * Состав модуля разложен по страницам трёх видов: классы, процедуры и группы
 * констант. Константы встречаются и вне своей группы — перечисленными в
 * описании метода или процедуры, которая их принимает; такие тоже собираются
 * (см. parseInlineConstants). Какому модулю принадлежит страница, известно из оглавления справки
 * — по имени файла это не определяется: страницы `wldinter_*` описывают
 * WIdInter, `calendar_ret_*` — Календарь, `total_mac_*` — total.
 *
 * Состав класса, в свою очередь, разложен по нескольким топикам: сам класс
 * несёт конструктор и СВОЙСТВА, а методы вынесены в продолжения
 * `<модуль>_class_<класс>_pr_<N>.htm` («Методы класса …», «Методы поиска» и так
 * далее). Прежнее извлечение читало только часть первого топика, поэтому,
 * например, у RsbPayment из 271 члена в каталог попали 52 — без всех свойств
 * Payer* и Receiver*, то есть без самого платежа.
 *
 * Имена бывают и кириллическими: процедура ПолучитьИнформациюПоДокументу — имя
 * не хуже прочих, и в подсказке она нужна наравне с латинскими.
 *
 * Скрипт НИЧЕГО не удаляет: он добавляет отсутствующие члены и заполняет пустые
 * описания. Правки, сделанные руками (исправленные типы, снятые дубликаты
 * стандартных классов), таким образом сохраняются.
 *
 *   node build/import-chm.js <каталог-распакованного-chm>          — отчёт
 *   node build/import-chm.js <каталог> --write                     — записать
 *
 * Распаковать CHM: 7z x -o<каталог> <файл справки>
 */

const fs = require("fs");
const path = require("path");

const DIRECTORY = path.join(__dirname, "..", "platform-modules");
const INDEX_FILE = path.join(DIRECTORY, "index.json");

/* 0x80..0xBF; дальше 0xC0..0xFF линейно отображаются в U+0410..U+044F. */
const CP1251_HIGH =
    "ЂЃ‚ѓ„…†‡" +
    "€‰Љ‹ЊЌЋЏ" +
    "ђ‘’“”•–—" +
    "�™љ›њќћџ" +
    " ЎўЈ¤Ґ¦§" +
    "Ё©Є«¬­®Ї" +
    "°±Ііґµ¶·" +
    "ё№є»јЅѕї";

function decodeCp1251(buffer) {
    let result = "";

    for (const byte of buffer) {
        if (byte < 0x80) {
            result += String.fromCharCode(byte);
        } else if (byte < 0xC0) {
            result += CP1251_HIGH[byte - 0x80];
        } else {
            result += String.fromCharCode(0x0410 + (byte - 0xC0));
        }
    }

    return result;
}

const ENTITIES = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'",
    laquo: "«", raquo: "»", mdash: "—", ndash: "–",
    hellip: "…", ldquo: "«", rdquo: "»", bdquo: "«",
    deg: "°"
};

function toText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h\d|td|th)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&(#?\w+);/g, (match, name) => {
            if (name in ENTITIES) return ENTITIES[name];
            if (/^#x/i.test(name)) {
                return String.fromCharCode(parseInt(name.slice(2), 16));
            }
            if (name.startsWith("#")) {
                return String.fromCharCode(Number(name.slice(1)));
            }
            return match;
        })
        .replace(/[ \t ]+/g, " ");
}

/** Одно предложение описания: длинные тексты в подсказке не читают. */
function shortSummary(value) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const sentence = /^(.*?[.;])(\s|$)/.exec(normalized);
    const text = (sentence ? sentence[1] : normalized).replace(/[;]$/, ".");
    return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

/*
 * Тип из текста свойства.
 *
 * Справка называет тип тремя способами: «; тип String.», «Свойство имеет тип
 * String», «Объект класса RsbCrossRate». Опечатки в типах исправляются здесь же —
 * тот же список, что применялся к данным руками.
 */
const TYPE_FIXES = {
    long: "Integer",
    number: "Integer",
    intege: "Integer",
    booll: "Bool",
    raw: "Bool",
    "objeсм": "Object",
    /*
     * «Char» и «Bdate» справка пишет для номера счёта и даты завершения
     * договора: таких типов в RSL нет, а рядом однотипные свойства объявлены
     * как String и Date. Это опечатки справки, а не отдельные типы.
     */
    char: "String",
    bdate: "Date"
};

/*
 * Написание примитивных типов берётся из справочника языка: справка пишет их
 * по-разному («MoneyL» и «Moneyl» в одном классе), а в подсказке тип должен
 * выглядеть одинаково.
 */
function primitiveDisplayNames() {
    try {
        /* eslint-disable-next-line global-require */
        const reference = require("../server/out/language/rslLanguageReference");
        return reference.PRIMITIVE_TYPE_DISPLAY_NAMES;
    } catch (error) {
        return new Map();
    }
}

const DISPLAY_NAMES = primitiveDisplayNames();

/**
 * Классы стандартной библиотеки.
 *
 * Справка описывает их и в разделах модулей — например TVarRecord в
 * AcquirerObjects. Добавленный в модуль, такой класс затеняет полное описание
 * стандартной библиотеки: разрешение базы начинается с модуля-владельца.
 */
function standardLibraryClasses() {
    const result = new Set();

    try {
        /* eslint-disable-next-line global-require */
        const { getDefaults } = require("../server/out/defaults");

        for (const item of getDefaults().completionItems) {
            result.add(String(item.label || "").toLowerCase());
        }
    } catch (error) {
        console.warn(
            "Стандартная библиотека не загружена (нужен npm run compile): " +
            "дубликаты её классов не будут отсеяны."
        );
    }

    return result;
}

const STANDARD_CLASSES = standardLibraryClasses();

function normalizeTypeName(value) {
    const text = String(value || "").trim().replace(/[.,;]$/, "");
    const fixed = TYPE_FIXES[text.toLowerCase()] || text;
    return DISPLAY_NAMES.get(fixed.toLowerCase()) || fixed;
}

function propertyType(description) {
    const explicit =
        /(?:^|[;,.]\s*)(?:свойство\s+)?(?:имеет\s+)?тип[а]?\s+([A-Za-z_][A-Za-z0-9_]*)/i
            .exec(description);

    if (explicit) {
        return normalizeTypeName(explicit[1]);
    }

    const objectOf = /объект\s+класса\s+([A-Za-z_][A-Za-z0-9_]*)/i
        .exec(description);
    return objectOf ? normalizeTypeName(objectOf[1]) : "Variant";
}

/** Топики модуля: основной топик класса и его продолжения. */
function readModuleTopics(chmDirectory) {
    const files = fs.readdirSync(chmDirectory)
        .filter(file => file.endsWith(".htm"));
    const classes = new Map();

    for (const file of files) {
        const match = /^(.+?)_class_(.+?)(?:_(?:pr|meth)_\d+)?\.htm$/
            .exec(file);

        if (!match) {
            continue;
        }

        const key = `${match[1]}|${match[2]}`;
        const entry = classes.get(key) || {
            moduleKey: match[1],
            topicName: match[2],
            main: undefined,
            continuations: []
        };

        if (/_(?:pr|meth)_\d+\.htm$/.test(file)) {
            entry.continuations.push(file);
        } else {
            entry.main = file;
        }
        classes.set(key, entry);
    }

    return classes;
}

/*
 * Оглавление справки: к какому модулю относится страница.
 *
 * По имени файла модуль не определяется: страницы `wldinter_class_*` лежат в
 * разделе WIdInter, `calendar_ret_proc_*` — в Календаре, `total_mac_*` — в
 * total. Прежде состав брался только из `<модуль>_class_*.htm` и только для
 * модулей, уже описанных в каталоге, поэтому мимо проходили процедуры модулей,
 * группы констант и целые модули без классов — ReportInter, RX_Exchange,
 * BalanceInter.
 */
/* Класс \w кириллицу не покрывает: «Модуль» после \w* обрывается на «ь». */
const MODULE_TITLES = [
    /^Модул[а-яё]*\s+(\S+)/iu,
    /(?:стандартн[а-яё]*\s+(?:RSL-)?|Макропроцедуры\s+)модул[а-яё]*\s+(\S+)/iu
];

/* Имя модуля пишут и латиницей, и кириллицей, и с расширением: total.mac. */
const MODULE_NAME =
    /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*(?:\.[A-Za-z0-9]+)?$/u;

/** Модуль, названный в заголовке раздела; пустая строка, если не назван. */
function moduleTitle(name) {
    for (const pattern of MODULE_TITLES) {
        const found = pattern.exec(name);

        if (found && MODULE_NAME.test(found[1])) {
            return found[1];
        }
    }

    return "";
}

/** Узлы оглавления в порядке обхода с уровнем вложенности. */
function readContentsNodes(chmDirectory) {
    const file = path.join(chmDirectory, "RSLENG.hhc");

    if (!fs.existsSync(file)) {
        return [];
    }

    const text = decodeCp1251(fs.readFileSync(file));
    const nodes = [];
    let depth = 0;

    for (const piece of text.split(/(<UL>|<\/UL>|<LI>)/i)) {
        const tag = piece.trim().toUpperCase();

        if (tag === "<UL>") {
            depth++;
            continue;
        }

        if (tag === "</UL>") {
            depth--;
            continue;
        }

        const name = /<param name="Name" value="([^"]*)"/i.exec(piece);

        if (!name) {
            continue;
        }

        const page = /<param name="Local" value="([^"]*)"/i.exec(piece);
        nodes.push({
            name: toText(name[1]).trim(),
            page: page ? page[1].toLowerCase() : "",
            depth
        });
    }

    return nodes;
}

/**
 * Разбор оглавления: модуль страницы, корневая страница модуля и признак
 * раздела констант.
 *
 * Константы отличаются от прочих перечислений именно разделом: страница
 * «Виды документов» — это константы BankInter, а внешне такой же список
 * встречается и в описании параметров метода.
 */
function readContents(chmDirectory) {
    const ownerByPage = new Map();
    const rootByModule = new Map();
    const constantPages = new Set();
    /*
     * Топики классов из оглавления, а не по имени файла: класс TDepClient
     * описан на `tclientlist.htm`, без `_class_` в имени, и прежним отбором не
     * читался вовсе — в каталоге от него остался один член.
     */
    const classTopics = [];
    /* Модуль и раздел констант, объявленные на каждом уровне вложенности. */
    const owners = [];
    const inConstants = [];
    const nodes = readContentsNodes(chmDirectory);
    /* Открытый топик класса: следующие узлы глубже — его продолжения. */
    let openClass;

    for (const node of nodes) {
        owners.length = node.depth;
        inConstants.length = node.depth;
        const own = moduleTitle(node.name);
        owners[node.depth] = own;
        inConstants[node.depth] = /^(?:\S+\s+)?константы$/iu.test(node.name);
        const owner = owners.filter(Boolean).pop() || "";

        if (!node.page || !owner) {
            continue;
        }

        ownerByPage.set(node.page, owner);

        if (own && !rootByModule.has(owner)) {
            rootByModule.set(owner, node.page);
        }

        if (inConstants.some(Boolean)) {
            constantPages.add(node.page);
        }

        const declared = /^Класс\s+([A-Za-z_][A-Za-z0-9_]*)$/u.exec(node.name);

        if (declared) {
            openClass = {
                module: owner,
                topicName: declared[1],
                main: node.page,
                continuations: [],
                depth: node.depth
            };
            classTopics.push(openClass);
            continue;
        }

        /* Свойства и методы класса вынесены в дочерние узлы того же раздела. */
        if (openClass && node.depth > openClass.depth) {
            openClass.continuations.push(node.page);
            continue;
        }

        openClass = undefined;
    }

    return { ownerByPage, rootByModule, constantPages, classTopics };
}

/**
 * Имя модуля для каталога.
 *
 * Раздел называет модуль так, как о нём говорят: «total.mac», «Календарь». В
 * каталоге ключ — то, что пишут в Import, поэтому расширение снимается, а у
 * кириллического названия ключом становится имя его корневой страницы: у
 * Календаря это calendar, у Процентов — procent. Ровно так названы модули,
 * попавшие в каталог раньше.
 */
function moduleKeyOf(title, rootPage, known) {
    const bare = title.replace(/\.(?:mac|d32|dll)$/iu, "");

    if (known.has(bare.toLowerCase())) {
        return known.get(bare.toLowerCase());
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(bare)) {
        return bare;
    }

    const fromPage = String(rootPage || "").replace(/\.htm$/iu, "");

    return known.get(fromPage.toLowerCase()) || fromPage || bare;
}

const SECTION_TITLES =
    /^(?:Параметр|Парметр|Возвращаемое|Результат|Пример|Замечани|Примечани|Внимание|См\.)/iu;

/**
 * Процедура модуля со страницы вида «Процедура ПолучитьИнформациюПоДокументу».
 *
 * Имя берётся из заголовка страницы, а не из текста: в описании то и дело
 * встречается «Функция позволяет …», и по такому вхождению в каталог попадала
 * бы «позволяет».
 */
/*
 * Заголовок страницы процедуры. Обычно это «Процедура <Имя>», но встречается и
 * фраза — «Процедура выполнения операции из макроса MakeOperation»; имя тогда
 * стоит последним словом.
 */
const PROCEDURE_TITLE =
    /^(?:Процедура|Функция|Макропроцедура)\s+(?:.*\s)?([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)$/u;

/*
 * Объявление: тип итога пишут и через двоеточие, и просто через пробел
 * (`) Integer`), строку иногда закрывают точкой с запятой, а у процедуры без
 * параметров скобок может не быть вовсе.
 */
const PROCEDURE_DECLARATION =
    /^([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)\s*(\(.*\))\s*(?::\s*|\s+)?([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)?\s*;?$/u;

const PROCEDURE_WITHOUT_PARAMETERS =
    /^([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)\s*:\s*([A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*)\s*;?$/u;

function parseProcedure(text) {
    const lines = text.split("\n").map(line => line.trim()).filter(Boolean);
    const title = PROCEDURE_TITLE.exec(lines[0] || "");

    if (!title) {
        return undefined;
    }

    /*
     * Имя есть в трёх местах: заголовок страницы, её собственный заголовок и
     * строка объявления. Они расходятся: на странице CB_GetFormattedAcnt
     * объявление скопировано у CB_CloseAccount, а у IsHoliday опечатка ровно
     * наоборот — в заголовке страницы. Берётся то написание, которое
     * подтверждено дважды.
     */
    const heading = PROCEDURE_TITLE.exec(lines[1] || "");
    const named = value => [title[1], heading && heading[1]].some(candidate =>
        String(candidate || "").toLowerCase() === value.toLowerCase()
    );
    let declaration;
    const description = [];

    for (let at = heading ? 2 : 1; at < lines.length; at++) {
        const line = lines[at];

        if (!declaration) {
            declaration = PROCEDURE_DECLARATION.exec(line) || undefined;

            if (!declaration) {
                /*
                 * Объявление без скобок принимается, только когда имя совпало
                 * с заголовком: иначе им оказалась бы любая строка вида
                 * «Внимание: текст».
                 */
                const bare = PROCEDURE_WITHOUT_PARAMETERS.exec(line);

                if (bare && named(bare[1])) {
                    declaration = [line, bare[1], "", bare[2]];
                }
            }
            continue;
        }

        if (SECTION_TITLES.test(line)) {
            break;
        }
        description.push(line);
    }

    if (!declaration) {
        return undefined;
    }

    const same = (first, second) =>
        String(first || "").toLowerCase() === String(second || "").toLowerCase();
    const declared = declaration[1];
    const name = heading && same(declared, heading[1]) ? declared : title[1];
    const returned = declaration[3] ? normalizeTypeName(declaration[3]) : "";
    /*
     * Список параметров берётся только у своего объявления. Приписать чужие
     * параметры к процедуре нельзя: в подсказке это выглядело бы как её
     * собственная подпись.
     */
    const signature = same(declared, name)
        ? name + declaration[2].replace(/\s+/gu, " ") +
            (returned ? ":" + returned : "")
        : name;

    return {
        name,
        signature,
        description: shortSummary(description.join(" "))
    };
}

/*
 * Константа: `RSB_EV_MOUSE =2 – идентификатор события …` или без значения —
 * `RCB_VT_DATE – дата …`. Значение не домысливается: если его в справке нет,
 * поле остаётся пустым, а подпись показывает одно имя.
 */
const CONSTANT_LINE =
    /^([A-ZА-ЯЁ][A-ZА-ЯЁ0-9_]*)\s*(?:=\s*([^–—]*?)\s*)?[–—]\s*(\S.*)$/u;

/**
 * Описание константы.
 *
 * Первое предложение часто состоит из одного слова — «RCB_VT_DATE – дата.», —
 * поэтому оно дополняется следующим, пока не станет читаемым. Начинается
 * описание со строчной буквы, как продолжение имени: в подсказке оно стоит
 * отдельно, и первую букву приходится поднимать.
 */
function constantSummary(value) {
    const normalized = String(value || "").replace(/\s+/gu, " ").trim();
    let text = "";

    for (const sentence of normalized.split(/(?<=[.!?])\s+/u)) {
        text = text ? text + " " + sentence : sentence;

        if (text.length >= 20) {
            break;
        }
    }

    const capitalised = text.charAt(0).toUpperCase() + text.slice(1);
    /*
     * Пункт перечисления кончается точкой с запятой — «Исполнение платежа;»
     * — и без этого описание закрывалось второй точкой: «платежа;.».
     */
    const trimmed = capitalised.replace(/[;,]$/u, "");
    const closed = /[.!?]$/u.test(trimmed)
        ? trimmed
        : trimmed + ".";

    return closed.length > 200 ? closed.slice(0, 197) + "..." : closed;
}

/** Константы со страницы-группы. */
function parseConstants(text) {
    const result = [];

    for (const line of text.split("\n").map(item => item.trim())) {
        const found = CONSTANT_LINE.exec(line);

        if (!found || found[1].length < 2) {
            continue;
        }

        /*
         * Тип берётся только когда в скобках стоит примитивный тип RSL: в
         * скобках справки бывает что угодно, и принимать за тип любое слово
         * значило бы его выдумывать.
         */
        const parenthesised = /\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/u
            .exec(found[3]);
        const typeName = parenthesised &&
            DISPLAY_NAMES.has(parenthesised[1].toLowerCase())
            ? normalizeTypeName(parenthesised[1])
            : "";

        /*
         * В справке часть имён набрана дважды подряд — «OBJTYPE_VASTATE
         * OBJTYPE_VASTATE» без пробела, одной строкой в исходном тексте
         * страницы. Это опечатка вёрстки: такого имени в модуле нет.
         */
        const doubled = /^(.+)\1$/u.exec(found[1]);

        result.push({
            name: doubled ? doubled[1] : found[1],
            value: (found[2] || "").trim(),
            typeName,
            description: constantSummary(found[3])
        });
    }

    return result;
}

/*
 * Перечисление констант внутри описания класса или процедуры.
 *
 * Раздел констант — не единственное место, где они описаны: направление
 * параметра RSDBP_*, статус проводки ACCTRN_STATUS_*, вид округления BU_*
 * перечислены прямо в описании метода или процедуры, которая их принимает.
 * Такие страницы разбирались только как класс или процедура, и константы
 * с них в каталог не попадали — написанное по документации RSDBP_OUT
 * оказывалось в Problems незнакомым именем.
 *
 * Признак перечисления — фраза, которая его открывает: «задается одной из
 * следующих констант», «возможные значения параметра». Без неё такой же по
 * виду список — это параметры метода, а не константы.
 */
const CONSTANT_CUE = /констант|возможные значения/iu;

/*
 * Имя в перечислении: только ПРОПИСНЫЕ_С_ПОДЧЁРКИВАНИЕМ.
 *
 * Строчные и смешанные имена в тех же списках — это параметры метода
 * (`ErrCode – выходной параметр`), и принимать их за константы значило бы
 * звать в подсказке имена, которых в языке нет.
 */
const INLINE_CONSTANT_NAME = /^[A-ZА-ЯЁ][A-ZА-ЯЁ0-9]*(?:_[A-ZА-ЯЁ0-9]+)+$/u;

/*
 * Сколько строк после фразы просматривается.
 *
 * Перечисление прерывается примерами и примечаниями — у RSDBP_* между
 * RSDBP_IN_OUT и RSDBP_RETVAL лежат два примера кода, — поэтому пункты
 * ищутся в окне, а не до первой непохожей строки.
 */
const INLINE_WINDOW = 24;

function parseInlineConstants(text) {
    const lines = text.split("\n")
        .map(line => line.trim())
        .filter(Boolean);
    const result = new Map();

    for (let index = 0; index < lines.length; index++) {
        if (!CONSTANT_CUE.test(lines[index])) {
            continue;
        }

        const to = Math.min(index + INLINE_WINDOW, lines.length);
        /*
         * Конец непрерывного перечисления сразу за фразой.
         *
         * Пункт принимается либо как элемент списка (`·ИМЯ – …`), либо когда
         * он продолжает перечисление, начатое строкой после фразы. Иначе в
         * константы попадает свойство класса: у BoBankPaymentParm фраза о
         * константах стоит выше списка свойств, и `VO_FIID – идентификатор
         * валюты операции` внешне ничем не отличается от константы.
         */
        let runEnd = index;

        for (let at = index + 1; at < to; at++) {
            const bulleted = /^[·•]/u.test(lines[at]);
            const line = lines[at].replace(/^[·•]\s*/u, "");
            const found = CONSTANT_LINE.exec(line);

            if (!found || !INLINE_CONSTANT_NAME.test(found[1])) {
                continue;
            }

            if (!bulleted && at !== runEnd + 1) {
                continue;
            }

            runEnd = at;

            const previous = result.get(found[1].toLowerCase());
            const description = constantSummary(found[3]);

            if (previous && previous.description.length >= description.length) {
                continue;
            }

            result.set(found[1].toLowerCase(), {
                name: found[1],
                value: (found[2] || "").trim(),
                typeName: "",
                description
            });
        }
    }

    return [...result.values()];
}

/*
 * Спецпеременная модуля: `{GROUP_MODE} – признак пакетного выполнения
 * операции. Спецпеременная имеет тип Bool.`
 *
 * Фигурные скобки — часть имени, а внутри допустимо что угодно, включая
 * пробелы: `{Название отчета}`. Поэтому имя берётся целиком со скобками, как
 * оно и пишется в коде.
 */
const SPECIAL_VARIABLE_LINE = /^(\{[^{}\r\n]{1,60}\})\s*[–—]\s*(\S.*)$/u;

const SPECIAL_VARIABLE_TYPE =
    /(?:имеет\s+тип|тип[а]?)\s+([A-Za-z_][A-Za-z0-9_]*)/iu;

/** Спецпеременные со страницы модуля. */
function parseSpecialVariables(text) {
    const result = [];

    for (const line of text.split("\n").map(item => item.trim())) {
        const found = SPECIAL_VARIABLE_LINE.exec(line);

        if (!found) {
            continue;
        }

        const written = SPECIAL_VARIABLE_TYPE.exec(found[2]);
        /* Тип принимается только известный: угадывать по тексту нечего. */
        const typeName = written &&
            DISPLAY_NAMES.has(written[1].toLowerCase())
            ? normalizeTypeName(written[1])
            : "";

        result.push({
            name: found[1],
            typeName,
            description: constantSummary(found[2])
        });
    }

    return result;
}

/*
 * Значения, а не свойства.
 *
 * В описании свойства перечисляют, что оно может принимать: «TRUE – создается
 * новая строка адреса». Строка выглядит как объявление свойства, и TRUE
 * попадало в состав класса наравне с полями.
 */
const LITERALS = new Set(["true", "false", "null", "nil", "this", "undefined"]);

const PROPERTY_SECTION_HEADINGS = [
    "Свойства:", "Свойства класса:", "Для класса реализованы свойства:"
];

/*
 * Описание параметра метода выглядит ровно как описание свойства
 * («summaryUnit – единицы суммирования … »), поэтому секцию свойств надо
 * закрывать на первом же следующем заголовке, иначе параметры уедут в свойства.
 */
const SECTION_END_HEADINGS = [
    "Методы:", "Методы класса:", "Метод:", "Параметры:", "Параметр:",
    "Парметры:", "Параметры метода:", "Возвращаемое значение:", "Результат:",
    "Пример:"
];

/** Начало секции свойств и её конец: первый заголовок другой секции. */
function propertySectionText(text) {
    const starts = PROPERTY_SECTION_HEADINGS
        .map(heading => text.indexOf(`\n${heading}`))
        .filter(index => index >= 0);

    if (starts.length === 0) {
        return "";
    }

    const start = Math.min(...starts);
    const ends = SECTION_END_HEADINGS
        .map(heading => text.indexOf(`\n${heading}`, start + 1))
        .filter(index => index >= 0);

    return text.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
}

/** Свойства из текста топика класса. */
function parseProperties(text) {
    const section = propertySectionText(text);

    if (!section) {
        return [];
    }

    const result = [];
    const lines = section.split("\n");

    for (const line of lines) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+[–—-]\s+(.+)$/
            .exec(line);

        if (!match || LITERALS.has(match[1].toLowerCase())) {
            continue;
        }

        const description = match[2].trim();
        result.push({
            name: match[1],
            isMethod: false,
            typeName: propertyType(description),
            description: shortSummary(description)
        });
    }

    return result;
}

/** Методы: строка-сигнатура, дальше описание до следующей сигнатуры. */
function parseMethods(text) {
    const lines = text.split("\n").map(line => line.trim());
    const result = [];
    let current;

    const flush = () => {
        if (current) {
            current.description = shortSummary(current.description);
            result.push(current);
        }
    };

    for (const line of lines) {
        const signature =
            /^([A-Za-z_][A-Za-z0-9_]*)\s*(\([^()]*\))\s*(?::\s*([A-Za-z_][A-Za-z0-9_]*))?\s*$/
                .exec(line);

        /* Пример кода тоже похож на сигнатуру: у него нет описания «Метод …». */
        if (signature && !/^(if|while|for|var|return)$/i.test(signature[1])) {
            flush();
            const returnType = signature[3]
                ? normalizeTypeName(signature[3])
                : "";
            current = {
                name: signature[1],
                isMethod: true,
                signature: `${signature[1]} ${signature[2]}` +
                    (returnType ? `:${returnType}` : ""),
                description: ""
            };
            continue;
        }

        if (current && line && !current.description) {
            current.description = line;
        }
    }

    flush();
    return result.filter(item => /^(Метод|Функция|Свойство)/i.test(
        item.description
    ) || item.description === "");
}

function parseClass(chmDirectory, entry) {
    if (!entry.main) {
        return undefined;
    }

    const readText = file => toText(
        decodeCp1251(fs.readFileSync(path.join(chmDirectory, file)))
    );
    const html = decodeCp1251(
        fs.readFileSync(path.join(chmDirectory, entry.main))
    );
    const text = toText(html);
    const keyword = /<meta name="keywords" content="([^"]*)"/i.exec(html);
    const title = /Класс\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    /*
     * Ключевые слова страницы обычно и есть имя класса, но на общих страницах
     * там лежит перечень: «BeginKeyCashing,CheckBufferSign,…». Такое имя классом
     * быть не может, и тогда берётся заголовок.
     */
    const keyed = keyword && keyword[1].trim();
    const name = (/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyed || "") ? keyed : "") ||
        (title && title[1]) ||
        entry.topicName;
    const base =
        /наследник\w*\s+(?:стандартного\s+)?класса\s+([A-Za-z_][A-Za-z0-9_]*)/i
            .exec(text);
    const summaryMatch =
        /Конструктор класса[^.]*\.|Класс\s+\w+\s+(?:предназначен|представляет)[^.]*\./
            .exec(text);

    const members = new Map();
    const add = member => {
        const key = member.name.toLowerCase();

        if (!members.has(key)) {
            members.set(key, member);
        }
    };

    parseProperties(text).forEach(add);
    parseMethods(text).forEach(add);
    entry.continuations.forEach(file => {
        const continuation = readText(file);
        parseMethods(continuation).forEach(add);
        parseProperties(continuation).forEach(add);
    });

    return {
        name,
        base: base ? base[1] : undefined,
        summary: shortSummary(summaryMatch ? summaryMatch[0] : `Класс ${name}.`),
        members: Array.from(members.values())
    };
}

function main() {
    const chmDirectory = process.argv[2];
    const write = process.argv.includes("--write");

    if (!chmDirectory || !fs.existsSync(chmDirectory)) {
        console.error(
            "Укажите каталог распакованного файл справки:\n" +
            "  7z x -o<каталог> <файл справки>\n" +
            "  node build/import-chm.js <каталог> [--write]"
        );
        process.exitCode = 1;
        return;
    }

    const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    const known = new Map(
        Object.keys(index.modules).map(name => [name.toLowerCase(), name])
    );
    const contents = readContents(chmDirectory);
    const report = [];
    /* Что добавить в каждый модуль: имя модуля -> состав. */
    const additions = new Map();

    const addition = moduleName => {
        const entry = additions.get(moduleName) || {
            classes: [], procedures: [], constants: [], variables: []
        };
        additions.set(moduleName, entry);
        return entry;
    };

    /** Модуль страницы: раздел оглавления, иначе префикс имени файла. */
    const moduleOfPage = page => {
        const title = contents.ownerByPage.get(page.toLowerCase());

        if (title) {
            return moduleKeyOf(
                title,
                contents.rootByModule.get(title),
                known
            );
        }

        const prefix = /^([^_]+(?:_[^_]+)*?)_/u.exec(page);

        return prefix ? known.get(prefix[1].toLowerCase()) : undefined;
    };

    /*
     * Константы из перечисления на странице.
     *
     * Уже описанные в стандартной библиотеке пропускаются: RSDVAL_* и
     * RSDBP_* принадлежат языку, и в модуле они затенили бы описание,
     * которое видно и без Import.
     */
    const addInlineConstants = (moduleName, file) => {
        const inline = parseInlineConstants(toText(decodeCp1251(
            fs.readFileSync(file)
        ))).filter(item =>
            !STANDARD_CLASSES.has(item.name.toLowerCase())
        );

        if (inline.length > 0) {
            addition(moduleName).constants.push(...inline);
        }
    };

    /*
     * Топики классов из двух источников: имена файлов `<модуль>_class_<класс>`
     * и разделы оглавления. Второе шире — там есть классы на страницах с
     * произвольным именем, — но первое даёт продолжения `_pr_N`, которые в
     * оглавление вынесены не всегда.
     */
    const topics = [...readModuleTopics(chmDirectory).values()];
    const readTopics = new Set(topics.map(entry => (entry.main || "")));

    for (const topic of contents.classTopics) {
        if (!readTopics.has(topic.main)) {
            topics.push(topic);
        }
    }

    for (const entry of topics) {
        const moduleName = entry.main
            ? moduleOfPage(entry.main) || known.get(entry.moduleKey)
            : undefined;

        if (!moduleName) {
            continue;
        }

        const parsed = parseClass(chmDirectory, entry);

        if (parsed && parsed.members.length > 0) {
            addition(moduleName).classes.push(parsed);
        }

        /*
         * Страницы классов в общий обход ниже не попадают, а константы
         * методов описаны именно там: RSDVAL_* у курсора, ACCTRN_STATUS_*
         * у пакета проводок.
         */
        for (const page of [entry.main, ...(entry.continuations || [])]) {
            if (!page) {
                continue;
            }

            addInlineConstants(moduleName, path.join(chmDirectory, page));
        }
    }

    const pages = fs.readdirSync(chmDirectory)
        .filter(file => file.endsWith(".htm") && !/_class_/iu.test(file));

    for (const page of pages) {
        const moduleName = moduleOfPage(page);

        if (!moduleName) {
            continue;
        }

        const text = toText(decodeCp1251(
            fs.readFileSync(path.join(chmDirectory, page))
        ));

        /*
         * Спецпеременные ищутся на любой странице модуля, а не только в разделе
         * констант: в ExchangeInter они лежат на своей странице, в SbCrdInter —
         * среди глобальных переменных, а {DMONEY_MAX} — на странице констант.
         */
        const special = parseSpecialVariables(text);

        if (special.length > 0) {
            addition(moduleName).variables.push(...special);
        }

        if (contents.constantPages.has(page.toLowerCase())) {
            addition(moduleName).constants.push(...parseConstants(text));
            continue;
        }

        addInlineConstants(moduleName, path.join(chmDirectory, page));

        const procedure = parseProcedure(text);

        if (procedure) {
            addition(moduleName).procedures.push(procedure);
        }
    }

    let addedClasses = 0;
    let addedMembers = 0;
    let addedProcedures = 0;
    let addedConstants = 0;
    let addedVariables = 0;
    let addedModules = 0;
    let filledDescriptions = 0;

    for (const [moduleName, parsed] of [...additions].sort()) {
        let entry = index.modules[moduleName];

        if (!entry) {
            entry = { file: moduleName.toLowerCase() + ".json" };
            index.modules[moduleName] = entry;
            addedModules++;
            report.push(moduleName + ": новый модуль (" +
                parsed.classes.length + " классов, " +
                parsed.procedures.length + " процедур, " +
                parsed.constants.length + " констант)");
        }

        const file = path.join(DIRECTORY, entry.file);
        const body = fs.existsSync(file)
            ? JSON.parse(fs.readFileSync(file, "utf8"))
            : {
                version: index.version,
                classes: [],
                procedures: [],
                constants: [],
                variables: []
            };
        body.classes = body.classes || [];
        body.procedures = body.procedures || [];
        body.constants = body.constants || [];
        body.variables = body.variables || [];
        let changed = false;

        for (const item of parsed.classes) {
            const existing = body.classes.find(known =>
                known.name.toLowerCase() === item.name.toLowerCase()
            );

            if (!existing) {
                if (STANDARD_CLASSES.has(item.name.toLowerCase())) {
                    continue;
                }

                body.classes.push({
                    name: item.name,
                    base: item.base,
                    summary: item.summary,
                    members: item.members
                });
                addedClasses++;
                addedMembers += item.members.length;
                changed = true;
                report.push(moduleName + "." + item.name + ": новый класс, " +
                    item.members.length + " членов");
                continue;
            }

            for (const member of existing.members || []) {
                if (member.description) {
                    continue;
                }

                const source = item.members.find(candidate =>
                    candidate.name.toLowerCase() === member.name.toLowerCase()
                );

                if (source && source.description) {
                    member.description = source.description;
                    filledDescriptions++;
                    changed = true;
                }
            }

            const haveMembers = new Set(
                (existing.members || []).map(member =>
                    member.name.toLowerCase()
                )
            );
            const missing = item.members.filter(member =>
                !haveMembers.has(member.name.toLowerCase())
            );

            if (missing.length > 0) {
                existing.members = (existing.members || []).concat(missing);
                addedMembers += missing.length;
                changed = true;
                report.push(moduleName + "." + item.name + ": " +
                    (existing.members.length - missing.length) + " -> " +
                    existing.members.length + " членов");
            }

            if (!existing.base && item.base) {
                existing.base = item.base;
                changed = true;
                report.push(moduleName + "." + item.name + ": база " +
                    item.base);
            }
        }

        /*
         * Процедуры и константы добавляются так же, как члены классов: то, что
         * уже описано, не переписывается — правки, сделанные руками, остаются.
         */
        const merge = (list, parsedList, counted) => {
            const have = new Map(
                list.map(item => [item.name.toLowerCase(), item])
            );
            let added = 0;

            for (const item of parsedList) {
                const existing = have.get(item.name.toLowerCase());

                if (!existing) {
                    have.set(item.name.toLowerCase(), item);
                    list.push(item);
                    added++;
                    continue;
                }

                if (!existing.description && item.description) {
                    existing.description = item.description;
                    filledDescriptions++;
                    changed = true;
                }
            }

            if (added > 0) {
                changed = true;
                report.push(moduleName + ": " + counted + " " +
                    (list.length - added) + " -> " + list.length);
            }

            return added;
        };

        addedProcedures += merge(
            body.procedures,
            parsed.procedures.map(item => ({
                name: item.name,
                signature: item.signature,
                description: item.description
            })),
            "процедур"
        );
        addedConstants += merge(
            body.constants,
            parsed.constants.map(item => {
                const constant = {
                    name: item.name,
                    value: item.value,
                    description: item.description
                };

                if (item.typeName) {
                    constant.typeName = item.typeName;
                }

                return constant;
            }),
            "констант"
        );
        addedVariables += merge(
            body.variables,
            parsed.variables.map(item => {
                const variable = {
                    name: item.name,
                    description: item.description
                };

                if (item.typeName) {
                    variable.typeName = item.typeName;
                }

                return variable;
            }),
            "спецпеременных"
        );

        if (!write || !changed) {
            continue;
        }

        entry.classes = body.classes.length;
        entry.procedures = body.procedures.length;
        entry.constants = body.constants.length;

        /*
         * Спецпеременные в индексе — только там, где они есть.
         * Так он и был устроен: у 66 модулей из 69 поля нет вовсе, и
         * `"variables": 0` добавляло бы строку ни о чём.
         */
        if (body.variables.length > 0) {
            entry.variables = body.variables.length;
        } else {
            delete entry.variables;
        }
        fs.writeFileSync(file, JSON.stringify(body), "utf8");
    }

    report.sort();
    report.slice(0, 40).forEach(line => console.log("  " + line));

    if (report.length > 40) {
        console.log("  ... ещё " + (report.length - 40));
    }

    console.log(
        "\nНовых модулей: " + addedModules +
        ", классов: " + addedClasses +
        ", членов: " + addedMembers +
        ", процедур: " + addedProcedures +
        ", констант: " + addedConstants +
        ", спецпеременных: " + addedVariables +
        ", заполнено описаний: " + filledDescriptions
    );

    if (write) {
        fs.writeFileSync(
            INDEX_FILE,
            JSON.stringify(index, null, 1) + "\n",
            "utf8"
        );
        console.log("Каталог обновлён.");
    } else {
        console.log("Это отчёт. Для записи добавьте --write");
    }
}


module.exports = {
    decodeCp1251,
    toText,
    parseClass,
    readModuleTopics,
    readContents,
    moduleKeyOf,
    parseProcedure,
    parseConstants,
    parseInlineConstants,
    parseSpecialVariables
};

if (require.main === module) {
    main();
}
