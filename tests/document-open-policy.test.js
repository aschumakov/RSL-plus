"use strict";

/*
 * Анализ не открывает документы в редакторе.
 *
 * Прежде при неизвестном Import сервер присылал клиенту `getFilebyName`, тот
 * искал файл через `workspace.findFiles` и открывал его `openTextDocument`.
 * Документ, который пользователь не открывал, получал `didOpen`, а вкладка,
 * открытая переходом в режиме предварительного просмотра, переставала быть
 * предварительной. Файлы проекта читает сервер, редактор к этому непричастен.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
    decideRslDocumentOpen,
    openRslDocument
} = require("../client/out/documentOpenPolicy");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log("[OK] " + name);
    } catch (error) {
        failed++;
        console.error("[FAIL] " + name);
        console.error(error);
    }
}

/** Заглушка редактора: запоминает вызовы вместо открытия файла. */
function createEditorStub() {
    const calls = [];

    return {
        calls,
        openTextDocument(uri) {
            calls.push({ call: "openTextDocument", uri });

            return Promise.resolve({ uri });
        },
        showTextDocument(document, options) {
            calls.push({ call: "showTextDocument", options });

            return Promise.resolve({ document });
        }
    };
}

const BACKGROUND_REASONS = [
    "analysis",
    "importLoading",
    "diagnostics",
    "indexing"
];

async function main() {
    await test("фоновые причины не открывают документ", async () => {
        for (const reason of BACKGROUND_REASONS) {
            const editor = createEditorStub();
            const decision = await openRslDocument(
                editor,
                { path: "/d/project/lib.mac" },
                reason
            );

            assert.strictEqual(
                decision.open,
                false,
                reason + ": решение обязано быть «не открывать»"
            );
            assert.deepStrictEqual(
                editor.calls,
                [],
                reason + ": редактор не должен быть потревожен"
            );
        }
    });

    await test("выбор в списке открывает файл предварительной вкладкой", async () => {
        const editor = createEditorStub();
        const decision = await openRslDocument(
            editor,
            { path: "/d/project/main.mac" },
            "quickPick"
        );

        assert.strictEqual(decision.open, true);
        assert.deepStrictEqual(
            editor.calls.map(item => item.call),
            ["openTextDocument", "showTextDocument"]
        );
        assert.deepStrictEqual(
            editor.calls[1].options,
            { preview: true },
            "preview указывается явно, а не берётся из настройки редактора"
        );
    });

    await test("решение объясняется и для команды пользователя", () => {
        assert.strictEqual(decideRslDocumentOpen("userCommand").open, true);
        assert.strictEqual(decideRslDocumentOpen("analysis").open, false);
        assert.ok(decideRslDocumentOpen("analysis").explanation.length > 0);
    });

    /*
     * Граница client/server: в собранном сервере не должно остаться ни одного
     * сообщения, которое просит клиента открыть или показать документ, кроме
     * навигации по блокам — она следствие явной команды пользователя.
     */
    await test("сервер не просит клиента открывать документы", () => {
        const root = path.join(__dirname, "..", "server", "out");
        const forbidden = [/"getFilebyName"/, /"getFile"/];
        const showDocument = [];
        const found = [];

        const walk = directory => {
            for (const entry of fs.readdirSync(directory, {
                withFileTypes: true
            })) {
                const full = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    walk(full);
                    continue;
                }

                if (!entry.name.endsWith(".js")) {
                    continue;
                }

                const text = fs.readFileSync(full, "utf8");

                for (const pattern of forbidden) {
                    if (pattern.test(text)) {
                        found.push(entry.name + ": " + pattern.source);
                    }
                }

                if (text.includes("window/showDocument")) {
                    showDocument.push(entry.name);
                }
            }
        };

        walk(root);

        assert.deepStrictEqual(
            found,
            [],
            "Сообщения открытия документа обязаны быть убраны"
        );
        assert.deepStrictEqual(
            showDocument,
            ["languageFeatureRegistry.js"],
            "window/showDocument допустим только в навигации по блокам: " +
                showDocument.join(", ")
        );
    });

    if (failed > 0) {
        console.error(`\nПройдено: ${passed}\nОшибок: ${failed}`);
        process.exitCode = 1;
    } else {
        console.log(`\nПройдено: ${passed}\nОшибок: ${failed}`);
    }
}

main();
