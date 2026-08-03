import { CancellationTokenSource, workspace } from "vscode";
import type { LanguageClient } from "vscode-languageclient/node";

export interface IWorkspaceInventoryEnvironment {
    getClient(): LanguageClient | undefined;
    isClientReady(): boolean;
    performance(
        event: string,
        fields?: Record<string, string | number | boolean | null | undefined>
    ): void;
}

const DEFAULT_IDLE_MS = 15_000;
const WORKSPACE_EXCLUDE =
    "**/{.git,node_modules,out,dist,build,archive,backup,.history}/**";

/** Управляет только отложенным каталогом workspace и его отменой. */
export class WorkspaceInventoryController {
    private timer: NodeJS.Timeout | undefined;
    private running = false;
    private completed = false;
    private revision = 0;
    private cancellation: CancellationTokenSource | undefined;

    constructor(private environment: IWorkspaceInventoryEnvironment) {}

    schedule(delayMs: number = DEFAULT_IDLE_MS): void {
        if (!this.environment.isClientReady() || this.completed || this.running) {
            return;
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.run().catch(error => {
                this.running = false;
                console.error("RSL workspace inventory failed", error);
                this.schedule();
            });
        }, Math.max(0, delayMs));
    }

    postpone(): void {
        this.cancellation?.cancel();
        this.schedule();
    }

    reset(): void {
        this.revision++;
        this.completed = false;
        this.cancellation?.cancel();
        this.schedule();
    }

    dispose(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.cancellation?.cancel();
        this.cancellation?.dispose();
        this.cancellation = undefined;
    }

    private async run(): Promise<void> {
        const client = this.environment.getClient();
        if (!client || this.running || this.completed) return;

        this.running = true;
        const cancellation = new CancellationTokenSource();
        this.cancellation = cancellation;
        const revision = this.revision;
        const startedAtMs = Date.now();
        this.environment.performance("client.workspaceInventory.start");

        try {
            const files = await workspace.findFiles(
                "**/*.mac",
                WORKSPACE_EXCLUDE,
                undefined,
                cancellation.token
            );
            const stale = cancellation.token.isCancellationRequested ||
                revision !== this.revision;
            if (!stale) {
                await client.sendNotification(
                    "workspaceFiles",
                    files.map(uri => uri.toString())
                );
                this.completed = true;
            }
            this.environment.performance("client.workspaceInventory.end", {
                durationMs: Date.now() - startedAtMs,
                files: files.length,
                stale,
                cancelled: cancellation.token.isCancellationRequested
            });
        } finally {
            if (this.cancellation === cancellation) this.cancellation = undefined;
            cancellation.dispose();
            this.running = false;
            if (!this.completed) this.schedule();
        }
    }
}
