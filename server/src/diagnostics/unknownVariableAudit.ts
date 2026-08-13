import * as fs from "fs";
import * as path from "path";

import type { IRslUnknownVariableFinding } from "./unknownVariableDiagnostics";

/**
 * Audit-режим правила о необъявленных переменных.
 *
 * Отчёт вместо Problems. Включать правило по умолчанию, не прогнав его на
 * реальном репозитории макросов, нельзя: каждое ложное срабатывание — это
 * подчёркнутое имя, которое на самом деле существует, просто приходит из RSM,
 * DLM или внешнего контекста компилятора. Отчёт даёт основание для решения:
 * файл, позиция, имя, область, наличие VAR, состояние Import-контекста и
 * причина неразрешения.
 *
 * Формат — JSONL: строка на находку. Так отчёт можно и дописывать по мере
 * анализа файлов, и считать обычными средствами, не разбирая весь файл целиком.
 */
export class UnknownVariableAudit {
    private ready = false;
    private failed = false;
    private writtenCount = 0;

    constructor(
        private filePath: string,
        private options: { log(message: string): void }
    ) {}

    get count(): number {
        return this.writtenCount;
    }

    get isActive(): boolean {
        return !!this.filePath && !this.failed;
    }

    /**
     * Дописывает находки одного файла.
     *
     * Синхронная запись намеренная: audit включают вручную и на время прогона,
     * а порядок строк в отчёте должен соответствовать порядку анализа.
     */
    append(findings: readonly IRslUnknownVariableFinding[]): void {
        if (!this.isActive || findings.length === 0) {
            return;
        }

        try {
            this.ensureFile();
            fs.appendFileSync(
                this.filePath,
                findings.map(finding => JSON.stringify({
                    file: displayPath(finding.uri),
                    line: finding.line + 1,
                    character: finding.character + 1,
                    name: finding.name,
                    scope: finding.scope || "<module>",
                    hasExplicitVar: finding.hasExplicitVar,
                    importContext: finding.importContext,
                    reason: finding.reason
                })).join("\n") + "\n",
                "utf8"
            );
            this.writtenCount += findings.length;
        } catch (error) {
            this.failed = true;
            this.options.log(
                `Отчёт audit не записан: ${this.filePath}; ` +
                (error instanceof Error ? error.message : String(error))
            );
        }
    }

    private ensureFile(): void {
        if (this.ready) {
            return;
        }

        const directory = path.dirname(this.filePath);

        if (directory) {
            /* recursive не жалуется на существующий каталог. */
            fs.mkdirSync(directory, { recursive: true });
        }
        /* Каждый запуск сервера начинает отчёт заново. */
        fs.writeFileSync(this.filePath, "", "utf8");
        this.ready = true;
    }
}

function displayPath(uri: string): string {
    return decodeURIComponent(uri)
        .replace(/^file:\/\/\/?/i, "")
        .replace(/\\/g, "/");
}
