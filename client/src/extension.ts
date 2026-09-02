import * as path from "path";

import {
    workspace,
    ExtensionContext,
    window,
    commands,
    StatusBarItem,
    StatusBarAlignment,
    QuickPickItem,
    Position,
    ProgressLocation,
    Range,
    Selection,
    Uri,
    TextEditor
} from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from "vscode-languageclient/node";

import { readRslSettings, readSetting } from "./clientSettings";
import { registerRslDependencyView } from "./dependencyView";
import { openRslDocument } from "./documentOpenPolicy";
import { registerEditorCommands } from "./editorCommands";


let client: LanguageClient;
let languageClientStarted = false;
let activeEditor: TextEditor | undefined = window.activeTextEditor;
let myStatusBarItem: StatusBarItem;

interface IClientPerformanceFields {
    [name: string]: string | number | boolean | null | undefined;
}


/**
 * Элемент списка открытых/загруженных макросов.
 */
class FileItem implements QuickPickItem {
    label: string;
    description: string;
    public isThatDoc: boolean;

    constructor(public MacUri: string) {
        const activeUri = activeEditor !== undefined
            ? activeEditor.document.uri.toString()
            : "";

        this.isThatDoc = activeUri === MacUri;
        this.label = "$(file) " + path.basename(MacUri);

        const workspaceFolder =
            workspace.workspaceFolders !== undefined &&
            workspace.workspaceFolders.length > 0
                ? workspace.workspaceFolders[0]
                : undefined;

        if (this.isThatDoc) {
            this.description = "Текущий файл";
        } else if (workspaceFolder !== undefined) {
            this.description = path.dirname(
                path.relative(
                    workspaceFolder.uri.fsPath,
                    uriFromValue(MacUri).fsPath
                )
            );
        } else {
            this.description = path.dirname(MacUri);
        }
    }
}


/**
 * Преобразует file URI или обычный путь в Uri.
 */
function uriFromValue(value: string): Uri {
    if (
        value.indexOf("file://") === 0 ||
        value.indexOf("untitled:") === 0
    ) {
        return Uri.parse(value);
    }

    return Uri.file(value);
}


/**
 * Открывает файл и показывает его в редакторе.
 */
async function quickOpen(value: string): Promise<void> {
    if (!value) {
        return;
    }

    try {
        /*
         * Выбор в списке — явное действие пользователя, и preview
         * указывается явно: без параметра поведение зависит от настройки
         * workbench.editor.enablePreview и различается у разных людей.
         */
        await openRslDocument(
            { openTextDocument: workspace.openTextDocument, 
                showTextDocument: window.showTextDocument },
            uriFromValue(value),
            "quickPick"
        );
    } catch (error) {
        console.error("RSL: cannot open file", value, error);

        window.showErrorMessage(
            "Не удалось открыть файл макроса: " + value
        );
    }
}


/**
 * Показывает список файлов, известных language server.
 */
function activeRslDocumentUri(): string | null {
    if (
        activeEditor === undefined ||
        activeEditor.document.languageId !== "rsl"
    ) {
        return null;
    }

    return activeEditor.document.uri.toString();
}

function sendClientPerformance(
    event: string,
    fields: IClientPerformanceFields = {}
): void {
    if (!languageClientStarted || client === undefined) {
        return;
    }

    client.sendNotification("clientPerformance", {
        event,
        clientAtMs: Date.now(),
        ...fields
    }).then(
        undefined,
        error => console.error(
            "RSL: client performance notification failed",
            error
        )
    );
}


/*
 * Пауза, за которую серия переключений вкладок склеивается в одно уведомление.
 *
 * Пролистывание по Ctrl+Tab даёт событие на каждую вкладку, а серверу важна
 * только последняя: на промежуточные он начинал разбор и расчёт Problems,
 * которые тут же становились ненужными. Значение маленькое намеренно — при
 * обычном переходе в файл задержка не должна быть заметна.
 */
const ACTIVE_DOCUMENT_COALESCE_MS = 60;

let activeDocumentTimer: NodeJS.Timeout | undefined;
let activeDocumentSentAtMs = 0;

/**
 * Language server использует активный URI, чтобы Problems не терял текущий
 * файл среди групп, которые VS Code сортирует самостоятельно. Resource-
 * настройки вычисляются здесь же, без workspace/configuration round-trip.
 *
 * ПЕРВОЕ уведомление уходит сразу, склеиваются только следующие за ним
 * быстрые переключения (см. ACTIVE_DOCUMENT_COALESCE_MS). Раньше задержке
 * подвергалось любое уведомление, включая одиночный переход в файл: сервер
 * узнавал об активной вкладке с опозданием и до этого продолжал считать
 * покинутый файл — то самое время, которого ждёт пользователь.
 *
 * Настройки читаются в момент отправки, то есть один раз на серию, а не на
 * каждую вкладку.
 */
function notifyActiveDocumentSoon(): void {
    if (activeDocumentTimer) {
        clearTimeout(activeDocumentTimer);
        activeDocumentTimer = undefined;
    }

    const sinceLastMs = Date.now() - activeDocumentSentAtMs;

    if (sinceLastMs >= ACTIVE_DOCUMENT_COALESCE_MS) {
        sendActiveDocumentNotification();
        return;
    }

    activeDocumentTimer = setTimeout(
        () => {
            activeDocumentTimer = undefined;
            sendActiveDocumentNotification();
        },
        ACTIVE_DOCUMENT_COALESCE_MS - sinceLastMs
    );
}

function sendActiveDocumentNotification(): void {
    activeDocumentSentAtMs = Date.now();
    notifyActiveDocument().then(
        undefined,
        error => console.error(
            "RSL: active document notification failed",
            error
        )
    );
}

async function notifyActiveDocument(): Promise<void> {
    if (!languageClientStarted || client === undefined) {
        return;
    }

    const uri = activeRslDocumentUri();
    const resource = uri ? Uri.parse(uri) : undefined;
    const clientAtMs = Date.now();

    await client.sendNotification("activeDocumentChanged", {
        uri,
        settings: resource ? readRslSettings(resource) : undefined,
        clientAtMs
    });
}

async function showQuickPick(): Promise<void> {
    if (client === undefined) {
        return;
    }

    try {
        const macros = await client.sendRequest<string[]>(
            "getMacros"
        );

        const input = window.createQuickPick<FileItem>();

        input.placeholder = "Начните вводить имя";
        input.items = macros.map(value => new FileItem(value));

        input.onDidAccept(() => {
            const selected = input.selectedItems[0];

            if (selected === undefined) {
                return;
            }

            input.hide();

            if (!selected.isThatDoc) {
                quickOpen(selected.MacUri).then(
                    undefined,
                    error => {
                        console.error(
                            "RSL: quickOpen failed",
                            error
                        );
                    }
                );
            }
        });

        input.onDidHide(() => {
            input.dispose();
        });

        input.show();
    } catch (error) {
        console.error(
            "RSL: cannot get macro file list",
            error
        );

        window.showErrorMessage(
            "Не удалось получить список макросов. " +
            "Смотри Output → R-Style Language Server."
        );
    }
}

/**
 * Точка входа расширения.
 */
export function activate(context: ExtensionContext): void {
    /*
     * Локальные команды редактора регистрируются до создания language
     * client. Enter не должен зависеть от запуска сервера или фоновой
     * инвентаризации workspace.
     */
    registerEditorCommands(context, {
        getClient: () => client,
        isClientReady: () => languageClientStarted
    });

    const serverModule = context.asAbsolutePath(
        path.join("server", "out", "server.js")
    );

    /*
     * Для стабильного повседневного запуска не используем
     * фиксированный --inspect=6009.
     *
     * Когда потребуется отладка именно language server,
     * можно временно вернуть:
     * execArgv: ["--nolazy", "--inspect=6009"]
     */
    const debugOptions = {
        execArgv: ["--nolazy"]
    };

    const serverOptions: ServerOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    const macroFileWatcher =
        workspace.createFileSystemWatcher("**/*.mac");
    /*
     * .editorconfig тоже наблюдается: из него берётся отступ при
     * форматировании, и правка файла обязана действовать сразу, а не
     * после перезапуска редактора.
     */
    const editorConfigWatcher =
        workspace.createFileSystemWatcher("**/.editorconfig");
    const performanceLogFile = readSetting(
        "performance.logFile",
        ""
    ).trim();
    const initialSettings = readRslSettings();

    context.subscriptions.push(macroFileWatcher, editorConfigWatcher);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                scheme: "file",
                language: "rsl"
            }
        ],
        synchronize: {
            fileEvents: [macroFileWatcher, editorConfigWatcher]
        },
        middleware: {
            provideDocumentSymbols: async (document, token, next) => {
                const startedAtMs = Date.now();
                sendClientPerformance("client.outline.request", {
                    uri: document.uri.toString()
                });
                const result = await next(document, token);
                sendClientPerformance("client.outline.response", {
                    uri: document.uri.toString(),
                    durationMs: Date.now() - startedAtMs
                });
                return result;
            }
        },
        initializationOptions: {
            referenceIndexCachePath: context.storageUri
                ? Uri.joinPath(
                    context.storageUri,
                    "reference-index-v2.json"
                ).fsPath
                : undefined,
            /*
             * Каталог постоянных записей о ссылках. Версия в имени: при смене
             * формата прежние записи не читаются, а не толкуются наугад.
             */
            referenceShardsPath: context.storageUri
                ? Uri.joinPath(context.storageUri, "reference-shards-v1").fsPath
                : undefined,
            /*
             * Сохранённый состав проекта. Благодаря ему Ctrl+T отвечает по
             * всему проекту сразу после запуска, а обход правит только то,
             * что изменилось.
             */
            catalogStorePath: context.storageUri
                ? Uri.joinPath(context.storageUri, "catalog-store-v1").fsPath
                : undefined,
            /*
             * Кэш компактных сводок внешних модулей. Версия в имени файла: при
             * смене формата старый файл просто перестаёт читаться, и его не
             * нужно ни переносить, ни удалять вручную.
             */
            compactModuleCachePath: context.storageUri
                ? Uri.joinPath(
                    context.storageUri,
                    "compact-modules-v1.json"
                ).fsPath
                : undefined,
            performanceLogFile: performanceLogFile || undefined,
            initialSettings,
            activeDocumentUri: activeRslDocumentUri()
        }
    };

    client = new LanguageClient(
        "RSTyleLanguage",
        "R-Style Language Server",
        serverOptions,
        clientOptions
    );
    /*
     * Начиная с vscode-languageclient 8.x обработчики можно и нужно
     * регистрировать до запуска клиента. Это исключает потерю ранних
     * сообщений от language server.
     */
    registerServerNotifications(context);

    client.start().then(
        async () => {
            languageClientStarted = true;

            /* Активный файл известен серверу до фонового обхода workspace. */
            await notifyActiveDocument();

            await client.sendNotification("clientReady");
        },
        error => {
            console.error(
                "RSL language client start failed",
                error
            );

            window.showErrorMessage(
                "Не удалось запустить RSL language server. " +
                "Смотри Output → R-Style Language Server."
            );

            return undefined;
        }
    ).then(
        undefined,
        error => {
            console.error(
                "RSL clientReady notification failed",
                error
            );
        }
    );

    /*
     * Неиспользуемые объявления теперь рассчитываются language server
     * и выводятся как Diagnostics в панели Problems.
     */
    context.subscriptions.push(
        window.onDidChangeActiveTextEditor(editor => {
            activeEditor = editor;
            /* Серия быстрых переключений уходит одним уведомлением. */
            notifyActiveDocumentSoon();
        }),
        workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration("rslPlus")) {
                return;
            }
            notifyActiveDocument().then(
                undefined,
                error => console.error(
                    "RSL: active settings notification failed",
                    error
                )
            );
        })
    );

    /*
     * Что сервер держит в памяти.
     *
     * Общая цифра heap не отвечает ни на вопрос «кто занял», ни на вопрос
     * «почему выросло»: постоянных структур много, и каждая молча добавляет к
     * сумме. Отчёт показывает их по отдельности.
     */
    context.subscriptions.push(
        commands.registerCommand("rsl.showServerStatus", () => {
            const channel = window.createOutputChannel("RSL-plus: память");

            void client.sendRequest("rsl/serverStatus").then(
                (answer: unknown) => {
                    const report = (answer as { report?: string })?.report;

                    channel.appendLine(report || "Сервер не ответил");
                    channel.show(true);
                },
                error => {
                    channel.appendLine(
                        "RSL: не удалось получить состояние сервера: " + error
                    );
                    channel.show(true);
                }
            );
        })
    );

    /*
     * Куда ведёт строка над объявлением.
     *
     * Панель References и Call Hierarchy — встроенные представления VS Code, и
     * считают они сами. Если их команд в этой сборке редактора нет, остаётся
     * обычный переход к ссылкам: он есть всегда.
     */
    const revealAt = async (
        uriText: string,
        position: { line: number; character: number },
        preferred: string
    ): Promise<void> => {
        const uri = Uri.parse(uriText);
        const at = new Position(position.line, position.character);
        const editor = await window.showTextDocument(uri, { preview: false });

        editor.selection = new Selection(at, at);
        editor.revealRange(new Range(at, at));

        const available = await commands.getCommands(true);

        await commands.executeCommand(
            available.includes(preferred) ? preferred : "editor.action.goToReferences",
            uri,
            at
        );
    };

    context.subscriptions.push(
        commands.registerCommand(
            "rsl.showReferences",
            (uriText: string, position: { line: number; character: number }) =>
                revealAt(uriText, position, "references-view.findReferences")
        ),
        commands.registerCommand(
            "rsl.showCallHierarchy",
            (uriText: string, position: { line: number; character: number }) =>
                revealAt(uriText, position, "references-view.showCallHierarchy")
        )
    );

    /*
     * Инспекторы: показывают состояние, по которому сервер отвечал.
     *
     * Работают только по команде и на обычную работу не влияют — ни кэшей не
     * греют, ни индексации не запускают. Нужны там, где ответ выглядит
     * неверным: между текстом и ответом лежат замыкание Import, ревизии
     * интерфейсов и кэши, и без такого отчёта разбираться в этом тяжело.
     */
    const inspectors: Array<[string, string, string]> = [
        ["rsl.showSyntaxTree", "syntaxTree", "Синтаксическое дерево"],
        ["rsl.showSymbolTree", "symbolTree", "Дерево символов"],
        ["rsl.showModuleInterface", "moduleInterface", "Интерфейс модуля"],
        ["rsl.showImportClosure", "importClosure", "Замыкание Import"],
        ["rsl.explainSymbol", "explainSymbol", "Символ под курсором"],
        ["rsl.explainType", "explainType", "Тип под курсором"]
    ];

    for (const [command, kind, title] of inspectors) {
        context.subscriptions.push(
            commands.registerCommand(command, () => {
                const editor = window.activeTextEditor;

                if (!editor) {
                    void window.showInformationMessage(
                        "RSL: откройте файл, о котором спрашиваете"
                    );

                    return;
                }

                const channel = window.createOutputChannel(
                    "RSL-plus: " + title
                );

                void client.sendRequest("rsl/inspect", {
                    kind,
                    uri: editor.document.uri.toString(),
                    offset: editor.document.offsetAt(editor.selection.active)
                }).then(
                    (answer: unknown) => {
                        const report = (answer as { report?: string })?.report;

                        channel.appendLine(report || "Сервер не ответил");
                        channel.show(true);
                    },
                    error => {
                        channel.appendLine("RSL: отчёт не получен: " + error);
                        channel.show(true);
                    }
                );
            })
        );
    }

    /*
     * Структурный поиск: по явной команде.
     *
     * Образец описывает форму вызова, а не текст: `ExecMacroFile($file,
     * $args...)` найдёт вызов и с переносами строк, и с вложенным вызовом в
     * аргументе — там, где регулярное выражение уже не совпадает.
     */
    context.subscriptions.push(
        commands.registerCommand("rsl.structuralSearch", async () => {
            const pattern = await window.showInputBox({
                title: "RSL: структурный поиск",
                prompt: "Образец вызова; $имя — один аргумент, $имя... — остальные",
                placeHolder: "ExecMacroFile($file, $args...)"
            });

            if (!pattern) {
                return;
            }

            const channel = window.createOutputChannel(
                "RSL-plus: структурный поиск"
            );

            channel.appendLine("Образец: " + pattern);
            channel.show(true);

            const answer = await window.withProgress(
                {
                    location: ProgressLocation.Window,
                    title: "RSL: структурный поиск",
                    cancellable: true
                },
                (_progress, token) => client.sendRequest<{
                    hits?: Array<{
                        uri: string;
                        range: { start: { line: number; character: number } };
                        text: string;
                    }>;
                    scannedFiles?: number;
                    skippedFiles?: number;
                    problem?: string;
                    cancelled?: boolean;
                    truncated?: boolean;
                }>("rsl/structuralSearch", { pattern }, token)
            );

            if (answer?.problem) {
                channel.appendLine("Образец не разобран: " + answer.problem);

                return;
            }

            for (const hit of answer?.hits || []) {
                channel.appendLine(
                    Uri.parse(hit.uri).fsPath + ":" +
                    (hit.range.start.line + 1) + "  " +
                    hit.text.replace(/s+/gu, " ")
                );
            }

            channel.appendLine(
                "Найдено " + (answer?.hits?.length || 0) +
                "; прочитано файлов " + (answer?.scannedFiles || 0) +
                ", отсеяно до чтения " + (answer?.skippedFiles || 0) +
                (answer?.cancelled ? "; поиск отменён" : "") +
                (answer?.truncated ? "; показано не всё" : "")
            );
        })
    );

    /*
     * Заглушка модуля: объявления без тел.
     *
     * Библиотеки и платформенные компоненты приходят без исходников, и
     * заглушка — обычный файл RSL, по которому работает всё остальное:
     * подсказка, Hover, подпись, переход, вывод типа.
     */
    context.subscriptions.push(
        commands.registerCommand("rsl.generateStub", async () => {
            const editor = window.activeTextEditor;

            if (!editor) {
                void window.showInformationMessage(
                    "RSL: откройте файл, для которого нужна заглушка"
                );

                return;
            }

            const answer = await client.sendRequest<{
                text?: string;
                error?: string;
            }>("rsl/generateStub", {
                uri: editor.document.uri.toString()
            });

            if (!answer?.text) {
                void window.showWarningMessage(
                    "RSL: заглушка не создана: " + (answer?.error || "нет ответа")
                );

                return;
            }

            /*
             * Заглушка открывается новым документом, а не пишется на диск:
             * куда её положить, решает пользователь — путь зависит от
             * stubPaths в настройке проекта.
             */
            const document = await workspace.openTextDocument({
                content: answer.text,
                language: "rsl"
            });

            await window.showTextDocument(document);
        })
    );

    /* Панель зависимостей: спрашивает сервер по узлу, когда его раскрывают. */
    registerRslDependencyView(context, client);

    const showMacrosCommand = "rsl.showMacroFiles";

    context.subscriptions.push(
        commands.registerCommand(
            showMacrosCommand,
            () => {
                showQuickPick().then(
                    undefined,
                    error => {
                        console.error(
                            "RSL: showQuickPick failed",
                            error
                        );
                    }
                );
            }
        )
    );

    myStatusBarItem =
        window.createStatusBarItem(
            StatusBarAlignment.Right,
            500
        );

    myStatusBarItem.command = showMacrosCommand;

    context.subscriptions.push(
        myStatusBarItem
    );

    updateStatusBarItem(0);

}


/**
 * Регистрирует сообщения, которые сервер отправляет клиенту.
 *
 * Обработчики регистрируются до client.start(), поэтому сервер не
 * может прислать раннее сообщение до появления соответствующего
 * обработчика на стороне расширения.
 */
function registerServerNotifications(
    context: ExtensionContext
): void {
    context.subscriptions.push(
        client.onNotification(
            "updateStatusBar",
            (value: number) => {
                updateStatusBarItem(value);
            }
        ),
        client.onNotification(
            "noRootFolder",
            () => {
                window.showErrorMessage(
                    "Импорт макросов недоступен. " +
                    "Для полноценной работы необходимо " +
                    "открыть папку или рабочую область."
                );
            }
        )
    );
}


function updateStatusBarItem(value: number): void {
    if (myStatusBarItem === undefined) {
        return;
    }

    if (value > 0) {
        myStatusBarItem.text =
            `$(file) ${value} макросов`;

        myStatusBarItem.tooltip =
            "Показать список";

        myStatusBarItem.show();
    } else {
        myStatusBarItem.hide();
    }
}



export function deactivate():
    Promise<void> | undefined {
    languageClientStarted = false;

    /* Отложенное уведомление отправлять уже некуда. */
    if (activeDocumentTimer) {
        clearTimeout(activeDocumentTimer);
        activeDocumentTimer = undefined;
    }

    if (client === undefined) {
        return undefined;
    }

    return client.stop();
}
