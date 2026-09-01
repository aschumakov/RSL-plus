"use strict";

/**
 * Договор о настройках: package.json — клиент — сервер.
 *
 * Настройка проходит через три независимых места: объявление в package.json,
 * чтение в клиенте и разбор на сервере. Пропуск в любом из них не ломает ни
 * сборку, ни один существующий тест: настройка видна в интерфейсе VS Code и
 * просто ничего не делает.
 *
 * Так уже было четыре раза — redundantImports, unknownVariables, файлы
 * известных имён, unknownSpecialVariables, — а затем ещё и с unknownMembers:
 * пользователь выключал проверку неизвестных членов, клиент этого не пересылал,
 * сервер получал undefined и оставлял проверку включённой. Комментарий в
 * clientSettings.ts требовал перечислять все настройки, но требование
 * соблюдалось вручную.
 *
 * Здесь оно проверяется машиной, причём в обе стороны и вместе со значениями
 * по умолчанию.
 */

const assert = require("assert");
const path = require("path");
const Module = require("module");

const ROOT = path.join(__dirname, "..");

const serverModulePath = require.resolve("../server/out/server");

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const {
    normalizeDiagnosticSettings
} = require("../server/out/diagnostics");

/*
 * Клиент собран под VS Code и требует модуль vscode, которого вне редактора
 * нет. Подменяется только он: читается настоящий clientSettings.js, тот самый,
 * что уходит в поставку.
 */
const reads = [];
const vscodeStub = {
    workspace: {
        getConfiguration: (section) => ({
            get: (key, fallback) => {
                reads.push({ section, key, fallback });

                return fallback;
            }
        })
    },
    Uri: { file: (value) => ({ fsPath: value }) }
};

const load = Module._load;

Module._load = function (request, ...rest) {
    if (request === "vscode") {
        return vscodeStub;
    }

    return load.call(this, request, ...rest);
};

const { readRslSettings } = require("../client/out/clientSettings");

Module._load = load;

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

/** Объявленные настройки: полный ключ -> описание из package.json. */
function declaredSettings() {
    const manifest = require(path.join(ROOT, "package.json"));
    const configuration = manifest.contributes.configuration;
    const properties = Array.isArray(configuration)
        ? Object.assign({}, ...configuration.map(item => item.properties))
        : configuration.properties;
    const result = new Map();

    for (const [key, value] of Object.entries(properties)) {
        result.set(key, value);
    }

    return result;
}

const DECLARED = declaredSettings();

/** Значение по умолчанию объявленной настройки. */
function declaredDefault(key) {
    const property = DECLARED.get(key);

    return property && property.default;
}

/*
 * Настройки, которые клиент читает не через readRslSettings.
 *
 * Каждая — с причиной: иначе список превращается в способ обойти проверку.
 */
const SEPARATE = new Map([
    [
        "rslPlus.performance.logFile",
        "путь журнала передаётся отдельным полем initializationOptions"
    ],
    [
        "rslPlus.editor.completeBlocksOnEnter",
        "поведение клавиши Enter: живёт в клиенте, серверу не нужно"
    ]
]);

/* Что клиент действительно прочитал: ключ без префикса -> fallback. */
reads.length = 0;
readRslSettings();

const READ = new Map(reads.map(item => [item.key, item.fallback]));

test("клиент читает настройки одной секцией rslPlus", () => {
    const sections = Array.from(new Set(reads.map(item => item.section)));

    assert.deepStrictEqual(
        sections,
        ["rslPlus"],
        "чтение из чужой секции сделало бы сверку по ключам неверной"
    );
});

test("каждая объявленная настройка доходит до сервера", () => {
    const missing = [];

    for (const key of DECLARED.keys()) {
        if (SEPARATE.has(key)) {
            continue;
        }

        if (!READ.has(key.replace(/^rslPlus\./u, ""))) {
            missing.push(key);
        }
    }

    assert.deepStrictEqual(
        missing,
        [],
        "объявлены, но клиентом не читаются, — значит не работают: " +
        missing.join(", ")
    );
});

test("клиент не читает того, чего нет в package.json", () => {
    const unknown = Array.from(READ.keys())
        .map(key => "rslPlus." + key)
        .filter(key => !DECLARED.has(key));

    assert.deepStrictEqual(
        unknown,
        [],
        "читается, но не объявлено — опечатка в имени: " + unknown.join(", ")
    );
});

test("значения по умолчанию у клиента и в package.json совпадают", () => {
    const drifted = [];

    for (const [key, fallback] of READ) {
        const declared = declaredDefault("rslPlus." + key);

        try {
            assert.deepStrictEqual(fallback, declared);
        } catch {
            drifted.push(
                key + ": клиент " + JSON.stringify(fallback) +
                ", package.json " + JSON.stringify(declared)
            );
        }
    }

    assert.deepStrictEqual(
        drifted,
        [],
        "расхождение умолчаний: " + drifted.join("; ")
    );
});

/*
 * Значение, отличное от умолчания.
 *
 * Берётся из самого объявления: у настройки с перечислением — первое значение
 * списка, не равное умолчанию. Гадать нельзя: `unknownSpecialVariables`
 * принимает off|assigned|all, и выдуманное «warn» нормализуется в умолчание —
 * проверка сообщила бы о дефекте там, где его нет.
 */
function otherValue(property) {
    const declared = property.default;

    if (Array.isArray(property.enum)) {
        const other = property.enum.find(value => value !== declared);

        assert.notStrictEqual(
            other,
            undefined,
            "у перечисления обязано быть хотя бы два значения"
        );

        return other;
    }

    if (typeof declared === "boolean") {
        return !declared;
    }

    if (typeof declared === "number") {
        return declared === 7 ? 8 : 7;
    }

    if (property.type === "object") {
        return { "debug-break": "none" };
    }

    return "иное-значение";
}

test("сервер учитывает каждую настройку диагностик", () => {
    const base = normalizeDiagnosticSettings({});
    const ignored = [];

    for (const [full, property] of DECLARED) {
        if (!full.startsWith("rslPlus.diagnostics.")) {
            continue;
        }

        const key = full.replace("rslPlus.diagnostics.", "");
        const changed = normalizeDiagnosticSettings({
            [key]: otherValue(property)
        });

        try {
            assert.notDeepStrictEqual(changed[key], base[key]);
        } catch {
            ignored.push(key);
        }
    }

    assert.deepStrictEqual(
        ignored,
        [],
        "присланы, но сервером не учтены: " + ignored.join(", ")
    );
});

console.log(
    failed === 0
        ? "\nПройдено: " + passed
        : "\nПройдено: " + passed + ", провалено: " + failed
);

if (failed > 0) {
    process.exitCode = 1;
}
