import * as path from "path";

import {
    workspace,
    ExtensionContext,
    window,
    DecorationOptions,
    Range,
    commands,
    StatusBarItem,
    StatusBarAlignment,
    QuickPickItem,
    Uri,
    env,
    TextEditor
} from "vscode";

import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from "vscode-languageclient";


let client: LanguageClient;
let timeout: NodeJS.Timer | undefined;
let activeEditor: TextEditor | undefined = window.activeTextEditor;
let myStatusBarItem: StatusBarItem;


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
 * Декоратор неиспользуемых переменных и макросов.
 */
const notUsedVar = window.createTextEditorDecorationType({
    opacity: "0.5",
    fontStyle: "italic"
});


function isWhitespaceRange(
    text: string,
    start: number,
    end: number
): boolean {
    for (let index = start; index < end; index++) {
        const char = text.charAt(index);

        if (
            char !== " " &&
            char !== "\t" &&
            char !== "\r" &&
            char !== "\n"
        ) {
            return false;
        }
    }

    return true;
}


interface IDeclarationInfo {
    name: string;
    start: number;
    end: number;
}


/**
 * Один линейный проход по идентификаторам:
 * одновременно считаем частоту имён и запоминаем объявления.
 *
 * Раньше для каждого объявления заново сканировался остаток файла,
 * что давало квадратичную сложность на больших макросах.
 */
function updateDecorations(): void {
    if (activeEditor === undefined) {
        return;
    }

    const editor = activeEditor;
    const text = editor.document.getText();

    const identifierPattern =
        /[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*/g;

    const declarationKeywords: {
        [name: string]: boolean
    } = {
        /*
         * Macro не проверяем как локальное неиспользуемое
         * объявление: макрос может быть точкой входа и вызываться
         * из другого файла или непосредственно средой RS-Bank.
         */
        var: true,
        const: true,
        array: true,
        record: true
    };

    const identifierCount: {
        [name: string]: number
    } = Object.create(null);

    const declarations: IDeclarationInfo[] = [];

    let expectDeclaration = false;
    let previousTokenEnd = 0;
    let match: RegExpExecArray | null;

    while (
        (match = identifierPattern.exec(text)) !== null
    ) {
        const name = match[0];
        const normalizedName =
            name.toLowerCase();

        identifierCount[normalizedName] =
            (identifierCount[normalizedName] || 0) + 1;

        if (
            expectDeclaration &&
            isWhitespaceRange(
                text,
                previousTokenEnd,
                match.index
            )
        ) {
            declarations.push({
                name: normalizedName,
                start: match.index,
                end: match.index + name.length
            });
        }

        expectDeclaration =
            declarationKeywords[normalizedName] === true;

        previousTokenEnd =
            match.index + name.length;
    }

    const decorationArr: DecorationOptions[] = [];

    declarations.forEach(declaration => {
        if (
            identifierCount[declaration.name] !== 1
        ) {
            return;
        }

        decorationArr.push({
            range: new Range(
                editor.document.positionAt(
                    declaration.start
                ),
                editor.document.positionAt(
                    declaration.end
                )
            ),
            hoverMessage:
                "Объявление **" +
                text.substring(
                    declaration.start,
                    declaration.end
                ) +
                "** не было использовано в данном файле"
        });
    });

    editor.setDecorations(
        notUsedVar,
        decorationArr
    );
}


/**
 * Точка входа расширения.
 */
export function activate(context: ExtensionContext): void {
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

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                scheme: "file",
                language: "rsl"
            }
        ],
        synchronize: {
            fileEvents:
                workspace.createFileSystemWatcher(
                    "**/.clientrc"
                )
        }
    };

    client = new LanguageClient(
        "RSTyleLanguage",
        "R-Style Language Server",
        serverOptions,
        clientOptions
    );

    /*
     * LanguageClient запускается первым.
     *
     * Сервер не должен отправлять пользовательские notifications
     * до получения clientReady.
     */
    client.start();

    client.onReady().then(
        () => {
            registerServerNotifications();

            /*
             * Явно сообщаем серверу, что обработчики клиента
             * уже зарегистрированы.
             */
            client.sendNotification("clientReady");
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
        }
    );

    if (activeEditor !== undefined) {
        triggerUpdateDecorations();
    }

    context.subscriptions.push(
        workspace.onDidChangeTextDocument(event => {
            if (
                activeEditor !== undefined &&
                event.document === activeEditor.document
            ) {
                triggerUpdateDecorations();
            }
        })
    );

    context.subscriptions.push(
        window.onDidChangeActiveTextEditor(editor => {
            activeEditor = editor;

            if (editor !== undefined) {
                triggerUpdateDecorations();
            }
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

    context.subscriptions.push(
        commands.registerCommand(
            "extension.insertQueryFromClipboard",
            async () => {
                const clipboardText =
                    await env.clipboard.readText();

                const editor =
                    window.activeTextEditor;

                if (editor === undefined) {
                    return;
                }

                await editor.edit(editBuilder => {
                    const indent = "  ";
                    let output =
                        indent +
                        "cmd = RSDCommand (String (" +
                        "\r\n";

                    const lines =
                        clipboardText.split(/\r?\n/);

                    for (
                        let index = 0;
                        index < lines.length;
                        index++
                    ) {
                        if (index > 0) {
                            output += " \",\r\n";
                        }

                        output +=
                            indent +
                            "\" " +
                            lines[index];
                    }

                    output +=
                        " \"\r\n" +
                        indent +
                        "));";

                    editBuilder.insert(
                        editor.selection.start,
                        output
                    );
                });

                window.showInformationMessage(
                    "Запрос из буфера вставлен"
                );
            }
        )
    );

    context.subscriptions.push(
        commands.registerCommand(
            "extension.copyQueryToClipboard",
            async () => {
                const editor =
                    window.activeTextEditor;

                if (editor === undefined) {
                    return;
                }

                const selectedText =
                    editor.document.getText(
                        editor.selection
                    );

                const lines =
                    selectedText.split(/\r?\n/);

                let output = "";

                for (
                    let index = 0;
                    index < lines.length;
                    index++
                ) {
                    let line = lines[index];

                    line = line.replace('",', "");
                    line = line.replace(/"/g, "");

                    output += line + "\r\n";
                }

                await env.clipboard.writeText(output);

                window.showInformationMessage(
                    "Запрос скопирован в буфер обмена"
                );
            }
        )
    );
}


/**
 * Регистрирует сообщения, которые сервер отправляет клиенту.
 *
 * Односторонние действия оформлены как notifications:
 * они не создают Promise на стороне сервера и не способны
 * породить необработанный rejection при старте/остановке.
 */
function registerServerNotifications(): void {
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
    );

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
    );

    client.onNotification(
        "updateStatusBar",
        (value: number) => {
            updateStatusBarItem(value);
        }
    );

    client.onNotification(
        "noRootFolder",
        () => {
            window.showErrorMessage(
                "Импорт макросов недоступен. " +
                "Для полноценной работы необходимо " +
                "открыть папку или рабочую область."
            );
        }
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
    Thenable<void> | undefined {
    if (client === undefined) {
        return undefined;
    }

    return client.stop();
}


function triggerUpdateDecorations(): void {
    if (timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
    }

    timeout = setTimeout(
        updateDecorations,
        500
    );
}