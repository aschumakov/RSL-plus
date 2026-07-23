import type { Diagnostic } from "vscode-languageserver";

export interface IDiagnosticPublication {
    uri: string;
    diagnostics: Diagnostic[];
}

/**
 * VS Code может временно сообщить об отсутствии активного редактора при
 * переводе фокуса в Problems, Quick Pick или другую служебную панель.
 * Открытый RSL-файл в этот момент остаётся активным для диагностики.
 */
export function resolveActiveDocumentUri(
    currentUri: string | undefined,
    requestedUri: string | null | undefined,
    openUris: readonly string[]
): string | undefined {
    if (typeof requestedUri === "string" && requestedUri.length > 0) {
        return requestedUri;
    }

    return currentUri && openUris.indexOf(currentUri) >= 0
        ? currentUri
        : undefined;
}

/**
 * Формирует публикации при переключении активного редактора.
 *
 * Пока активен RSL-документ, Problems должен содержать только его сообщения.
 * Если диагностика ещё не рассчитана, публикуется пустой список: результаты
 * фоновых файлов не должны временно занимать панель и перехватывать навигацию.
 */
export function planActiveDocumentDiagnostics(
    activeUri: string,
    openUris: readonly string[],
    cache: ReadonlyMap<string, Diagnostic[]>
): IDiagnosticPublication[] {
    return uniqueUris(openUris, activeUri).map(uri => ({
        uri,
        diagnostics: uri === activeUri
            ? cache.get(uri) || []
            : []
    }));
}

/**
 * Формирует публикации после завершения очередного фонового расчёта.
 *
 * Результат неактивного файла сохраняется вызывающим кодом в кэше, но в
 * Problems не показывается. Результат активного файла публикуется даже тогда,
 * когда он пустой, и одновременно скрывает сообщения остальных документов.
 */
export function planUpdatedDiagnostics(
    activeUri: string | undefined,
    updatedUri: string,
    diagnostics: Diagnostic[],
    openUris: readonly string[]
): IDiagnosticPublication[] {
    if (!activeUri) {
        return [{ uri: updatedUri, diagnostics }];
    }

    if (updatedUri !== activeUri) {
        return [{ uri: updatedUri, diagnostics: [] }];
    }

    return uniqueUris(openUris, activeUri).map(uri => ({
        uri,
        diagnostics: uri === activeUri ? diagnostics : []
    }));
}

function uniqueUris(
    uris: readonly string[],
    requiredUri: string
): string[] {
    const result: string[] = [];
    const seen = new Set<string>();

    [...uris, requiredUri].forEach(uri => {
        if (!uri || seen.has(uri)) {
            return;
        }

        seen.add(uri);
        result.push(uri);
    });

    return result;
}
