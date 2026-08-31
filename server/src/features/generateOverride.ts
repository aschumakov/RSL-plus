import {
    CodeActionKind,
    CompletionItemKind,
    type WorkspaceEdit
} from "vscode-languageserver";

import { normalizeIdentifier } from "../lexer";
import type { RslSymbol } from "../symbols/rslSymbol";
import type { IIndexedModule, WorkspaceIndex } from "../workspaceIndex";
import {
    keyword,
    lineIndent,
    offsetRange,
    singleFileEdit,
    type IRslRefactor
} from "./refactorRegistry";

/**
 * Заготовка переопределения метода базового класса.
 *
 * Пользы здесь ровно одна, и она измеренная: сигнатуру наследника нетрудно
 * разойтись с базовой, а компилятор такое не остановит — правило
 * incompatible-override нашло 15 таких расхождений в 9 файлах из 3000.
 * Действие переносит список параметров как есть, вместе с передачей по ссылке.
 *
 * Тело остаётся пустым, и это не лень. Вызвать базовый метод из наследника в
 * RSL нечем: ни `Inherited`, ни `::` в языке нет — ни одного вхождения на 6165
 * файлах проекта. Написать за автора `return ...` значило бы придумать
 * поведение, которого он не просил.
 */

const PROCEDURE_KINDS = new Set<number>([
    CompletionItemKind.Method,
    CompletionItemKind.Function
]);

/** Класс, внутри которого лежит смещение. */
function classAt(
    module: IIndexedModule,
    offset: number
): RslSymbol | undefined {
    return module.symbolTree.children.find(child =>
        child.kind === CompletionItemKind.Class &&
        child.range.start <= offset &&
        offset <= child.range.end);
}

/** Класс с этим именем в подробной модели файла. */
function classIn(
    module: IIndexedModule | undefined,
    name: string
): RslSymbol | undefined {
    if (!module) {
        return undefined;
    }

    const wanted = normalizeIdentifier(name);

    return module.symbolTree.children.find(child =>
        child.kind === CompletionItemKind.Class &&
        normalizeIdentifier(child.name) === wanted);
}

/** Методы базового класса, которых у наследника ещё нет. */
function missingOverrides(
    module: IIndexedModule,
    index: WorkspaceIndex,
    derived: RslSymbol
): { base: RslSymbol; methods: RslSymbol[] } | undefined {
    if (!derived.baseClassName) {
        return undefined;
    }

    /*
     * Базовый класс обязан определиться однозначно: имён вроде `Base` в
     * проекте несколько, и взять чужой значит предложить чужую сигнатуру.
     */
    const baseUri = index.catalog.classDeclaringUri(
        module.uri,
        derived.baseClassName
    );

    if (!baseUri) {
        return undefined;
    }

    const base = classIn(
        baseUri === module.uri ? module : index.getModule(baseUri),
        derived.baseClassName
    );

    if (!base) {
        return undefined;
    }

    const own = new Set(
        derived.children
            .filter(child => PROCEDURE_KINDS.has(child.kind))
            .map(child => normalizeIdentifier(child.name))
    );
    const methods = base.children.filter(child =>
        PROCEDURE_KINDS.has(child.kind) &&
        !child.isPrivate &&
        !own.has(normalizeIdentifier(child.name)));

    return methods.length > 0 ? { base, methods } : undefined;
}

/** Куда встанет заготовка: за последним членом класса, перед его END. */
function insertionPoint(
    module: IIndexedModule,
    derived: RslSymbol
): { offset: number; indent: string } | undefined {
    const members = derived.children.filter(child =>
        PROCEDURE_KINDS.has(child.kind));
    const last = members[members.length - 1];

    if (!last) {
        return undefined;
    }

    const source = module.source;
    const lineBreak = source.indexOf("\n", last.range.end);
    const offset = lineBreak < 0 ? source.length : lineBreak + 1;

    return { offset, indent: lineIndent(module, last.range.start) };
}

export const generateOverrideRefactor: IRslRefactor = {
    id: "generate.override",
    kind: CodeActionKind.RefactorRewrite,
    applies: context => {
        const derived = classAt(context.module, context.start);

        if (!derived) {
            return [];
        }

        const missing = missingOverrides(
            context.module,
            context.index,
            derived
        );

        if (!missing || !insertionPoint(context.module, derived)) {
            return [];
        }

        return missing.methods.map(method => ({
            title: "RSL: переопределить метод " + method.name +
                " класса " + missing.base.name,
            data: { method: method.name }
        }));
    },
    resolve: (context, candidate): WorkspaceEdit | undefined => {
        const derived = classAt(context.module, context.start);

        if (!derived) {
            return undefined;
        }

        const missing = missingOverrides(
            context.module,
            context.index,
            derived
        );
        const place = insertionPoint(context.module, derived);
        const wanted = normalizeIdentifier(
            String(candidate.data?.method || "")
        );
        const method = missing?.methods.find(item =>
            normalizeIdentifier(item.name) === wanted);

        if (!method || !place) {
            return undefined;
        }

        const eol = context.module.lex.eol || "\n";
        const inner = place.indent + (context.options.indent || "    ");
        const text = [
            "",
            place.indent + keyword("Macro", context.options) + " " +
                method.name + signature(method),
            inner,
            place.indent + keyword("End", context.options) + ";"
        ].join(eol) + eol;

        return singleFileEdit(context.module, [{
            range: offsetRange(context.module, place.offset, place.offset),
            newText: text
        }]);
    }
};

/**
 * Список параметров базового метода как он записан.
 *
 * Переписывать его нельзя: `@` перед именем — это передача по ссылке, и
 * потерять её значит получить метод, который молча работает с копией.
 */
function signature(method: RslSymbol): string {
    const text = method.parameterText.trim();

    if (!text) {
        return "()";
    }

    return text.startsWith("(") ? text : "(" + text + ")";
}

/** Что действие видит в этом месте: основа направленных тестов. */
export function rslOverrideContext(
    module: IIndexedModule,
    index: WorkspaceIndex,
    offset: number
): { derived: RslSymbol; base: RslSymbol; methods: RslSymbol[] } | undefined {
    const derived = classAt(module, offset);

    if (!derived) {
        return undefined;
    }

    const missing = missingOverrides(module, index, derived);

    return missing ? { derived, ...missing } : undefined;
}
