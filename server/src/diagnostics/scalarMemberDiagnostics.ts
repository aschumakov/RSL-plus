import {
    Diagnostic,
    DiagnosticSeverity
} from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";
import {
    displayTypeName,
    isScalarRslType
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Обращение к члену переменной, объявленной скалярным типом.
 *
 * Объявление типа в RSL — это приведение. У переменной `Var sql: String`
 * результат любого присваивания приводится к строке, а у строки нет ни свойств,
 * ни методов, поэтому `sql.MoveNext ()` не выполнится:
 *
 *     Var sql: String;
 *     sql = "select ...";
 *     sql = ExecSqlSelect (sql, ...);
 *     If (sql.MoveNext ())          // ошибка: sql — строка
 *
 * Проверка сознательно узкая. Она срабатывает только когда тип НАПИСАН в
 * объявлении (тип, выведенный из инициализатора, ничего не фиксирует), только
 * для объявлений текущего файла и только для типов из SCALAR_TYPES: VARIANT,
 * OBJECT и объектные типы обращение к членам допускают, и трогать их нельзя.
 */
export function buildScalarMemberDiagnostics(
    module: IIndexedModule,
    resolver: RslScopeResolver
): Diagnostic[] {
    const tokens = module.syntax.tokens;
    const result: Diagnostic[] = [];

    for (let index = 2; index < tokens.length; index++) {
        const member = tokens[index];
        const dot = tokens[index - 1];
        const receiver = tokens[index - 2];

        if (
            member.kind !== "identifier" ||
            dot.kind !== "symbol" ||
            dot.raw !== "." ||
            receiver.kind !== "identifier"
        ) {
            continue;
        }

        /* Цепочка `a.b.c`: про `c` судить нельзя, тип `a.b` нам неизвестен. */
        if (isAfterDot(tokens, index - 2)) {
            continue;
        }

        const declaredType = declaredScalarTypeOf(
            module,
            resolver,
            receiver
        );

        if (!declaredType) {
            continue;
        }

        result.push({
            severity: DiagnosticSeverity.Error,
            range: {
                start: positionAtOffset(module.lex.lineStarts, member.start),
                end: positionAtOffset(module.lex.lineStarts, member.end)
            },
            message:
                `Переменная ${receiver.value} объявлена как ` +
                `${displayTypeName(declaredType)}: у значения этого типа нет ` +
                `члена ${member.value}. Объявление типа — приведение, поэтому ` +
                "результат присваивания тоже приводится к нему.",
            source: "RSL parser",
            code: "member-on-scalar-type",
            data: {
                start: member.start,
                end: member.end,
                name: member.value
            }
        });
    }

    return result;
}

/**
 * Объявленный скалярный тип получателя, если он такой.
 *
 * Пусто означает «проверять нечего»: тип не написан, не скалярный, либо
 * получатель объявлен не в этом файле.
 */
function declaredScalarTypeOf(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    receiver: IRslToken
): string {
    if (normalizeIdentifier(receiver.value) === "this") {
        return "";
    }

    const resolved = resolver.resolveName(
        module.uri,
        module.symbolTree,
        receiver.value,
        receiver.start
    );

    if (
        !resolved ||
        resolved.uri !== module.uri ||
        resolved.symbol.isTypeVariant
    ) {
        return "";
    }

    const typeName = normalizeIdentifier(resolved.symbol.typeName);
    return isScalarRslType(typeName) ? typeName : "";
}

function isAfterDot(
    tokens: readonly IRslToken[],
    index: number
): boolean {
    const previous = tokens[index - 1];
    return previous?.kind === "symbol" && previous.raw === ".";
}
