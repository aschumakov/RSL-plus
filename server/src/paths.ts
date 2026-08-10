import * as path from "path";

/*
 * Пути к файлам, которые сервер читает в runtime.
 *
 * Раскладок на диске две:
 *   1) сборка tsc      — server/out/<подкаталог>/<модуль>.js
 *   2) bundle для VSIX — весь сервер в одном server/out/server.js
 *
 * У модуля в подкаталоге __dirname в этих раскладках разный, поэтому
 * фиксированное "../.." из features/ верно только в одной из них: в bundle
 * оно уезжает на уровень выше и файл молча не находится.
 *
 * Этот модуль лежит в корне server/src, то есть компилируется в
 * server/out/paths.js, а при сборке bundle его код попадает в
 * server/out/server.js — в обоих случаях __dirname равен server/out. Это и
 * есть инвариант, на который здесь опираются вычисления путей. Bundle обязан
 * складывать server.js именно в server/out (см. build/bundle.js).
 */

/** Корень расширения: там лежат package.json и standard-handlers.json. */
export function resolveExtensionFile(relativePath: string): string {
    return path.resolve(__dirname, "..", "..", relativePath);
}
