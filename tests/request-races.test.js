"use strict";

/*
 * Гонки версий в LSP-обработчиках.
 *
 * Каждый обработчик между приходом запроса и ответом ждёт разбора, а документ
 * за это время может уйти вперёд. Ответ по прежней версии не просто устаревший:
 * его смещения указывают в другой текст. Для Definition это переход не туда,
 * для Rename — правки по сдвинувшимся позициям, то есть порча файла.
 *
 * Здесь проверяется весь путь, а не отдельная функция: обработчики
 * регистрируются на подставном connection и вызываются как их вызывает клиент.
 * Смена версии моделируется там, где она и происходит в жизни — во время
 * ожидания разбора.
 */

const assert = require("assert");

const {
    RslLanguageFeatureRegistry
} = require("../server/out/features/languageFeatureRegistry");
const {
    createFastDocumentSnapshot
} = require("../server/out/services/fastDocumentSnapshot");
const { RslScopeResolver } = require("../server/out/scopeResolver");
const { WorkspaceIndex } = require("../server/out/workspaceIndex");
const {
    DiagnosticsCoordinator
} = require("../server/out/diagnostics/diagnosticsCoordinator");
const { RslDiagnosticEngine } = require("../server/out/diagnostics/diagnosticEngine");

let passed = 0;
let failed = 0;

async function test(name, action) {
    try {
        await action();
        passed++;
        console.log(`[OK] ${name}`);
    } catch (error) {
        failed++;
        console.error(`[FAIL] ${name}`);
        console.error(error);
    }
}

const defaults = {
    language: { dialect: "rsBank" },
    imports: { enabled: false },
    autoImport: { enabled: false },
    analysis: { workspaceIndexing: "activeImports" },
    semanticHighlighting: { maxFileSizeKb: 512 },
    inlayHints: { variableTypes: true },
    diagnostics: {}
};

/**
 * Документ, который меняется НА МЕСТЕ.
 *
 * Именно так ведёт себя TextDocuments в vscode-languageserver: при правке он
 * обновляет тот же объект, а не подменяет его новым. Это существенно для
 * проверки: обработчик захватывает ссылку на документ в начале и сверяет
 * document.version уже после ожидания. Подмена объекта сделала бы старую
 * ссылку неизменной, и проверка версии в тесте никогда бы не срабатывала —
 * тест проходил бы по неверной причине.
 */
function createDocument(uri, version, text) {
    let content = text;
    let lineStarts = [];

    const reindex = () => {
        lineStarts = [0];
        for (let index = 0; index < content.length; index++) {
            if (content[index] === "\n") {
                lineStarts.push(index + 1);
            }
        }
    };
    reindex();

    return {
        uri,
        languageId: "rsl",
        version,
        get lineCount() {
            return lineStarts.length;
        },
        getText: () => content,
        /** Правка документа: та же ссылка, новая версия. */
        applyEdit(nextText) {
            content = nextText;
            this.version++;
            reindex();
        },
        positionAt(offset) {
            const bounded = Math.max(0, Math.min(offset, content.length));
            let line = 0;
            while (
                line + 1 < lineStarts.length &&
                lineStarts[line + 1] <= bounded
            ) {
                line++;
            }
            return { line, character: bounded - lineStarts[line] };
        },
        offsetAt(position) {
            const line = Math.max(
                0,
                Math.min(position.line, lineStarts.length - 1)
            );
            return Math.min(
                content.length,
                lineStarts[line] + Math.max(0, position.character)
            );
        }
    };
}

/**
 * Реестр на подставном connection.
 *
 * onParsed вызывается вместо реального разбора: тест решает, что произойдёт за
 * время ожидания — в частности, успеет ли документ измениться.
 */
function createRegistry({ uri, source, onParsed, settings }) {
    const index = new WorkspaceIndex();
    index.registerWorkspaceFiles([uri]);
    const module = index.updateOpenModule(uri, source, 1);
    const state = { document: createDocument(uri, 1, source) };
    /** Кто и как просил разбор: forced снимает debounce, requested — нет. */
    const calls = {
        forced: 0,
        scheduled: 0,
        requested: 0,
        fastSnapshots: 0
    };

    const handlers = {};
    const register = name => callback => {
        handlers[name] = callback;
    };
    const connection = {
        onCompletion: register("completion"),
        onCompletionResolve: register("completionResolve"),
        onSignatureHelp: register("signatureHelp"),
        onHover: register("hover"),
        onDocumentHighlight: register("documentHighlight"),
        onDefinition: register("definition"),
        onReferences: register("references"),
        onWorkspaceSymbol: register("workspaceSymbol"),
        onCodeAction: register("codeAction"),
        onSelectionRanges: register("selectionRanges"),
        onExecuteCommand: register("executeCommand"),
        onPrepareRename: register("prepareRename"),
        onRenameRequest: register("rename"),
        onRequest: (method, callback) => {
            handlers[method] = callback;
        },
        onDocumentSymbol: register("documentSymbol"),
        onFoldingRanges: register("foldingRanges"),
        onDocumentFormatting: register("documentFormatting"),
        onDocumentRangeFormatting: register("documentRangeFormatting"),
        sendRequest: async () => undefined,
        languages: {
            callHierarchy: {
                onPrepare: register("callHierarchyPrepare"),
                onIncomingCalls: register("callHierarchyIncoming"),
                onOutgoingCalls: register("callHierarchyOutgoing")
            },
            semanticTokens: {
                on: register("semanticTokens"),
                onDelta: register("semanticTokensDelta"),
                onRange: register("semanticTokensRange"),
                refresh: () => undefined
            },
            inlayHint: {
                on: register("inlayHint"),
                refresh: () => undefined
            }
        }
    };

    const registry = new RslLanguageFeatureRegistry({
        connection,
        documents: {
            get: requested => requested === uri ? state.document : undefined,
            all: () => [state.document]
        },
        index,
        resolver: new RslScopeResolver(index),
        definitionProvider: {
            findImportDefinition: async () => undefined,
            findDynamicDefinition: async () => undefined,
            createObjectLocationByUri: () => ({ uri, range: null })
        },
        getFastDocumentSnapshot: () => {
            calls.fastSnapshots++;
            return createFastDocumentSnapshot(state.document);
        },
        ensureDocumentParsed: async (_document, mode = "force") => {
            if (mode === "force") {
                calls.forced++;
            } else {
                calls.scheduled++;
            }
            await onParsed?.(state);
            return module.symbolTree;
        },
        requestDocumentParse: () => {
            calls.requested++;
            /*
             * Разбор запрошен, но не начат — а документ за это время может
             * уйти вперёд. Обработчики подсветки после этого возвращают
             * управление event loop, поэтому правка успевает примениться
             * ровно там же, где раньше её применял ensureDocumentParsed.
             */
            void onParsed?.(state);
        },
        getSettings: () => settings || defaults,
        supportsRefresh: () => false,
        log: () => undefined
    });
    registry.register();

    return { handlers, state, index, registry, module, calls };
}

/** Документ ушёл вперёд, пока обработчик ждал разбора. */
function bumpVersion(state, nextText) {
    state.document.applyEdit(nextText);
}

const URI = "file:///d:/races/main.mac";
const SOURCE = [
    "Macro Target(value)",
    "  Var local = value;",
    "  return local;",
    "End;",
    "Macro Caller()",
    "  Target(1);",
    "End;"
].join("\n");
/* Правка добавляет строку в начало: все смещения ниже сдвигаются. */
const CHANGED = `Var shifted;\n${SOURCE}`;
/*
 * Правка, не меняющая длину: смещения совпадают с прежней версией.
 *
 * Нужна там, где проверяется не смена версии сама по себе, а использование
 * модели своей версии: при совпавших смещениях отставшая модель отвечает
 * результатом, и отсутствие проверки становится видно.
 */
const SAME_LENGTH = SOURCE.replace("Var local = value;", "Var lokal = value;");

(async () => {
    await test(
        "Definition не отвечает по версии, изменившейся во время разбора",
        async () => {
            const { handlers, state } = createRegistry({
                uri: URI,
                source: SOURCE,
                onParsed: current => bumpVersion(current, CHANGED)
            });

            const result = await handlers.definition(
                {
                    textDocument: { uri: URI },
                    position: state.document.positionAt(
                        SOURCE.indexOf("Target(1)")
                    )
                },
                { isCancellationRequested: false }
            );

            assert.strictEqual(
                result,
                null,
                "Переход по смещениям прежней версии увёл бы курсор не туда"
            );
        }
    );

    await test(
        "Definition отвечает, когда версия не менялась",
        async () => {
            const { handlers, state } = createRegistry({
                uri: URI,
                source: SOURCE
            });

            const result = await handlers.definition(
                {
                    textDocument: { uri: URI },
                    position: state.document.positionAt(
                        SOURCE.indexOf("Target(1)")
                    )
                },
                { isCancellationRequested: false }
            );

            assert.ok(
                result,
                "Без смены версии переход обязан работать: иначе проверка " +
                    "версии просто отключила бы Definition"
            );
        }
    );

    await test(
        "Rename не отдаёт правки по версии, изменившейся во время разбора",
        async () => {
            const { handlers, state } = createRegistry({
                uri: URI,
                source: SOURCE,
                onParsed: current => bumpVersion(current, CHANGED)
            });
            const position = state.document.positionAt(
                SOURCE.indexOf("Target(value)")
            );

            const prepared = await handlers.prepareRename(
                { textDocument: { uri: URI }, position },
                { isCancellationRequested: false }
            );
            assert.strictEqual(
                prepared,
                null,
                "prepareRename по прежней версии показал бы неверный диапазон"
            );

            const edit = await handlers.rename(
                {
                    textDocument: { uri: URI },
                    position,
                    newName: "Renamed"
                },
                { isCancellationRequested: false }
            );
            assert.strictEqual(
                edit,
                null,
                "Правки по сдвинувшимся смещениям испортили бы файл"
            );
        }
    );

    await test(
        "Rename работает, когда версия не менялась",
        async () => {
            const { handlers, state } = createRegistry({
                uri: URI,
                source: SOURCE
            });
            const position = state.document.positionAt(
                SOURCE.indexOf("Target(value)")
            );

            const edit = await handlers.rename(
                {
                    textDocument: { uri: URI },
                    position,
                    newName: "Renamed"
                },
                { isCancellationRequested: false }
            );

            assert.ok(
                edit && edit.changes,
                "Без смены версии Rename обязан вернуть правки"
            );
        }
    );

    /*
     * Второй, отдельный вид гонки: документ НЕ менялся во время запроса, но в
     * индексе лежит модель прежней версии — разбор текущей ещё не закончился.
     * Проверка document.version здесь проходит, поэтому обработчик обязан
     * спрашивать модель именно своей версии (getCurrentModule), иначе он
     * ответит по сдвинувшимся смещениям.
     */
    await test(
        "Rename не работает по модели версии, отставшей от документа",
        async () => {
            const { handlers, state } = createRegistry({
                uri: URI,
                source: SOURCE
            });

            /*
             * Правка ТОЙ ЖЕ ДЛИНЫ: смещения совпадают, поэтому отставшая модель
             * без проверки версии вернула бы результат — и он относился бы к
             * прежнему тексту. Правка со сдвигом такой проверки не даёт:
             * смещение попадает в пустоту, и null получается случайно.
             */
            state.document.applyEdit(SAME_LENGTH);

            const position = state.document.positionAt(
                SAME_LENGTH.indexOf("Target(value)")
            );
            const cancellation = { isCancellationRequested: false };

            assert.strictEqual(
                await handlers.prepareRename(
                    { textDocument: { uri: URI }, position },
                    cancellation
                ),
                null,
                "prepareRename обязан отказать: модель отстала от документа"
            );
            assert.strictEqual(
                await handlers.rename(
                    {
                        textDocument: { uri: URI },
                        position,
                        newName: "Renamed"
                    },
                    cancellation
                ),
                null,
                "Rename по отставшей модели правил бы не те места"
            );
            assert.deepStrictEqual(
                await handlers.documentHighlight(
                    { textDocument: { uri: URI }, position },
                    cancellation
                ),
                [],
                "Подсветка вхождений по отставшей модели указала бы не туда"
            );
        }
    );

    await test(
        "Semantic Tokens не кэшируют результат отменённого запроса",
        async () => {
            const { handlers } = createRegistry({
                uri: URI,
                source: SOURCE
            });
            const cancelled = { isCancellationRequested: true };

            const first = await handlers.semanticTokens(
                { textDocument: { uri: URI } },
                cancelled
            );
            assert.deepStrictEqual(
                first.data,
                [],
                "Отменённый запрос не должен возвращать токены"
            );

            /* Следующий запрос обязан посчитать заново, а не отдать пустое. */
            const second = await handlers.semanticTokens(
                { textDocument: { uri: URI } },
                { isCancellationRequested: false }
            );
            assert.ok(
                second.data.length > 0,
                "Пустой результат отменённого запроса попал в кэш"
            );
        }
    );

    await test(
        "Semantic Tokens и подсказки не форсируют разбор",
        async () => {
            /*
             * Оба запроса редактор шлёт сам на каждое нажатие клавиши. Если
             * они снимают debounce, полный разбор идёт на каждый набранный
             * символ — при том, что ради этого debounce и существует.
             */
            const { handlers, calls, state } = createRegistry({
                uri: URI,
                source: SOURCE
            });

            /* Документ ушёл вперёд: модели этой версии ещё нет. */
            bumpVersion(state, CHANGED);
            calls.forced = 0;
            calls.requested = 0;
            await handlers.semanticTokens(
                { textDocument: { uri: URI } },
                { isCancellationRequested: false }
            );
            await handlers.inlayHint(
                {
                    textDocument: { uri: URI },
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 6, character: 0 }
                    }
                },
                { isCancellationRequested: false }
            );

            assert.strictEqual(
                calls.forced,
                0,
                "ни подсветка, ни подсказки не имеют права торопить разбор"
            );
            assert.ok(
                calls.requested > 0,
                "но разбор всё же должен быть запрошен, иначе модели не будет"
            );
        }
    );

    await test(
        "Ctrl+Space и точка торопят разбор, набор букв — нет",
        async () => {
            /*
             * Пользователь, открывший список, ждёт его сейчас. Поток букв,
             * наоборот, идёт на каждый символ, и разбор по нему снимал бы
             * склейку правок.
             *
             * Проверяется путь БЕЗ готовой модели: когда она есть, разбор не
             * нужен вовсе и не назначается — ни тем, ни другим запросом.
             */
            const { handlers, calls, state } = createRegistry({
                uri: URI,
                source: SOURCE
            });
            bumpVersion(state, CHANGED);
            const request = context => {
                calls.forced = 0;
                calls.scheduled = 0;
                return handlers.completion(
                    {
                        textDocument: { uri: URI },
                        position: { line: 1, character: 2 },
                        context
                    },
                    { isCancellationRequested: false }
                );
            };

            /* Ctrl+Space. */
            await request({ triggerKind: 1 });
            assert.strictEqual(calls.forced, 1, "Ctrl+Space назначает разбор");

            /* Точка. */
            await request({ triggerKind: 2, triggerCharacter: "." });
            assert.strictEqual(calls.forced, 1, "trigger-символ тоже");

            /* Повторный запрос по неполному списку — это поток набора. */
            await request({ triggerKind: 3 });
            assert.strictEqual(
                calls.forced,
                0,
                "набор букв обязан ждать уже назначенный разбор"
            );
            assert.strictEqual(
                calls.scheduled,
                1,
                "но модель ему всё равно нужна"
            );
        }
    );

    await test(
        "слишком большой файл не лексируется ради базовой подсветки",
        async () => {
            /*
             * Ограничение размера проверялось по модулю, то есть только после
             * его построения. До этого файл любого размера успевал целиком
             * пройти лексер ради временной подсветки — ровно того, что
             * настройка и запрещает.
             */
            const { handlers, calls } = createRegistry({
                uri: URI,
                source: SOURCE,
                settings: {
                    ...defaults,
                    semanticHighlighting: { maxFileSizeKb: 0.001 }
                }
            });

            calls.fastSnapshots = 0;
            const result = await handlers.semanticTokens(
                { textDocument: { uri: URI } },
                { isCancellationRequested: false }
            );

            assert.deepStrictEqual(result.data, []);
            assert.strictEqual(
                calls.fastSnapshots,
                0,
                "токены запрещённого по размеру файла не должны строиться"
            );
        }
    );

    await test(
        "Semantic Tokens Range не отвечает по изменившейся версии",
        async () => {
            const { handlers } = createRegistry({
                uri: URI,
                source: SOURCE,
                onParsed: current => bumpVersion(current, CHANGED)
            });

            const result = await handlers.semanticTokensRange(
                {
                    textDocument: { uri: URI },
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 6, character: 0 }
                    }
                },
                { isCancellationRequested: false }
            );

            assert.deepStrictEqual(
                result.data,
                [],
                "Подсветка по смещениям прежней версии легла бы на чужие места"
            );
        }
    );

    /*
     * Диагностика покинутого файла обязана прекращаться на границе этапов, а не
     * доводиться до конца: иначе она занимает основной поток перед тем файлом,
     * который пользователь ждёт.
     */
    await test(
        "этапы диагностики покинутого файла не доходят до конца",
        async () => {
            const first = "file:///d:/races/first.mac";
            const second = "file:///d:/races/second.mac";
            const sources = {
                [first]: "Macro A()\n  Var unusedA;\n  DebugBreak;\nEnd;",
                [second]: "Macro B()\n  Var unusedB;\nEnd;"
            };
            const documents = new Map([
                [first, createDocument(first, 1, sources[first])],
                [second, createDocument(second, 1, sources[second])]
            ]);
            const index = new WorkspaceIndex();
            index.registerWorkspaceFiles([first, second]);
            for (const uri of [first, second]) {
                index.updateOpenModule(uri, sources[uri], 1);
            }

            const stagesRun = [];
            const engine = new RslDiagnosticEngine();
            let coordinator;

            /*
             * Правило считает вызовы своей проверки отмены и заодно уходит с
             * активного файла — так выглядит переключение вкладки во время
             * расчёта.
             */
            engine.register({
                id: "test-stage-counter",
                phase: "local",
                run: context => {
                    stagesRun.push(context.module.uri);
                    if (context.module.uri === first) {
                        coordinator.setActiveDocument(second);
                    }
                    return [];
                }
            });
            engine.register({
                id: "test-stage-after",
                phase: "local",
                run: context => {
                    stagesRun.push(`after:${context.module.uri}`);
                    return [];
                }
            });

            coordinator = new DiagnosticsCoordinator(
                { sendDiagnostics: () => undefined },
                {
                    get: uri => documents.get(uri),
                    all: () => [...documents.values()]
                },
                index,
                { getAvailable: () => defaults },
                engine,
                {
                    isParseBusy: () => false,
                    waitForIdle: () => Promise.resolve(),
                    log: () => undefined,
                    onImports: () => undefined,
                    localDebounceMs: 0,
                    workspaceDebounceMs: 20,
                    workspaceMaxWaitMs: 60
                }
            );

            coordinator.setActiveDocument(first);
            await new Promise(resolve => setTimeout(resolve, 200));

            assert.ok(
                stagesRun.includes(first),
                `Первый этап обязан выполниться: ${stagesRun.join(", ")}`
            );
            assert.ok(
                !stagesRun.includes(`after:${first}`),
                "После уходa с файла следующий этап выполняться не должен; " +
                    `выполнено: ${stagesRun.join(", ")}`
            );

            coordinator.close(first);
            coordinator.close(second);
        }
    );

    /*
     * Переключение вкладки ВО ВРЕМЯ расчёта, а не между этапами.
     *
     * Отличие от предыдущего теста принципиальное: там переключение
     * происходило синхронно внутри правила, то есть до следующей проверки
     * отмены. Здесь оно назначается через setImmediate — ровно так его
     * доставляет транспорт, — и обнаружить его можно только если расчёт
     * действительно вернул управление event loop. Непрерываемый расчёт
     * доводится до конца и этот тест не проходит.
     *
     * Проверяется не только отсутствие публикации: важно, что оставшиеся этапы
     * не выполнились. Иначе «прерываемость» сводилась бы к молчанию в конце,
     * а процессорное время всё равно тратилось бы на покинутый файл.
     */
    await test(
        "смена активного файла через setImmediate обрывает оставшиеся этапы",
        async () => {
            const first = "file:///d:/races/slow.mac";
            const second = "file:///d:/races/other.mac";
            const sources = {
                [first]: "Macro A()\n  Var unusedA;\nEnd;",
                [second]: "Macro B()\n  Var unusedB;\nEnd;"
            };
            const documents = new Map([
                [first, createDocument(first, 1, sources[first])],
                [second, createDocument(second, 1, sources[second])]
            ]);
            const index = new WorkspaceIndex();
            index.registerWorkspaceFiles([first, second]);
            for (const uri of [first, second]) {
                index.updateOpenModule(uri, sources[uri], 1);
            }

            const stagesRun = [];
            const published = [];
            const engine = new RslDiagnosticEngine();
            let coordinator;
            let switched = false;

            /*
             * Первый этап НАЗНАЧАЕТ переключение и занимает больше одной порции.
             *
             * Оба условия существенны. Переключение назначается через
             * setImmediate, потому что именно так его приносит транспорт: пока
             * расчёт не отдаст управление, узнать о нём невозможно. А работы
             * должно быть больше бюджета порции — иначе прерывать нечего, и
             * расчёт законно доходит до конца.
             */
            const BUSY_MS = 30;
            engine.register({
                id: "test-schedule-switch",
                phase: "local",
                run: context => {
                    stagesRun.push(`stage1:${context.module.uri}`);
                    if (context.module.uri === first && !switched) {
                        switched = true;
                        setImmediate(() =>
                            coordinator.setActiveDocument(second)
                        );
                    }
                    const until = Date.now() + BUSY_MS;
                    while (Date.now() < until) {
                        /* Занятое ожидание: так выглядит тяжёлый этап. */
                    }
                    return [];
                }
            });
            engine.register({
                id: "test-stage-after-switch",
                phase: "local",
                run: context => {
                    stagesRun.push(`stage2:${context.module.uri}`);
                    return [];
                }
            });

            coordinator = new DiagnosticsCoordinator(
                {
                    sendDiagnostics: params => published.push({
                        uri: params.uri,
                        count: params.diagnostics.length
                    })
                },
                {
                    get: uri => documents.get(uri),
                    all: () => [...documents.values()]
                },
                index,
                { getAvailable: () => defaults },
                engine,
                {
                    isParseBusy: () => false,
                    waitForIdle: () => Promise.resolve(),
                    log: () => undefined,
                    onImports: () => undefined,
                    localDebounceMs: 0,
                    workspaceDebounceMs: 5000,
                    workspaceMaxWaitMs: 5000
                }
            );

            coordinator.setActiveDocument(first);
            await new Promise(resolve => setTimeout(resolve, 250));

            assert.ok(
                stagesRun.includes(`stage1:${first}`),
                `Первый этап обязан выполниться: ${stagesRun.join(", ")}`
            );
            assert.ok(
                !stagesRun.includes(`stage2:${first}`),
                "Оставшиеся этапы покинутого файла обязаны прекратиться, а " +
                    `не только не публиковаться: ${stagesRun.join(", ")}`
            );
            /*
             * Пустая публикация для first есть и должна быть: ею
             * setActiveDocument объявляет, какой файл сейчас показывается.
             * Недопустимо другое — отдать НАЙДЕННОЕ прерванным расчётом.
             */
            assert.ok(
                published.some(item => item.uri === second),
                `Новый активный файл обязан быть посчитан: ${
                    JSON.stringify(published)}`
            );
            assert.ok(
                published
                    .filter(item => item.uri === first)
                    .every(item => item.count === 0),
                `Результат прерванного расчёта публиковать нельзя: ${
                    JSON.stringify(published)}`
            );
            assert.ok(
                stagesRun.includes(`stage1:${second}`),
                `Расчёт обязан перейти на новый активный файл: ${
                    stagesRun.join(", ")}`
            );

            coordinator.close(first);
            coordinator.close(second);
        }
    );

    console.log("");
    console.log(`Пройдено: ${passed}`);
    console.log(`Ошибок: ${failed}`);

    if (failed > 0) {
        process.exitCode = 1;
    }
})();
