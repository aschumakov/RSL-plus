import * as path from "path";

import {
    workspace,
    ExtensionContext,
    window,
    commands,
    StatusBarItem,
    StatusBarAlignment,
    QuickPickItem,
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
        const document = await workspace.openTextDocument(
            uriFromValue(value)
        );

        await window.showTextDocument(document);
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


/**
 * Language server использует активный URI, чтобы Problems не терял текущий
 * файл среди групп, которые VS Code сортирует самостоятельно. Resource-
 * настройки вычисляются здесь же, без workspace/configuration round-trip.
 */
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
    const performanceLogFile = readSetting(
        "performance.logFile",
        ""
    ).trim();
    const initialSettings = readRslSettings();

    context.subscriptions.push(macroFileWatcher);

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                scheme: "file",
                language: "rsl"
            }
        ],
        synchronize: {
            fileEvents: macroFileWatcher
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
            notifyActiveDocument().then(
                undefined,
                error => console.error(
                    "RSL: active document notification failed",
                    error
                )
            );
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
            "getFilebyName",
            (name: string) => {
                getFilebyName(name).then(
                    undefined,
                    error => {
                        console.error(
                            "RSL: getFilebyName failed",
                            name,
                            error
                        );
                    }
                );
            }
        ),
        client.onNotification(
            "getFile",
            (filePath: string) => {
                getFile(filePath).then(
                    undefined,
                    error => {
                        console.error(
                            "RSL: getFile failed",
                            filePath,
                            error
                        );
                    }
                );
            }
        ),
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


async function getFile(filePath: string): Promise<void> {
    if (!filePath) {
        return;
    }

    await workspace.openTextDocument(
        uriFromValue(filePath)
    );
}


async function getFilebyName(
    name: string
): Promise<void> {
    if (!name) {
        return;
    }

    const files = await workspace.findFiles(
        `**/${name}`,
        null,
        1
    );

    if (files.length > 0) {
        await workspace.openTextDocument(
            files[0]
        );
    }
}


export function deactivate():
    Promise<void> | undefined {
    languageClientStarted = false;

    if (client === undefined) {
        return undefined;
    }

    return client.stop();
}
