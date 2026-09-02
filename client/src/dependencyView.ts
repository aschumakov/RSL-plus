import {
    commands,
    EventEmitter,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState,
    Uri,
    window,
    workspace,
    type Disposable,
    type Event,
    type ExtensionContext,
    type TreeDataProvider
} from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

/**
 * Панель зависимостей файла.
 *
 * Import-граф у сервера был, а пользователю его видно не было: почему имя
 * доступно, чего не хватает и от чего зависит файл, приходилось выяснять
 * чтением кода.
 *
 * Дерево спрашивает сервер ПО УЗЛУ, когда узел раскрывают. Всё дерево проекта
 * не строится: на настоящем проекте это тысячи узлов, из которых пользователь
 * раскроет пять.
 */
type DependencyState =
    | "resolved"
    | "unloaded"
    | "missing"
    | "ambiguous"
    | "platform";

interface IDependencyNode {
    name: string;
    uri?: string;
    state: DependencyState;
    cycle?: boolean;
    expandable?: boolean;
}

interface IDependencyAnswer {
    items?: IDependencyNode[];
}

/** Что показывать рядом с именем. */
const STATE_TEXT: Record<DependencyState, string> = {
    resolved: "",
    unloaded: "не прочитан",
    missing: "не найден",
    ambiguous: "неоднозначно",
    platform: "платформа"
};

const STATE_ICON: Record<DependencyState, string> = {
    resolved: "file-code",
    unloaded: "clock",
    missing: "error",
    ambiguous: "warning",
    platform: "library"
};

class DependencyItem extends TreeItem {
    constructor(
        readonly node: IDependencyNode,
        /** Путь URI от корня: по нему сервер видит цикл. */
        readonly ancestors: readonly string[]
    ) {
        super(
            node.name,
            node.expandable
                ? TreeItemCollapsibleState.Collapsed
                : TreeItemCollapsibleState.None
        );

        const suffix = node.cycle ? "цикл" : STATE_TEXT[node.state];

        this.description = suffix;
        this.iconPath = new ThemeIcon(
            node.cycle ? "sync" : STATE_ICON[node.state]
        );
        this.contextValue = node.uri ? "rslDependencyFile" : "rslDependencyName";
        this.resourceUri = node.uri ? Uri.parse(node.uri) : undefined;
        this.tooltip = node.uri || node.name;

        if (node.uri) {
            this.command = {
                command: "vscode.open",
                title: "Открыть",
                arguments: [Uri.parse(node.uri)]
            };
        }
    }
}

class DependencyProvider implements TreeDataProvider<DependencyItem> {
    private readonly changed = new EventEmitter<DependencyItem | undefined>();
    private rootUri: string | undefined;
    private direction: "dependencies" | "dependents" = "dependencies";

    readonly onDidChangeTreeData: Event<DependencyItem | undefined> =
        this.changed.event;

    constructor(private readonly client: LanguageClient) {}

    setRoot(uri: string | undefined): void {
        this.rootUri = uri;
        this.changed.fire(undefined);
    }

    setDirection(direction: "dependencies" | "dependents"): void {
        this.direction = direction;
        this.changed.fire(undefined);
    }

    get root(): string | undefined {
        return this.rootUri;
    }

    getTreeItem(item: DependencyItem): TreeItem {
        return item;
    }

    async getChildren(item?: DependencyItem): Promise<DependencyItem[]> {
        const uri = item ? item.node.uri : this.rootUri;

        if (!uri) {
            return [];
        }

        const ancestors = item
            ? [...item.ancestors, uri]
            : [uri];

        try {
            const answer = await this.client.sendRequest<IDependencyAnswer>(
                "rsl/dependencies",
                {
                    uri,
                    /* Обратные ссылки спрашиваются только у корня. */
                    direction: item ? "dependencies" : this.direction,
                    ancestors
                }
            );

            return (answer?.items || [])
                .map(node => new DependencyItem(node, ancestors));
        } catch (_error) {
            return [];
        }
    }
}

/** Регистрирует панель и её команды. */
export function registerRslDependencyView(
    context: ExtensionContext,
    client: LanguageClient
): void {
    const provider = new DependencyProvider(client);
    const view = window.createTreeView("rslDependencies", {
        treeDataProvider: provider
    });
    const followEditor = (): void => {
        const editor = window.activeTextEditor;

        if (editor?.document.languageId === "rsl") {
            provider.setRoot(editor.document.uri.toString());
        }
    };

    followEditor();

    const subscriptions: Disposable[] = [
        view,
        window.onDidChangeActiveTextEditor(followEditor),
        commands.registerCommand("rsl.dependencies.showDependencies", () =>
            provider.setDirection("dependencies")),
        commands.registerCommand("rsl.dependencies.showDependents", () =>
            provider.setDirection("dependents")),
        commands.registerCommand("rsl.dependencies.refresh", () =>
            provider.setRoot(provider.root)),
        commands.registerCommand(
            "rsl.dependencies.goToImport",
            (item: DependencyItem) => goToImport(provider.root, item)
        ),
        commands.registerCommand(
            "rsl.dependencies.showPath",
            (item: DependencyItem) => showPath(client, provider.root, item)
        )
    ];

    context.subscriptions.push(...subscriptions);
}

/** Открыть файл на строке, где написан этот Import. */
async function goToImport(
    rootUri: string | undefined,
    item: DependencyItem | undefined
): Promise<void> {
    if (!rootUri || !item) {
        return;
    }

    const document = await workspace.openTextDocument(Uri.parse(rootUri));
    const text = document.getText();
    /*
     * Ищется само написанное имя, а не разобранная директива: показать нужно
     * то место, где пользователь его написал.
     */
    const at = text.toLowerCase().indexOf(item.node.name.toLowerCase());

    await window.showTextDocument(document, {
        selection: at < 0
            ? undefined
            : new (await import("vscode")).Range(
                document.positionAt(at),
                document.positionAt(at + item.node.name.length)
            )
    });
}

/** Показать путь от текущего файла к выбранному модулю. */
async function showPath(
    client: LanguageClient,
    rootUri: string | undefined,
    item: DependencyItem | undefined
): Promise<void> {
    if (!rootUri || !item?.node.uri) {
        return;
    }

    const answer = await client.sendRequest<{ path?: string[] }>(
        "rsl/dependencyPath",
        { fromUri: rootUri, toUri: item.node.uri }
    );
    const path = answer?.path || [];

    if (path.length === 0) {
        void window.showInformationMessage(
            "RSL: пути по Import между этими файлами нет"
        );

        return;
    }

    const channel = window.createOutputChannel("RSL-plus: путь зависимости");

    channel.appendLine("Путь по Import:");
    path.forEach((uri, at) => channel.appendLine("  ".repeat(at + 1) + uri));
    channel.show(true);
}
