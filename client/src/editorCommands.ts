import {
    commands,
    DocumentSymbol,
    env,
    ExtensionContext,
    Range,
    Selection,
    SymbolInformation,
    SymbolKind,
    window
} from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

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
