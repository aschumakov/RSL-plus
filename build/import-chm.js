"use strict";

/**
 * Пополнение каталога прикладных модулей из справки RSLENG.chm.
 *
 * Состав классов в справке разложен по нескольким топикам: сам класс несёт
 * конструктор и СВОЙСТВА, а методы вынесены в топики-продолжения
 * `<модуль>_class_<класс>_pr_<N>.htm` («Методы класса …», «Методы поиска» и так
 * далее). Прежнее извлечение читало только часть первого топика, поэтому,
 * например, у RsbPayment из 271 члена в каталог попали 52 — без всех свойств
 * Payer* и Receiver*, то есть без самого платежа.
 *
 * Скрипт НИЧЕГО не удаляет: он добавляет отсутствующие члены и заполняет пустые
 * описания. Правки, сделанные руками (исправленные типы, снятые дубликаты
 * стандартных классов), таким образом сохраняются.
 *
 *   node build/import-chm.js <каталог-распакованного-chm>          — отчёт
 *   node build/import-chm.js <каталог> --write                     — записать
 *
 * Распаковать CHM: 7z x -o<каталог> RSLENG.chm
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

        if (!match) {
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
    const name = (keyword && keyword[1].trim()) ||
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
            "Укажите каталог распакованного RSLENG.chm:\n" +
            "  7z x -o<каталог> RSLENG.chm\n" +
            "  node build/import-chm.js <каталог> [--write]"
        );
        process.exitCode = 1;
        return;
    }

    const index = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    const moduleByKey = new Map(
        Object.keys(index.modules).map(name => [name.toLowerCase(), name])
    );
    const topics = readModuleTopics(chmDirectory);
    const parsedByModule = new Map();

    for (const entry of topics.values()) {
        const moduleName = moduleByKey.get(entry.moduleKey);

        if (!moduleName) {
            continue;
        }

        const parsed = parseClass(chmDirectory, entry);

        if (!parsed || parsed.members.length === 0) {
            continue;
        }

        const list = parsedByModule.get(moduleName) || [];
        list.push(parsed);
        parsedByModule.set(moduleName, list);
    }

    let addedMembers = 0;
    let addedClasses = 0;
    let filledDescriptions = 0;
    const report = [];

    for (const [moduleName, parsedClasses] of parsedByModule) {
        const file = path.join(DIRECTORY, index.modules[moduleName].file);
        const body = JSON.parse(fs.readFileSync(file, "utf8"));
        body.classes = body.classes || [];
        let moduleAdded = 0;

        for (const parsed of parsedClasses) {
            const existing = body.classes.find(item =>
                item.name.toLowerCase() === parsed.name.toLowerCase()
            );

            if (!existing) {
                body.classes.push({
                    name: parsed.name,
                    base: parsed.base,
                    summary: parsed.summary,
                    members: parsed.members
                });
                addedClasses++;
                moduleAdded += parsed.members.length;
                addedMembers += parsed.members.length;
                report.push(
                    `${moduleName}.${parsed.name}: новый класс, ` +
                    `${parsed.members.length} членов`
                );
                continue;
            }

            const known = new Set(
                (existing.members || []).map(item => item.name.toLowerCase())
            );
            const missing = parsed.members.filter(item =>
                !known.has(item.name.toLowerCase())
            );

            for (const member of (existing.members || [])) {
                if (member.description) {
                    continue;
                }
                const source = parsed.members.find(item =>
                    item.name.toLowerCase() === member.name.toLowerCase()
                );

                if (source?.description) {
                    member.description = source.description;
                    filledDescriptions++;
                }
            }

            if (missing.length > 0) {
                existing.members = (existing.members || []).concat(missing);
                addedMembers += missing.length;
                moduleAdded += missing.length;
                report.push(
                    `${moduleName}.${parsed.name}: ` +
                    `${existing.members.length - missing.length} -> ` +
                    `${existing.members.length} членов`
                );
            }

            if (!existing.base && parsed.base) {
                existing.base = parsed.base;
                report.push(
                    `${moduleName}.${parsed.name}: база ${parsed.base}`
                );
            }
        }

        if (write && moduleAdded > 0) {
            index.modules[moduleName].classes = body.classes.length;
            fs.writeFileSync(file, JSON.stringify(body), "utf8");
        }
    }

    report.sort();
    report.slice(0, 40).forEach(line => console.log(`  ${line}`));

    if (report.length > 40) {
        console.log(`  ... ещё ${report.length - 40}`);
    }

    console.log(
        `\nНовых классов: ${addedClasses}, новых членов: ${addedMembers}, ` +
        `заполнено описаний: ${filledDescriptions}`
    );

    if (write) {
        fs.writeFileSync(
            INDEX_FILE,
            `${JSON.stringify(index, null, 1)}\n`,
            "utf8"
        );
        console.log("Каталог обновлён.");
    } else {
        console.log("Это отчёт. Для записи добавьте --write");
    }
}

module.exports = { decodeCp1251, toText, parseClass, readModuleTopics };

if (require.main === module) {
    main();
}
