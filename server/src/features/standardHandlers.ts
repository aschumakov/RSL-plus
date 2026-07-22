import * as fs from "fs";
import * as path from "path";

/**
 * Корневой файл standard-handlers.json содержит только имена Macro,
 * сигнатура которых задаётся ядром RS-Bank.
 *
 * Имена и количество параметров конкретной реализации не фиксируются:
 * разработчик может назвать параметры по-своему и принять только нужную
 * начальную часть списка, который передаёт ядро.
 */
interface IStandardHandlersFile {
    handlers?: string[];
}

let handlerNames: Set<string> | undefined;

/** Возвращает true, если Macro является стандартным обработчиком RS-Bank. */
export function isStandardHandler(macroName?: string): boolean {
    if (!macroName) {
        return false;
    }

    return getHandlerNames().has(normalizeName(macroName));
}

function getHandlerNames(): Set<string> {
    if (handlerNames) {
        return handlerNames;
    }

    handlerNames = new Set<string>();

    for (const name of loadHandlerNames()) {
        handlerNames.add(normalizeName(name));
    }

    return handlerNames;
}

function loadHandlerNames(): string[] {
    const filePath = process.env.RSL_STANDARD_HANDLERS_FILE ||
        path.resolve(__dirname, "..", "..", "..", "standard-handlers.json");

    try {
        const parsed = JSON.parse(
            fs.readFileSync(filePath, "utf8")
        ) as IStandardHandlersFile;

        return (parsed.handlers || []).filter(isValidHandlerName);
    } catch (_error) {
        /* Отсутствующий или повреждённый справочник не должен ломать сервер. */
        return [];
    }
}

function isValidHandlerName(value: string): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function normalizeName(value: string): string {
    return (value || "").trim().toLowerCase();
}
