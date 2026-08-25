"use strict";

/*
 * Жизнь Problems от правки до исчезновения подчёркивания.
 *
 * Проверяется через настоящие службы сервера: анализ документа, движок
 * диагностик и координатор публикаций. Отдельные фазы по тестам выглядели
 * исправными и раньше — а пользователь видел, как межфайловая ошибка исчезает
 * и появляется снова.
 */

const assert = require("assert");

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { getDefaults } = require("../server/out/defaults");
const {
    RslDiagnosticEngine
} = require("../server/out/diagnostics/diagnosticEngine");
const {
    DiagnosticsCoordinator
} = require("../server/out/diagnostics/diagnosticsCoordinator");
const {
    RslSettingsService
} = require("../server/out/services/settingsService");
const {
    TextDocument
} = require("../server/node_modules/vscode-languageserver-textdocument");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

const MAIN = "file:///d:/lifecycle/main.mac";
const LIB = "file:///d:/lifecycle/lib.mac";
const LIB_SOURCE = "Macro Helper(value)\n  return value;\nEnd;\n";

const SETTINGS = {
    language: { dialect: "rsBank" },
    imports: { enabled: true },
    autoImport: { enabled: true },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    diagnostics: {}
};

/**
 * Координатор с настоящим движком; разбор выполняется сразу.
 *
 * readLib: false оставляет lib.mac непрочитанным — так выглядит файл
 * сразу после открытия, пока Import-замыкание ещё грузится.
 */
function createStand(source, options = {}) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, LIB]);

    if (options.readLib !== false) {
        index.updateExternalModule(LIB, LIB_SOURCE, 1);
    }

    let document = TextDocument.create(MAIN, "rsl", 1, source);
    index.updateOpenModule(MAIN, source, 1);

    const documents = {
        get: uri => (uri === MAIN ? document : undefined),
        all: () => [document]
    };
    const publications = [];
    const settings = new RslSettingsService(SETTINGS);
    const coordinator = new DiagnosticsCoordinator(
        { sendDiagnostics: value => publications.push(value) },
        documents,
        index,
        settings,
        new RslDiagnosticEngine(),
        {
            isParseBusy: () => false,
            waitForIdle: async () => undefined,
            log: () => undefined,
            onImports: () => undefined,
            resolver: new RslScopeResolver(index, getDefaults())
        }
    );
    coordinator.setActiveDocument(MAIN);

    return {
        publications,
        coordinator,
        index,
        /** Настройки меняются так же, как из окна параметров. */
        applySettings(next) {
            settings.updateFromConfiguration({
                rslPlus: {
                    ...SETTINGS,
                    ...next,
                    diagnostics: {
                        ...SETTINGS.diagnostics,
                        ...(next.diagnostics || {})
                    }
                }
            });
        },
        get document() {
            return document;
        },
        /** Правка: новая версия документа и новая модель. */
        change(next) {
            document = TextDocument.create(
                MAIN,
                "rsl",
                document.version + 1,
                next
            );
            index.updateOpenModule(MAIN, next, document.version);
        }
    };
}

function codes(publication) {
    return (publication.diagnostics || []).map(item => item.code);
}

async function settle(milliseconds = 400) {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
}

const WITH_UNUSED_IMPORT = [
    "Import lib;",
    "Macro Test()",
    "  Var value = 1;",
    "  value = value + 1;",
    "End;",
    ""
].join("\n");

const USES_IMPORT = [
    "Import lib;",
    "Macro Test()",
    "  Var value = 1;",
    "  value = Helper(value);",
    "End;",
    ""
].join("\n");

const WITH_LOCAL_ERROR = [
    "Import lib;",
    "Macro Test()",
    "  Var value = 1;",
    "  value = value..field;",
    "End;",
    ""
].join("\n");

test("межфайловая ошибка не исчезает из-за локального пересчёта", async () => {
    const stand = createStand(WITH_LOCAL_ERROR);
    stand.coordinator.scheduleLocal(MAIN, 0);
    stand.coordinator.scheduleWorkspace(MAIN, 0);
    await settle();

    const initial = stand.publications[stand.publications.length - 1];
    assert.ok(
        codes(initial).includes("unused-import"),
        "межфайловая ошибка обязана быть показана: " + codes(initial).join(", ")
    );

    /* Правка исправляет ЛОКАЛЬНУЮ ошибку; Import по-прежнему не используется. */
    const before = stand.publications.length;
    stand.change(WITH_UNUSED_IMPORT);
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    const after = stand.publications.slice(before);
    assert.ok(after.length > 0, "публикация после правки обязана быть");

    for (const publication of after) {
        assert.ok(
            codes(publication).includes("unused-import"),
            "межфайловая ошибка не имеет права пропадать на время " +
                "локального пересчёта: " + codes(publication).join(", ")
        );
    }
});

test("локальная ошибка исчезает после правки", async () => {
    const stand = createStand(WITH_LOCAL_ERROR);
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    assert.ok(
        codes(stand.publications[stand.publications.length - 1])
            .includes("missing-member-name"),
        "ошибка обязана появиться"
    );

    stand.change(WITH_UNUSED_IMPORT);
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    assert.ok(
        !codes(stand.publications[stand.publications.length - 1])
            .includes("missing-member-name"),
        "после правки ошибки быть не должно"
    );
});

test("после появления вызова Import не остаётся неиспользуемым", async () => {
    /*
     * Ответ межфайловых проверок зависит от всего текста файла. Вызов,
     * добавленный ниже, делает `unused-import` неверным, хотя диапазон
     * находки не сдвинулся ни на символ: перенести её на новый текст —
     * значит показать несуществующую ошибку.
     */
    const stand = createStand(WITH_UNUSED_IMPORT);
    stand.coordinator.scheduleLocal(MAIN, 0);
    stand.coordinator.scheduleWorkspace(MAIN, 0);
    await settle();

    assert.ok(
        codes(stand.publications[stand.publications.length - 1])
            .includes("unused-import"),
        "сначала Import действительно не используется"
    );

    const before = stand.publications.length;
    stand.change(USES_IMPORT);
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    const after = stand.publications.slice(before);
    assert.ok(after.length > 0, "публикация после правки обязана быть");

    for (const publication of after) {
        assert.ok(
            !codes(publication).includes("unused-import"),
            "Import используется — находки о нём быть не может: " +
                codes(publication).join(", ")
        );
    }
});

test("межфайловая ошибка не переносится на правленый текст", async () => {
    /*
     * Правка в самой первой строке сдвигает весь текст ниже. Старое
     * межфайловое подчёркивание указывало бы уже на другой код, а номер
     * версии в публикации говорил бы клиенту, что список актуален. Такую
     * находку показывать нельзя — она вернётся после пересчёта.
     */
    const stand = createStand(WITH_UNUSED_IMPORT);
    stand.coordinator.scheduleLocal(MAIN, 0);
    stand.coordinator.scheduleWorkspace(MAIN, 0);
    await settle();

    assert.ok(
        codes(stand.publications[stand.publications.length - 1])
            .includes("unused-import"),
        "межфайловая находка обязана быть показана"
    );

    /* Import убран: находка о нём относится к тексту, которого уже нет. */
    const before = stand.publications.length;
    stand.change(WITH_UNUSED_IMPORT
        .split("\n")
        .slice(1)
        .join("\n"));
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    const after = stand.publications.slice(before);
    assert.ok(after.length > 0, "публикация после правки обязана быть");

    for (const publication of after) {
        assert.ok(
            !codes(publication).includes("unused-import"),
            "старая межфайловая находка не имеет права выходить с новой " +
                "версией: " + codes(publication).join(", ")
        );
        assert.strictEqual(
            publication.version,
            stand.document.version,
            "публикуется список именно для текущей версии"
        );
    }
});

test("снятая галочка проверок убирает межфайловую находку сразу", async () => {
    /*
     * Текст не менялся, поэтому прежний результат по нему формально
     * подходит — но считался он при других настройках. Показывать его
     * значит показывать проверку, которую пользователь только что выключил.
     */
    const stand = createStand(WITH_UNUSED_IMPORT);
    stand.coordinator.scheduleLocal(MAIN, 0);
    stand.coordinator.scheduleWorkspace(MAIN, 0);
    await settle();

    assert.ok(
        codes(stand.publications[stand.publications.length - 1])
            .includes("unused-import"),
        "сначала находка обязана быть"
    );

    stand.applySettings({
        diagnostics: { unusedImports: false }
    });

    /*
     * Локальная фаза заканчивается первой — и уже она не имеет права взять
     * межфайловый результат, посчитанный при прежних настройках.
     */
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle(80);

    assert.ok(
        !codes(stand.publications[stand.publications.length - 1])
            .includes("unused-import"),
        "выключенная проверка не имеет права оставаться в списке"
    );
});

test("выключенные проверки очищают список сразу", async () => {
    const stand = createStand(WITH_LOCAL_ERROR);
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    assert.ok(
        codes(stand.publications[stand.publications.length - 1]).length > 0,
        "сначала ошибки обязаны быть"
    );

    stand.applySettings({ diagnostics: { enabled: false } });
    stand.coordinator.scheduleLocal(MAIN, 0);

    const last = stand.publications[stand.publications.length - 1];

    assert.deepStrictEqual(
        last.diagnostics,
        [],
        "список обязан опустеть без ожидания пересчёта"
    );
});

/*
 * Объявление приезжает из импортированного модуля — без правки файла.
 *
 * Проверка необъявленной переменной идёт в локальной фазе, а переменную
 * может объявлять и импортированный модуль. Пока модуль не прочитан,
 * находка не публикуется; когда он прочитан или изменился, локальная фаза
 * пересчитывается — её ключ включает состояние импортов. Прежде результат
 * зависел от момента загрузки и держался до следующей правки файла.
 */
test("объявление из импортированного модуля доходит без правки файла", async () => {
    const source = [
        "Import lib;",
        "Macro Test()",
        "  Var known = 1;",
        "  shared = known;",
        "End;",
        ""
    ].join(String.fromCharCode(10));
    const stand = createStand(source, { readLib: false });
    const undeclared = () => {
        const last = stand.publications[stand.publications.length - 1];

        return (last?.diagnostics || [])
            .filter(item => item.code === "undeclared-variable")
            .map(item => String(item.data.name));
    };

    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();
    assert.deepStrictEqual(
        undeclared(),
        [],
        "Пока lib.mac не прочитан, ошибку показывать не на чем"
    );

    /* Модуль прочитан и объявляет переменную: правки файла не было. */
    stand.index.updateExternalModule(
        LIB,
        "Var shared;" + String.fromCharCode(10),
        1
    );
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();
    assert.deepStrictEqual(undeclared(), []);

    /* Переменную из модуля убрали — ошибка появляется сама. */
    stand.index.updateExternalModule(
        LIB,
        "Var renamed;" + String.fromCharCode(10),
        2
    );
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();
    assert.deepStrictEqual(
        undeclared(),
        ["shared"],
        "Изменение импортированного модуля обязано дойти без правки файла"
    );
    assert.strictEqual(
        stand.document.version,
        1,
        "Файл при этом не менялся"
    );
});

test("публикация несёт версию документа", async () => {
    const stand = createStand(WITH_LOCAL_ERROR);
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    const last = stand.publications[stand.publications.length - 1];
    assert.strictEqual(
        last.version,
        stand.document.version,
        "клиент обязан знать, для какой версии посчитан список"
    );

    /*
     * Тот же по составу список после правки публикуется заново: у клиента
     * иначе осталась бы его собственная, сдвинутая копия подчёркиваний.
     */
    const before = stand.publications.length;
    stand.change(WITH_LOCAL_ERROR + "\n");
    stand.coordinator.scheduleLocal(MAIN, 0);
    await settle();

    const republished = stand.publications.slice(before);
    assert.ok(
        republished.length > 0,
        "публикация для новой версии обязана быть даже при том же составе"
    );
    assert.strictEqual(
        republished[republished.length - 1].version,
        stand.document.version
    );
});

(async () => {
    for (const item of planned) {
        try {
            await item.action();
            passed++;
            console.log("[OK] " + item.name);
        } catch (error) {
            failed++;
            console.error("[FAIL] " + item.name);
            console.error(error);
        }
    }

    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exit(1);
    }
})();
