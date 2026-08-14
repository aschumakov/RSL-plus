import {
    commands,
    DocumentSymbol,
    EndOfLine,
    env,
    ExtensionContext,
    Position,
    Range,
    Selection,
    SnippetString,
    SymbolInformation,
    SymbolKind,
    window
} from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

import {
    buildRslSmartEnterSnippet,
    isRslBlockHeader,
    plainEnterIndent
} from "./smartEnter";

const SMART_ENTER_LOOKAHEAD_LINES = 128;

interface IRslBlockRange {
    start: { line: number; character: number };
    end: { line: number; character: number };
}

type RslDocumentSymbol = DocumentSymbol | SymbolInformation;

export interface IEditorCommandEnvironment {
    getClient(): LanguageClient | undefined;
    isClientReady(): boolean;
}

export function registerEditorCommands(
    context: ExtensionContext,
    environment: IEditorCommandEnvironment
): void {
    context.subscriptions.push(
        commands.registerCommand("rsl.foldAllMacros", foldAllMacros),
        commands.registerCommand(
            "rsl.selectCurrentBlock",
            () => selectCurrentBlock(environment)
        ),
        commands.registerCommand("rsl.smartEnter", smartEnter),
        commands.registerCommand(
            "extension.insertQueryFromClipboard",
            insertQueryFromClipboard
        ),
        commands.registerCommand(
            "extension.copyQueryToClipboard",
            copyQueryToClipboard
        )
    );
}

async function smartEnter(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== "rsl") {
        return;
    }

    /*
     * Настройка completeBlocksOnEnter здесь НЕ проверяется.
     *
     * Она решает ровно одно: перехватывать ли обычный Enter, и делает это
     * условие в keybinding — то есть до обращения к расширению. Команда же
     * вызывается ещё и по Shift+Enter, где пользователь попросил завершить
     * блок явно. Проверка настройки внутри команды ломала именно этот вызов:
     * при выключенной настройке Shift+Enter уходил в обычный перевод строки.
     */
    const selection = editor.selection;

    if (!selection.isEmpty || editor.selections.length !== 1) {
        await defaultEnter(editor);
        return;
    }

    const position = selection.active;
    const line = editor.document.lineAt(position.line);
    const beforeCursor = line.text.substring(0, position.character);
    const afterCursor = line.text.substring(position.character);
    /*
     * Не обходим остаток большого документа на каждом Enter. Поиск уже
     * существующего END нужен только после действительно полного заголовка.
     */
    if (
        afterCursor.trim().length > 0 ||
        !isRslBlockHeader(beforeCursor)
    ) {
        await defaultEnter(editor);
        return;
    }
    const tabSize = typeof editor.options.tabSize === "number"
        ? Math.max(1, editor.options.tabSize)
        : 4;
    const indentUnit = editor.options.insertSpaces === false
        ? "\t"
        : " ".repeat(tabSize);
    const eol = editor.document.eol === EndOfLine.CRLF ? "\r\n" : "\n";
    const snippet = buildRslSmartEnterSnippet({
        beforeCursor,
        afterCursor,
        indentUnit,
        eol,
        nextNonEmptyLine: findNextNonEmptyLine(editor, position.line + 1)
    });

    if (!snippet) {
        await defaultEnter(editor);
        return;
    }

    await editor.insertSnippet(
        new SnippetString(snippet),
        new Range(position, line.range.end),
        { undoStopBefore: true, undoStopAfter: true }
    );
}

function findNextNonEmptyLine(
    editor: NonNullable<typeof window.activeTextEditor>,
    startLine: number
): string | undefined {
    const endLine = Math.min(
        editor.document.lineCount,
        startLine + SMART_ENTER_LOOKAHEAD_LINES
    );
    for (let line = startLine; line < endLine; line++) {
        const text = editor.document.lineAt(line).text;
        if (text.trim().length > 0) {
            return text;
        }
    }
    return undefined;
}

/**
 * Перевод строки там, где завершать блок нечем.
 *
 * Обычная правка, а не snippet: snippet-сессия, её undo-stop и подстановка
 * $0 — цена, которую обычному переводу строки платить не за что. Отступ
 * добавляется явно, потому что editor.edit никакого автоотступа не делает.
 *
 * Сюда попадают только те, кто включил completeBlocksOnEnter: по умолчанию
 * Enter до расширения не доходит вовсе.
 */
async function defaultEnter(
    editor: NonNullable<typeof window.activeTextEditor>
): Promise<void> {
    const eol = editor.document.eol === EndOfLine.CRLF ? "\r\n" : "\n";
    const position = editor.selection.active;
    const indent = plainEnterIndent(
        editor.document.lineAt(position.line).text,
        position.character
    );

    await editor.edit(
        builder => builder.insert(position, `${eol}${indent}`),
        { undoStopBefore: true, undoStopAfter: false }
    );

    const landing = new Position(position.line + 1, indent.length);
    editor.selection = new Selection(landing, landing);
}

async function foldAllMacros(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== "rsl") return;

    const symbols = await commands.executeCommand<RslDocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        editor.document.uri
    ) || [];
    const lines = Array.from(new Set(
        collectMacroSymbols(symbols).map(symbol => symbolRange(symbol).start.line)
    ));
    if (lines.length === 0) {
        window.showInformationMessage("В файле нет Macro для сворачивания");
        return;
    }
    await commands.executeCommand("editor.fold", { selectionLines: lines });
}

async function selectCurrentBlock(
    environment: IEditorCommandEnvironment
): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor || editor.document.languageId !== "rsl") return;
    const client = environment.getClient();
    if (!environment.isClientReady() || !client) {
        window.showInformationMessage("RSL language server ещё запускается");
        return;
    }

    try {
        const selected = await client.sendRequest<IRslBlockRange | null>(
            "rsl/currentBlockRange",
            {
                textDocument: { uri: editor.document.uri.toString() },
                position: {
                    line: editor.selection.active.line,
                    character: editor.selection.active.character
                },
                currentRange: {
                    start: {
                        line: editor.selection.start.line,
                        character: editor.selection.start.character
                    },
                    end: {
                        line: editor.selection.end.line,
                        character: editor.selection.end.character
                    }
                }
            }
        );
        if (!selected) {
            window.showInformationMessage("В текущей позиции нет блока RSL");
            return;
        }
        const range = new Range(
            selected.start.line,
            selected.start.character,
            selected.end.line,
            selected.end.character
        );
        editor.selection = new Selection(range.start, range.end);
        editor.revealRange(range);
    } catch (error) {
        console.error("RSL: cannot select current block", error);
        window.showErrorMessage("Не удалось выделить текущий блок RSL");
    }
}

async function insertQueryFromClipboard(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const lines = (await env.clipboard.readText()).split(/\r?\n/);
    const indent = "  ";
    let output = `${indent}cmd = RSDCommand (String (\r\n`;
    lines.forEach((line, index) => {
        if (index > 0) output += " \",\r\n";
        output += `${indent}\" ${line}`;
    });
    output += ` \"\r\n${indent}));`;
    await editor.edit(builder => builder.insert(editor.selection.start, output));
    window.showInformationMessage("Запрос из буфера вставлен");
}

async function copyQueryToClipboard(): Promise<void> {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const output = editor.document.getText(editor.selection)
        .split(/\r?\n/)
        .map(line => line.replace('\",', "").replace(/\"/g, ""))
        .join("\r\n") + "\r\n";
    await env.clipboard.writeText(output);
    window.showInformationMessage("Запрос скопирован в буфер обмена");
}

function collectMacroSymbols(
    symbols: readonly RslDocumentSymbol[]
): RslDocumentSymbol[] {
    const result: RslDocumentSymbol[] = [];
    const visit = (symbol: RslDocumentSymbol): void => {
        if (
            symbol.kind === SymbolKind.Function ||
            symbol.kind === SymbolKind.Method
        ) result.push(symbol);
        if (isDocumentSymbol(symbol)) symbol.children.forEach(visit);
    };
    symbols.forEach(visit);
    return result;
}

function symbolRange(symbol: RslDocumentSymbol): Range {
    return isDocumentSymbol(symbol) ? symbol.range : symbol.location.range;
}

function isDocumentSymbol(
    symbol: RslDocumentSymbol
): symbol is DocumentSymbol {
    return "range" in symbol && "selectionRange" in symbol;
}
