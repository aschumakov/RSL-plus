const assert = require("assert");

/*
 * common.js импортирует ./server для getTree() и
 * GetFileByNameRequest(). При обычном require это запускает
 * настоящий language server и createConnection(), которому
 * нужны --node-ipc / --stdio.
 *
 * В unit-тесте подменяем сервер минимальной заглушкой до
 * загрузки common.js.
 */
const serverModulePath = require.resolve(
    "../server/out/server"
);

require.cache[serverModulePath] = {
    id: serverModulePath,
    filename: serverModulePath,
    loaded: true,
    exports: {
        getTree: () => [],
        GetFileByNameRequest: () => undefined
    }
};

const { CBase } = require("../server/out/common");

const source = [
    "Private class CTransactionW4Service",
    "",
    "    Macro init",
    `        sql = execSqlSelect ("select * from t@"+BCLinkWWay4+" where x in ('A', 'B')", null, false);`,
    "        while (sql.moveNext())",
    "            if (foo+bar > 0)",
    "                x = [",
    "                    begin",
    "                        if 1=1 then",
    "                            null;",
    "                        end if;",
    "                    end;",
    "                ];",
    "            end;",
    "        end;",
    "    End;",
    "",
    "    Macro makeTemplateRequest(funcName)",
    "        return funcName;",
    "    End;",
    "End;"
].join("\n");

const tree = new CBase(source, 0);
const classNode = tree
    .getChilds()
    .find(node => node.Name === "CTransactionW4Service");

assert.ok(classNode, "Класс не найден");

const methodNames = classNode
    .getChilds()
    .filter(node => node.isObject())
    .map(node => node.Name);

assert.ok(methodNames.includes("init"));
assert.ok(methodNames.includes("makeTemplateRequest"));

function tokenAt(fragment) {
    const offset =
        source.indexOf(fragment) +
        Math.floor(fragment.length / 2);

    return tree.getCurrentToken(offset);
}

assert.strictEqual(
    tokenAt("select * from").kind,
    "string"
);

assert.strictEqual(
    tokenAt("BCLinkWWay4").kind,
    "code"
);

assert.strictEqual(
    tokenAt("begin").kind,
    "square"
);

const plusOffset =
    source.indexOf("foo+bar") + 3;

assert.strictEqual(
    tree.getCurrentToken(plusOffset).str,
    "+"
);

const startedAt = Date.now();

for (let index = 0; index < 100000; index++) {
    tree.getCurrentToken(source.length - 10);
}

console.log(
    "Parser optimization test passed.",
    "100000 token lookups:",
    Date.now() - startedAt,
    "ms"
);
