"use strict";

/**
 * Раннее отсечение по отпечатку внешнего интерфейса.
 *
 * Соседний файл видит от модуля только его Import и публичные объявления с
 * подписями, типами и базовыми классами. Что написано внутри Macro — его дело.
 * Значит, правка ТЕЛА импортированного модуля не меняет ни одного вывода в
 * зависимом файле, и сбрасывать его семантическое состояние незачем.
 *
 * Прежде сбрасывалось всё: Import-контекст, ревизия окружения и ключ условий
 * расчёта Problems — у каждого зависимого, на каждое нажатие клавиши в
 * библиотеке. На популярном модуле это тысячи файлов.
 *
 * Целевая величина: при неизменившемся интерфейсе число сброшенных зависимых
 * равно нулю. Проверяется счётчиками самого индекса — по ним видно не время, а
 * то, сколько работы НЕ сделано.
 *
 * Единственное, чего в отпечатке нет, — положения в тексте. Их проверяет
 * symbol-ref.test.js: они спрашиваются у текущей модели, а не у запомненного
 * объекта, поэтому отсечение их не портит.
 */

const assert = require("assert");

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

const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { RslTypeEngine } = require("../server/out/analysis/typeEngine");

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

const LIB = "file:///d:/cutoff/lib.mac";

function libSource(bodyLines) {
    return [
        "Macro Send(a: String)",
        ...bodyLines,
        "End;",
        ""
    ].join("\n");
}

/** Один популярный модуль и count зависимых от него файлов. */
function stand(count) {
    const index = new WorkspaceIndex({ maxExternalModules: 20000 });
    const users = [];

    for (let at = 0; at < count; at++) {
        users.push("file:///d:/cutoff/user" + at + ".mac");
    }

    index.registerWorkspaceFiles([LIB, ...users]);
    index.updateExternalModule(LIB, libSource(["    Return a;"]), 1);

    for (const uri of users) {
        index.updateExternalModule(
            uri,
            "Import lib;\n\nMacro Run()\n    Send(\"a\");\nEnd;\n",
            1
        );
    }

    /* Ревизии назначаются лениво: спросить их — значит завести. */
    index.getSemanticRevision(LIB);
    users.forEach(uri => index.getSemanticRevision(uri));

    return { index, users };
}

test("правка тела популярного модуля не сбрасывает ни одного зависимого", () => {
    const board = stand(200);
    const before = board.index.interfaceCounters;

    board.index.updateExternalModule(
        LIB,
        libSource(["    Var t = a;", "    Return t;"]),
        2
    );

    const after = board.index.interfaceCounters;

    assert.strictEqual(
        after.dependentInvalidations - before.dependentInvalidations,
        0,
        "интерфейс тот же — сбрасывать нечего"
    );
    assert.strictEqual(
        after.skippedDependentInvalidations -
            before.skippedDependentInvalidations,
        200,
        "и все двести зависимых остались при своём состоянии"
    );
    assert.strictEqual(
        after.semanticRevisionResets - before.semanticRevisionResets,
        1,
        "заново назначена только ревизия самого правленого файла"
    );
});

test("правка подписи сбрасывает всех зависимых", () => {
    /* Обратная проверка: отсечение не должно прятать настоящее изменение. */
    const board = stand(200);
    const before = board.index.interfaceCounters;

    board.index.updateExternalModule(
        LIB,
        "Macro Send(a: Integer)\n    Return a;\nEnd;\n",
        2
    );

    const after = board.index.interfaceCounters;

    assert.strictEqual(
        after.dependentInvalidations - before.dependentInvalidations,
        200,
        "тип параметра виден снаружи"
    );
});

test("ключ условий расчёта не дрогнет от чужого тела", () => {
    const board = stand(1);
    const user = board.users[0];
    const before = board.index.getImportClosureKey(user);

    board.index.updateExternalModule(
        LIB,
        libSource(["    Var t = a;", "    Return t;"]),
        2
    );

    assert.strictEqual(
        board.index.getImportClosureKey(user),
        before,
        "иначе межфайловая фаза Problems пересчиталась бы у каждого зависимого"
    );

    board.index.updateExternalModule(
        LIB,
        "Macro Send(a: Integer)\n    Return a;\nEnd;\n",
        3
    );

    assert.notStrictEqual(
        board.index.getImportClosureKey(user),
        before,
        "а изменившаяся подпись обязана его изменить"
    );
});

test("своя правка ключ меняет", () => {
    const board = stand(1);
    const user = board.users[0];
    const before = board.index.getImportClosureKey(user);

    board.index.updateExternalModule(
        user,
        "Import lib;\n\nMacro Run()\n    Send(\"b\");\nEnd;\n",
        2
    );

    assert.notStrictEqual(
        board.index.getImportClosureKey(user),
        before,
        "текст самого документа в условия расчёта входит"
    );
});

test("Import-контекст зависимого переживает правку чужого тела", () => {
    const board = stand(1);
    const user = board.users[0];

    /* Контекст кэшируется только у открытых документов. */
    board.index.markOpen(user);
    board.index.updateOpenModule(
        user,
        "Import lib;\n\nMacro Run()\n    Send(\"a\");\nEnd;\n",
        2
    );
    board.index.getImportedModules(user);

    const before = board.index.interfaceCounters.importContextRebuilds;

    board.index.updateExternalModule(
        LIB,
        libSource(["    Var t = a;", "    Return t;"]),
        2
    );

    const modules = board.index.getImportedModules(user);

    assert.strictEqual(
        board.index.interfaceCounters.importContextRebuilds,
        before,
        "состав замыкания не изменился — собирать его заново незачем"
    );
    assert.strictEqual(modules.length, 1, "замыкание по-прежнему знает lib");
    assert.strictEqual(
        modules[0],
        board.index.getModule(LIB),
        "и отдаёт его В ТЕКУЩЕМ виде, а не запомненный объект"
    );
});

test("вытесненный модуль из замыкания выпадает", () => {
    const board = stand(1);
    const user = board.users[0];

    board.index.markOpen(user);
    board.index.updateOpenModule(
        user,
        "Import lib;\n\nMacro Run()\n    Send(\"a\");\nEnd;\n",
        2
    );

    assert.strictEqual(board.index.getImportedModules(user).length, 1);

    board.index.removeModule(LIB);

    assert.strictEqual(
        board.index.getImportedModules(user).length,
        0,
        "контекст помнит состав, а не содержимое: держать вытесненное нельзя"
    );
});

test("новый модуль в замыкании подхватывается", () => {
    const index = new WorkspaceIndex();
    const user = "file:///d:/cutoff/user.mac";

    index.registerWorkspaceFiles([user, LIB]);
    index.updateOpenModule(
        user,
        "Import lib;\n\nMacro Run()\n    Send(\"a\");\nEnd;\n",
        1
    );

    assert.strictEqual(
        index.getImportedModules(user).length,
        0,
        "пока lib не прочитан, замыкание пусто"
    );

    index.updateExternalModule(LIB, libSource(["    Return a;"]), 1);

    assert.strictEqual(
        index.getImportedModules(user).length,
        1,
        "появление модуля — это новое сведение, и оно обязано дойти"
    );
});

test("выведенный тип не устаревает от чужого тела", () => {
    /*
     * Сквозная проверка через TypeEngine: он кэширует ответы на ревизию
     * окружения документа. Отсечение сохраняет её — значит, ответы обязаны
     * остаться верными, а не просто прежними.
     */
    const index = new WorkspaceIndex();
    const user = "file:///d:/cutoff/user.mac";
    const source = "Import lib;\n\nMacro Run()\n    Send();\nEnd;\n";

    index.registerWorkspaceFiles([user, LIB]);
    index.updateExternalModule(LIB, libSource(["    Return a;"]), 1);
    index.updateOpenModule(user, source, 1);

    const resolver = new RslScopeResolver(index);
    const engine = new RslTypeEngine(index, resolver);
    const offset = source.indexOf("Send()") + 5;
    const before = engine.expectedTypeAt(user, offset);

    assert.strictEqual(before, "string", "тип параметра написан в подписи");

    /* Тело изменилось — тип аргумента остался тем же. */
    index.updateExternalModule(
        LIB,
        libSource(["    Var t = a;", "    Return t;"]),
        2
    );

    assert.strictEqual(
        engine.expectedTypeAt(user, offset),
        "string",
        "ответ прежний, и он верен"
    );

    /* А смена типа параметра обязана дойти. */
    index.updateExternalModule(
        LIB,
        "Macro Send(a: Integer)\n    Return a;\nEnd;\n",
        3
    );

    assert.strictEqual(
        engine.expectedTypeAt(user, offset),
        "integer",
        "изменившаяся подпись видна снаружи"
    );
});

test("ревизия каталога отсечением НЕ отсекается", () => {
    /*
     * Известный предел отсечения, и он здесь записан намеренно.
     *
     * Каналов отмены два. Первый — ревизия окружения документа и
     * Import-контекст; его отпечаток интерфейса отсекает, и все проверки
     * выше про него. Второй — ревизия каталога проекта: каталог поднимает
     * её на КАЖДУЮ запись модуля, даже когда снаружи в нём ничего не
     * изменилось.
     *
     * От второго зависят межфайловые проверки, отвечающие про проект
     * целиком: «есть ли вообще такое публичное имя» и «не стало ли оно
     * неоднозначным». Значит правка тела популярного модуля их всё ещё
     * отменяет — при том, что ответ измениться не мог.
     *
     * Чинится это разделением ревизии каталога на хранилищную и
     * смысловую, и это работа не на конец релиза: ошибиться здесь значит
     * вернуть устаревшие Problems, ровно то, что этот релиз убирал.
     * Проверка держит предел на виду: когда его снимут, она упадёт, и
     * снимавший её перепишет.
     */
    const board = stand(1);
    const before = board.index.catalog.revision;

    board.index.updateExternalModule(
        LIB,
        libSource(["    Var t = a;", "    Return t;"]),
        2
    );

    assert.notStrictEqual(
        board.index.catalog.revision,
        before,
        "пока это так; когда перестанет — проверку переписать"
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

