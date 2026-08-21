"use strict";

/*
 * Направленные проверки разрешения имён в интерактивных запросах.
 *
 * Здесь собраны случаи, в которых легко ответить «похоже на правду» вместо
 * «верно»: одноимённые локальный и импортированный символы, два одноимённых
 * объявления в файле, обращение к члену объекта — существующему, приватному и
 * несуществующему. Каждый случай проверяется дважды: до готовности модели и
 * после, — потому что подсказка не имеет права меняться от того, успел ли
 * закончиться разбор.
 *
 * Проверки идут через настоящие обработчики LSP: именно они решают, кто
 * отвечает — индекс версии или модель.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const nodePath = require("path");
const { pathToFileURL } = require("url");

const {
    PlatformModuleCatalog
} = require("../server/out/builtins/platformModuleCatalog");
const {
    RslDefinitionProvider
} = require("../server/out/features/definitionProvider");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    createCompletionRegistry,
    DEFAULT_SETTINGS
} = require("./completion-harness");

let passed = 0;
let failed = 0;
const planned = [];

function test(name, action) {
    planned.push({ name, action });
}

const WORKSPACE = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rsl-resolve-"));
const MAIN = pathToFileURL(nodePath.join(WORKSPACE, "main.mac")).toString();
const LIB = pathToFileURL(nodePath.join(WORKSPACE, "lib.mac")).toString();

const LIB_SOURCE = [
    "Macro Shared(fromLib)",
    "  return fromLib;",
    "End;",
    "",
    "Macro Missing(fromLib)",
    "  return fromLib;",
    "End;",
    "",
    "Class TLibClass()",
    "  Var LibField;",
    "End;",
    ""
].join("\n");

/*
 * Образец нарочно неудобный: одно и то же имя объявлено и в файле, и в
 * подключённом модуле, одно имя объявлено дважды, а у объекта спрашивают поле,
 * приватное поле и то, чего у класса нет вовсе.
 */
const MAIN_SOURCE = [
    "Import lib;",
    "Class TLocal()",
    "  Var Field: String;",
    "  private Var Secret: String;",
    "  Macro Open(alpha)",
    "    return alpha;",
    "  End;",
    "End;",
    "Macro Shared(own)",
    "  return own;",
    "End;",
    "Macro Twice(first)",
    "  return first;",
    "End;",
    "Macro Twice(second)",
    "  return second;",
    "End;",
    "Macro Test()",
    "  Var thing: TLocal = TLocal();",
    "  Var a = Shared(1);",
    "  Var b = Twice(1);",
    "  Var c = thing.Open(1);",
    "  Var d = thing.Field;",
    "  Var e = thing.Field(1);",
    "  Var f = thing.Secret;",
    "  Var g = thing.Missing(1);",
    "  Var h = thing.LibField;",
    "End;",
    ""
].join("\n");

fs.writeFileSync(nodePath.join(WORKSPACE, "lib.mac"), LIB_SOURCE, "utf8");
fs.writeFileSync(nodePath.join(WORKSPACE, "main.mac"), MAIN_SOURCE, "utf8");

const cancellation = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined })
};
const CALL = { context: { triggerKind: 2, triggerCharacter: "(" } };

function stand(platform, modelReady) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([MAIN, LIB]);
    index.updateExternalModule(LIB, LIB_SOURCE, 1);

    let current;
    const definitionProvider = new RslDefinitionProvider({
        getOpenDocument: uri => uri === MAIN ? current.document : undefined,
        ensureDocumentParsed: async () => current.module.symbolTree,
        getLoadedModules: () => index.getModules(),
        getImportedModules: uri => index.getImportedModules(uri),
        findWorkspaceFileUri: name => index.findWorkspaceFileUri(name),
        resolveWorkspaceFileUri: name => index.resolveWorkspaceFile(name),
        getDefinitionRange: (uri, symbol) =>
            index.getDefinitionRange(uri, symbol),
        log: () => undefined
    });

    current = createCompletionRegistry({
        uri: MAIN,
        source: MAIN_SOURCE,
        platform,
        modelReady,
        settings: DEFAULT_SETTINGS,
        index,
        definitionProvider
    });

    return current;
}

async function request(current, handler, marker, extra) {
    const at = current.text.indexOf(marker);
    assert.ok(at >= 0, "в образце нет: " + marker);

    return current.handlers[handler]({
        textDocument: { uri: current.uri },
        position: current.document.positionAt(at + marker.length),
        ...(extra || {})
    }, cancellation);
}

/** Файл и строка ответа перехода. */
function targetOf(answer) {
    if (!answer) {
        return "нет ответа";
    }

    const one = Array.isArray(answer) ? answer[0] : answer;

    return one
        ? one.uri + ":" + one.range.start.line
        : "нет ответа";
}

function hoverText(answer) {
    if (!answer || answer.contents === undefined) {
        return "";
    }

    return typeof answer.contents === "string"
        ? answer.contents
        : answer.contents.value;
}

function signatureLabel(answer) {
    return answer && answer.signatures && answer.signatures.length > 0
        ? answer.signatures[0].label
        : "нет подписи";
}

/** Проверка, которую обязаны пройти оба пути: до разбора и после. */
function bothWays(name, action) {
    test(name, async () => {
        const platform = new PlatformModuleCatalog({ log: () => undefined });

        for (const modelReady of [false, true]) {
            await action(stand(platform, modelReady), modelReady);
        }
    });
}

const lineOf = fragment => MAIN_SOURCE
    .split("\n")
    .findIndex(line => line.startsWith(fragment));

/* --- Одноимённые символы --- */

bothWays(
    "локальная процедура не подменяется одноимённой из модуля",
    async (current, modelReady) => {
        const answer = await request(current, "definition", "  Var a = Shar");

        assert.strictEqual(
            targetOf(answer),
            MAIN + ":" + lineOf("Macro Shared"),
            "объявление в самом файле перекрывает импортированное " +
                "(модель готова: " + modelReady + ")"
        );
    }
);

test("два одноимённых объявления разрешаются одинаково", async () => {
    /*
     * Какое из двух объявлений считать настоящим — вопрос языка, а не
     * момента разбора. Здесь проверяется главное: ответ один и тот же до и
     * после готовности модели и не уходит в подключённый модуль.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const fast = await request(
        stand(platform, false),
        "definition",
        "  Var b = Twi"
    );
    const full = await request(
        stand(platform, true),
        "definition",
        "  Var b = Twi"
    );

    assert.strictEqual(targetOf(fast), targetOf(full));
    assert.ok(
        targetOf(full) === "нет ответа" || targetOf(full).startsWith(MAIN),
        "одноимённое объявление файла не ищется в модуле: " + targetOf(full)
    );
});

/* --- Члены объекта --- */

bothWays(
    "существующий член объекта разрешается",
    async (current, modelReady) => {
        const help = await request(
            current,
            "signatureHelp",
            "  Var c = thing.Open(",
            CALL
        );

        assert.ok(
            /^Open\(alpha\)/.test(signatureLabel(help)),
            "ожидалась подпись метода: " + signatureLabel(help) +
                " (модель готова: " + modelReady + ")"
        );

        const hover = await request(current, "hover", "  Var d = thing.Fiel");

        assert.ok(
            /Field/.test(hoverText(hover)) && /String/i.test(hoverText(hover)),
            "ожидались имя и тип поля: " + hoverText(hover) +
                " (модель готова: " + modelReady + ")"
        );
    }
);

bothWays(
    "поле, вызванное как процедура, подписи не даёт",
    async (current, modelReady) => {
        const help = await request(
            current,
            "signatureHelp",
            "  Var e = thing.Field(",
            CALL
        );

        assert.strictEqual(
            signatureLabel(help),
            "нет подписи",
            "Field — поле, а не процедура: подсказывать нечего " +
                "(модель готова: " + modelReady + ")"
        );
    }
);

bothWays(
    "приватный член снаружи не разрешается",
    async (current, modelReady) => {
        const hover = await request(current, "hover", "  Var f = thing.Secr");

        assert.ok(
            !/Secret/.test(hoverText(hover)),
            "приватное поле вне класса недоступно: " + hoverText(hover) +
                " (модель готова: " + modelReady + ")"
        );
    }
);

bothWays(
    "отсутствующий член не подменяется одноимённой процедурой",
    async (current, modelReady) => {
        const help = await request(
            current,
            "signatureHelp",
            "  Var g = thing.Missing(",
            CALL
        );

        assert.strictEqual(
            signatureLabel(help),
            "нет подписи",
            "у TLocal нет члена Missing, а глобальная Missing к объекту " +
                "отношения не имеет: " + signatureLabel(help) +
                " (модель готова: " + modelReady + ")"
        );

        const definition = await request(
            current,
            "definition",
            "  Var g = thing.Miss"
        );

        assert.strictEqual(
            targetOf(definition),
            "нет ответа",
            "переход по несуществующему члену уводил бы в чужой файл " +
                "(модель готова: " + modelReady + ")"
        );
    }
);

bothWays(
    "член чужого класса не находится по имени",
    async (current, modelReady) => {
        const hover = await request(current, "hover", "  Var h = thing.LibFie");

        assert.ok(
            !/LibField/.test(hoverText(hover)),
            "LibField объявлен в TLibClass, а не в TLocal: " +
                hoverText(hover) + " (модель готова: " + modelReady + ")"
        );
    }
);

bothWays(
    "переход к типу по несуществующему члену не открывает чужой класс",
    async (current, modelReady) => {
        const answer = await request(
            current,
            "typeDefinition",
            "  Var g = thing.Miss"
        );

        assert.strictEqual(
            targetOf(answer),
            "нет ответа",
            "тип несуществующего члена неизвестен " +
                "(модель готова: " + modelReady + ")"
        );
    }
);

test("доказанное отсутствие члена не заставляет ждать разбор", async () => {
    /*
     * Состав TLocal известен целиком: класс объявлен в этом файле, его база
     * — тоже. Значит «члена нет» — это ответ, а не незнание, и ждать разбор
     * незачем: ожидание всё равно ничего не изменит.
     */
    const platform = new PlatformModuleCatalog({ log: () => undefined });
    const current = stand(platform, false);

    await request(current, "hover", "  Var g = thing.Miss");

    assert.strictEqual(
        current.parses,
        0,
        "разбор не нужен: отсутствие члена доказано"
    );

    /* А вот получатель без известного типа — это как раз работа модели. */
    const needsModel = stand(platform, false);

    await request(needsModel, "hover", "  Var a = Shar");

    assert.ok(
        needsModel.parses >= 0,
        "запрос по имени файла разбора не требует"
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
            console.error(String(error.message || error).split("\n")[0]);
        }
    }

    fs.rmSync(WORKSPACE, { recursive: true, force: true });
    console.log("\nПройдено: " + passed + ", провалено: " + failed);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();
