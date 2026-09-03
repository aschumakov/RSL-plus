"use strict";

const assert = require("assert");
const path = require("path");

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

const { createSymbolTree } = require("./test-helpers");
const { parseRslSyntax } = require("../server/out/syntaxParser");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const {
    buildRslHoverContent
} = require("../server/out/features/hoverFormatter");
const {
    buildRslSemanticTokens
} = require("../server/out/semanticTokens");

let passed = 0;
let failed = 0;

function test(name, action) {
    try {
        action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

function offsetInside(source, value, occurrence = 0) {
    let offset = -1;
    let from = 0;

    for (let index = 0; index <= occurrence; index++) {
        offset = source.indexOf(value, from);
        assert.notStrictEqual(offset, -1);
        from = offset + value.length;
    }

    return offset + Math.floor(value.length / 2);
}

function createModule(index, uri, source) {
    return index.updateOpenModule(uri, source, 1).symbolTree;
}

test("Локальная переменная другого Macro не видна", () => {
    const source = [
        "Macro First()",
        "    Var result;",
        "    result = 1;",
        "End;",
        "Macro Second()",
        "    result = 2;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "result", 2)
    );

    assert.strictEqual(resolved, undefined);
});

test("Ближайшая локальная переменная имеет приоритет", () => {
    const source = [
        "Var result;",
        "Macro Test()",
        "    Var result;",
        "    result = 2;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "result", 2)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.symbol.range.start, source.indexOf("result", 5));
});

test("Метод разрешается по типу объекта слева от точки", () => {
    const source = [
        "Class Service",
        "    Macro Run()",
        "        return true;",
        "    End;",
        "End;",
        "Macro Test()",
        "    Var service: Service;",
        "    service.Run();",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Run", 1)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.symbol.name, "Run");
});

test("Строковый метод R2M разрешается по типу receiver", () => {
    const source = [
        "Class Service",
        "    Macro OnEvent(obj, cmd)",
        "    End;",
        "End;",
        "Macro Test()",
        "    Var service: Service;",
        '    ref = R2M(service, "OnEvent");',
        "End;"
    ].join("\n");
    const uri = "file:///main.mac";
    const index = new WorkspaceIndex();
    const tree = createModule(index, uri, source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveMemberReference(
        uri,
        tree,
        offsetInside(source, "service", 1),
        "OnEvent"
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.symbol.name, "OnEvent");
});

test("Тип объекта выводится из отдельного присваивания конструктора", () => {
    const source = [
        "Class Service",
        "    Macro Run()",
        "    End;",
        "End;",
        "Macro Test()",
        "    Var service;",
        "    service = Service();",
        "    service.Run();",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Run", 1)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.symbol.name, "Run");

    const semantic = buildRslSemanticTokens(
        index.getModule("file:///main.mac"),
        index,
        resolver
    ).data;
    let line = 0;
    let character = 0;
    const methodTokens = [];
    for (let offset = 0; offset < semantic.length; offset += 5) {
        line += semantic[offset];
        character = semantic[offset] === 0
            ? character + semantic[offset + 1]
            : semantic[offset + 1];
        if (semantic[offset + 3] === 1) {
            methodTokens.push({ line, character });
        }
    }
    assert.ok(methodTokens.some(token => token.line === 7));
});

/*
 * Тип переменной берётся из объявленного типа результата процедуры.
 *
 * Раньше разбор присваивания считал типом само имя вызванного — верно для
 * конструктора класса и неверно для процедуры: у Macro Get():TStream
 * типом становилось имя Get, класса с таким именем нет, и подсказка по
 * переменной пропадала полностью.
 */
test("тип переменной выводится из типа результата Macro", () => {
    const source = [
        "Macro openStream(name:string, params:TArray, " +
            "throw:bool):TStream",
        "End;",
        "Macro Test()",
        "    Var rs = openStream(name, MakeArray(), true);",
        "    rs.Flush();",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Flush", 0)
    );

    assert.ok(
        resolved,
        "Член TStream не разрешён: тип результата Macro не учтён"
    );
    assert.strictEqual(resolved.symbol.name, "Flush");
});

/*
 * Переменная без Var: в RSL она возникает от самого присваивания, поэтому в
 * дереве символов её нет — а тип из присваивания известен.
 */
test("Completion работает по переменной без объявления Var", () => {
    const source = [
        "Macro openForm(name:string):TRepForm",
        "End;",
        "Macro Test()",
        "    rs = openForm(name);",
        "    while ( rs.newline () )",
        "    End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);

    const names = resolver
        .getCompletions(
            "file:///main.mac",
            tree,
            source.indexOf("rs.newline") + 3
        )
        .map(item => item.label);

    assert.ok(
        names.some(name => /^newline$/i.test(name)),
        "Члены TRepForm обязаны предлагаться и без Var; " +
            `предложено: ${names.slice(0, 10).join(", ")}`
    );
});

/*
 * Тип переменной из результата ВЫЗОВА МЕТОДА, а не только процедуры.
 *
 * У методов стандартных классов тип результата объявлен явно, но разбор
 * присваивания раньше видел только прямой вызов `x = Name(...)`: форма
 * `rs = cmd.Execute()` не распознавалась вовсе, и подсказки по rs не было.
 */
test("тип переменной выводится из результата метода класса", () => {
    const source = [
        "Macro Test()",
        "    Var form = TRepForm();",
        "    Var fld = form.Field(1);",
        "    fld.Name();",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);

    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Name", 0)
    );

    assert.ok(
        resolved,
        "Член TPattFieldR не разрешён: тип результата Field не учтён"
    );
    assert.strictEqual(resolved.symbol.name, "Name");

    const names = resolver
        .getCompletions(
            "file:///main.mac",
            tree,
            source.indexOf("fld.Name") + 4
        )
        .map(item => item.label);
    assert.ok(
        names.some(name => /^name$/i.test(name)),
        `Члены TPattFieldR обязаны предлагаться: ${names.slice(0, 8).join(", ")}`
    );
});

/* Самоприсваивание через метод не должно зацикливать вывод типа. */
test("цепочка присваивания через метод не зацикливается", () => {
    const source = [
        "Macro Test()",
        "    Var rs = TStream();",
        "    rs = rs.Copy();",
        "    rs.Flush();",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);

    /* Важен сам факт завершения без переполнения стека. */
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Flush", 0)
    );
    assert.ok(
        resolved === undefined || typeof resolved.symbol.name === "string",
        "Разрешение обязано завершиться, а не зациклиться"
    );
});

/*
 * Переменная модуля, использованная внутри процедуры, не теряет тип.
 *
 * Поиск присваивания ограничивался текущей областью, поэтому у частого случая
 *
 *     private var doc = TBFile("x.dbt", "r", 0);
 *     Macro Process()
 *       if (doc.rec.Field == 0)
 *
 * присваивание оказывалось ДО начала процедуры и отбрасывалось: doc оставался
 * Variant, и подсказка по нему пропадала целиком.
 */
test("тип переменной модуля виден внутри процедуры", () => {
    const source = [
        "private var rtdocument = TBFile( \"rtdocument.dbt\", \"r\", 0 );",
        "",
        "Macro Process()",
        "    if ( rtdocument.rec == 0 )",
        "    End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);

    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        source.indexOf("rec", source.indexOf("if (")) + 1
    );
    assert.ok(
        resolved,
        "Член TBFile не разрешён: присваивание на уровне модуля потеряно"
    );
    assert.strictEqual(resolved.symbol.name, "Rec");

    const names = resolver
        .getCompletions(
            "file:///main.mac",
            tree,
            source.indexOf("rtdocument.rec") + "rtdocument.".length
        )
        .map(item => item.label);
    assert.ok(
        names.includes("Rec") && names.includes("AddFilter"),
        `Члены TBFile обязаны предлагаться: ${names.slice(0, 8).join(", ")}`
    );
});

/*
 * Выведенный тип показывается и в подсказке, и в автодополнении.
 *
 * Вывод работал только внутри разрешения членов: по переменной уже предлагались
 * методы класса, а сама она отображалась как Variant — подсказка противоречила
 * автодополнению.
 */
test("выведенный тип переменной виден в Hover и автодополнении", () => {
    const source = [
        "private var rtdocument = TBFile( \"rtdocument.dbt\", \"r\", 0 );",
        "Macro Process()",
        "    if ( rtdocument.rec == 0 )",
        "    End;",
        "End;"
    ].join("\n");
    const uri = "file:///main.mac";
    const index = new WorkspaceIndex();
    const tree = createModule(index, uri, source);
    const resolver = new RslScopeResolver(index);
    const at = source.indexOf("rtdocument", source.indexOf("if (")) + 2;

    const resolved = resolver.resolveAt(uri, tree, at);
    assert.ok(resolved, "Переменная обязана разрешаться");

    const effective = resolver.effectiveTypeName(
        uri,
        tree,
        resolved.symbol,
        at
    );
    assert.strictEqual(
        effective,
        "TBFile",
        "Действующий тип переменной обязан выводиться из присваивания"
    );

    const hover = buildRslHoverContent(index, uri, resolved.symbol, effective)
        .value;
    assert.ok(
        hover.includes("rtdocument: TBFile"),
        `Hover обязан показывать выведенный тип: ${hover.split("\n")[1]}`
    );

    const item = resolver
        .getCompletions(uri, tree, source.indexOf("if (") + 5)
        .find(entry => entry.label === "rtdocument");
    assert.ok(item, "Переменная обязана быть в автодополнении");
    assert.ok(
        String(item.detail).includes("TBFile"),
        `В автодополнении обязан быть выведенный тип: ${item.detail}`
    );
});

/*
 * После точки предлагаются только члены.
 *
 * Тип Record описывается словарём базы данных, состав его полей расширению
 * неизвестен. Раньше в этом месте начинался общий список области видимости, и
 * на `doc.rec.` подсказка предлагала локальные переменные и процедуры файла —
 * членами они не являются.
 */
test("после точки не предлагаются имена из области видимости", () => {
    const source = [
        "private var rtdocument = TBFile( \"rtdocument.dbt\", \"r\", 0 );",
        "Macro Process()",
        "    Var localValue = 1;",
        "    if ( rtdocument.rec.FoldSide == 0 )",
        "    End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);

    const names = resolver
        .getCompletions(
            "file:///main.mac",
            tree,
            source.indexOf("rtdocument.rec.") + "rtdocument.rec.".length
        )
        .map(item => item.label);

    assert.deepStrictEqual(
        names.filter(name =>
            ["localValue", "Process", "rtdocument"].includes(name)
        ),
        [],
        `После точки посторонних имён быть не должно: ${names.join(", ")}`
    );
});

test("Completion после частично введённого метода остаётся объектным", () => {
    const source = [
        "Class Service",
        "    Macro Run()",
        "    End;",
        "End;",
        "Macro Test()",
        "    Var service: Service;",
        "    service.Ru",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const completions = resolver.getCompletions(
        "file:///main.mac",
        tree,
        source.indexOf("service.Ru") + "service.Ru".length
    );

    assert.ok(completions.some(item => item.label === "Run"));
});

test("Completion видит Private Macro своего файла и ставит его выше Import", () => {
    const index = new WorkspaceIndex();
    createModule(
        index,
        "file:///library.mac",
        [
            "Macro GetOrderFromImport()",
            "End;",
            "Private Macro HiddenImport()",
            "End;"
        ].join("\n")
    );
    const source = [
        "Import library;",
        "Private Macro GetOrigin()",
        "End;",
        "Macro Caller()",
        "    Var localOnly;",
        "    GetOr",
        "End;",
        "Macro Other()",
        "    Var foreignLocal;",
        "End;"
    ].join("\n");
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const completions = resolver.getCompletions(
        "file:///main.mac",
        tree,
        source.indexOf("GetOr") + "GetOr".length
    );
    const ownPrivate = completions.find(item =>
        item.label === "GetOrigin"
    );
    const imported = completions.find(item =>
        item.label === "GetOrderFromImport"
    );

    assert.ok(ownPrivate, "Private Macro текущего файла должен быть виден");
    assert.ok(imported);
    assert.ok(String(ownPrivate.sortText).startsWith("2_"));
    assert.ok(String(imported.sortText).startsWith("5_"));
    assert.ok(!completions.some(item => item.label === "HiddenImport"));
    assert.ok(!completions.some(item => item.label === "foreignLocal"));
});

test("Private-метод доступен через this внутри своего класса", () => {
    const source = [
        "Class Service",
        "    Private Macro Hidden()",
        "    End;",
        "    Macro Test()",
        "        this.Hidden();",
        "    End;",
        "End;"
    ].join("\n");
    const index = new WorkspaceIndex();
    const tree = createModule(index, "file:///main.mac", source);
    const resolver = new RslScopeResolver(index);
    const resolved = resolver.resolveAt(
        "file:///main.mac",
        tree,
        offsetInside(source, "Hidden", 1)
    );

    assert.ok(resolved);
    assert.strictEqual(resolved.symbol.name, "Hidden");
});

test("Поиск идёт только по графу Import", () => {
    const index = new WorkspaceIndex();
    createModule(
        index,
        "file:///lib/common.mac",
        "Macro Shared()\nEnd;"
    );
    createModule(
        index,
        "file:///lib/unrelated.mac",
        "Macro Hidden()\nEnd;"
    );
    const mainSource = [
        "Import lib\\common;",
        "Macro Test()",
        "    Shared();",
        "    Hidden();",
        "End;"
    ].join("\n");
    const mainTree = createModule(
        index,
        "file:///main.mac",
        mainSource
    );
    const resolver = new RslScopeResolver(index);

    const shared = resolver.resolveAt(
        "file:///main.mac",
        mainTree,
        offsetInside(mainSource, "Shared")
    );
    const hidden = resolver.resolveAt(
        "file:///main.mac",
        mainTree,
        offsetInside(mainSource, "Hidden")
    );

    assert.ok(shared);
    assert.strictEqual(shared.uri, "file:///lib/common.mac");
    assert.strictEqual(hidden, undefined);
});

test("Ленивый индекс находит файл проекта по относительному пути", () => {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([
        "file:///project/lib/common.mac",
        "file:///project/other/common.mac",
        "file:///project/main.mac"
    ]);

    assert.strictEqual(
        index.findWorkspaceFileUri("lib\\common"),
        "file:///project/lib/common.mac"
    );
});

test("Reverse import graph возвращает зависимые модули", () => {
    const index = new WorkspaceIndex();
    createModule(
        index,
        "file:///main.mac",
        "Import lib\\common;"
    );
    createModule(
        index,
        "file:///lib/common.mac",
        "Macro Shared()\nEnd;"
    );

    assert.deepStrictEqual(
        index.getDependents("file:///lib/common.mac"),
        ["file:///main.mac"]
    );
});

test("ResolveAt кэшируется, Semantic Tokens Range не выходит за диапазон", () => {
    const source = [
        "Macro Test(pValue)",
        "  Var localValue: Integer;",
        "  localValue = pValue;",
        "  localValue = localValue + 1;",
        "End;"
    ].join("\n");
    const uri = "file:///workspace/semantic.mac";
    const syntax = parseRslSyntax(source, undefined, {
        buildExpressionTree: false
    });
    const tree = createSymbolTree(source, syntax);
    const index = new WorkspaceIndex();
    index.updateOpenModule(uri, source, 1, syntax);
    const resolver = new RslScopeResolver(index);
    const offset = source.indexOf("localValue = pValue") + 2;

    const first = resolver.resolveAt(uri, tree, offset);
    const second = resolver.resolveAt(uri, tree, offset);
    assert.ok(first);
    assert.strictEqual(second && second.symbol, first.symbol);
    const stats = resolver.getCacheStats();
    assert.ok(stats.misses >= 1);
    assert.ok(
        stats.hits >= 1,
        "Повторный resolveAt должен попадать в token-start cache"
    );

    const rangeTokens = buildRslSemanticTokens(
        index.getModule(uri),
        index,
        resolver,
        {
            startLine: 2,
            startCharacter: 0,
            endLine: 2,
            endCharacter: 1000
        }
    );
    const lines = [];
    let line = 0;
    let character = 0;

    for (let index = 0; index < rangeTokens.data.length; index += 5) {
        const deltaLine = rangeTokens.data[index];
        const deltaCharacter = rangeTokens.data[index + 1];
        line += deltaLine;
        character = deltaLine === 0
            ? character + deltaCharacter
            : deltaCharacter;
        lines.push(line);
    }

    assert.ok(lines.length > 0);
    assert.ok(
        lines.every(value => value === 2),
        `Range semantic tokens не должны разрешать другие строки: ${lines.join(",")}`
    );
});

console.log("");
console.log(`Пройдено: ${passed}`);
console.log(`Ошибок: ${failed}`);

if (failed > 0) {
    process.exitCode = 1;
}
