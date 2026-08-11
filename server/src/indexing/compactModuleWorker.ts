import { parentPort, workerData } from "worker_threads";

import {
    configureCompactModuleCache,
    readCompactModule
} from "./compactModuleReader";
import type { ICompactModuleRequest } from "./compactModuleProtocol";

/*
 * Точка входа worker'а компактной индексации.
 *
 * Сама работа живёт в compactModuleReader: тот же код выполняется на основном
 * потоке, если worker не удалось запустить. Здесь только приём сообщений —
 * так резервный путь не может разойтись с обычным.
 */
const port = parentPort;

if (!port) {
    throw new Error("compactModuleWorker запущен без parentPort");
}

/*
 * Кэш настраивается здесь, а не сообщением: путь нужен уже первому запросу, а
 * сообщение с настройкой могло бы прийти после него. Владелец файла — worker:
 * он выполняет все обычные запросы, и запись из двух процессов сразу не нужна.
 */
const cachePath = (workerData as { cachePath?: string } | null)?.cachePath;
configureCompactModuleCache(cachePath);

port.on("message", (request: ICompactModuleRequest) => {
    readCompactModule(request).then(
        response => port.postMessage(response),
        error => port.postMessage({
            id: request.id,
            uri: request.uri,
            generation: request.generation,
            status: "failed",
            error: error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error)
        })
    );
});
