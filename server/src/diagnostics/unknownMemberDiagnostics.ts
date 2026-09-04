import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { RslScopeResolver } from "../scopeResolver";
import type { IIndexedModule } from "../workspaceIndex";
import {
    findRslMemberSetMember,
    getRslMemberSet,
    isProvenRslMemberSet,
    type IRslMemberSet,
    type IRslMemberSetOptions
} from "../analysis/memberSet";

/**
 * Проверка состава класса: поля и метода, которого у него нет.
 *
 * Утверждать «такого члена нет» можно далеко не всегда. У прикладных классов
 * состав известен из документации, а она неполна; у переменной типа Variant
 * состав вообще определяется во время исполнения. Поэтому проверка требует
 * доказательств и отказывается работать без них:
 *
 * 1. Тип получателя известен — объявлен или выведен моделью.
 * 2. Состав класса доказуем: см. isProvenRslMemberSet. Это значит, что вся
 *    цепочка наследования разрешена и у каждого её уровня состав известен
 *    целиком — у класса файла и встроенного он таков по построению, у
 *    прикладного только там, где полнота заявлена в каталоге.
 *
 * Ни того, ни другого проверка не выясняет сама: и тип, и состав она
 * спрашивает у того же слоя, что отвечает подсказке, переходу и Hover.
 * Иначе получается худшее из возможного — подсказка показывает член,
 * которого, по мнению проверки, не существует.
 *
 * Если хоть одно условие не выполнено, проверка молчит — «не нашли» и «нет» это
 * разные утверждения, и вторым пугать пользователя нельзя.
 */
/** CompletionItemKind.Class: вид объявления класса в дереве символов. */
const CLASS_KIND = 7;

export interface IRslMemberFinding {
    name: string;
    className: string;
    start: number;
    end: number;
    line: number;
    character: number;
}

export interface IRslMemberCheckerOptions {
    module: IIndexedModule;
    resolver: RslScopeResolver;
    /** Позиция запроса нужна для правил видимости приватных членов. */
    imports: readonly string[];
    /**
     * Заявлена ли полнота состава у класса прикладного модуля.
     *
     * Без этого отсутствие члена у класса из справки ничего не доказывает:
     * часть модулей описана прозой, и состав там заведомо неполон.
     */
    platformMembersComplete?(moduleKey: string): boolean;
    /** Файл библиотеки, а не проекта: нужен для источника класса. */
    isLibraryUri?(uri: string): boolean;
}

export interface IRslMemberChecker {
    /** Проверяет имя, стоящее сразу за точкой. */
    check(
        tokens: readonly IRslToken[],
        index: number,
        receiver: IRslToken
    ): IRslMemberFinding | undefined;
}

export function createRslMemberChecker(
    options: IRslMemberCheckerOptions
): IRslMemberChecker {
    const { module, resolver } = options;
    /* Состав класса считается один раз на файл: имён после точки много. */
    const setByClass = new Map<string, IRslMemberSet>();

    const chainOptions = (offset: number): IRslMemberSetOptions => ({
        resolver,
        uri: module.uri,
        imports: options.imports,
        offset,
        platformMembersComplete: options.platformMembersComplete,
        isLibraryUri: options.isLibraryUri,
        /*
         * Класс своего файла — по модели: индекса версии у диагностик нет,
         * а findFastClass отвечает только про внешние классы.
         */
        /*
         * Одноимённые классы в одном файле: о каком из них речь, неизвестно.
         * Состав такого имени недоказуем, и проверка обязана молчать.
         */
        classAmbiguous: className => countOwnClasses(module, className) > 1,
        ownClass: className => {
            const found = resolver.resolveTypeName(
                module.uri,
                module.symbolTree,
                className
            );

            return found && found.uri === module.uri
                ? { symbol: found.symbol, moduleUri: module.uri }
                : undefined;
        }
    });

    const setOf = (className: string, offset: number): IRslMemberSet => {
        const key = normalizeIdentifier(className);
        const known = setByClass.get(key);

        if (known) {
            return known;
        }

        const built = getRslMemberSet(className, chainOptions(offset));

        setByClass.set(key, built);

        return built;
    };

    return {
        check(tokens, index, receiver) {
            const token = tokens[index];
            const typeName = receiverTypeName(module, resolver, receiver);

            if (!typeName) {
                return undefined;
            }

            const set = setOf(typeName, receiver.start);

            /*
             * Состав недоказуем — молчим. Это не «член есть», а «сказать
             * нечего»: цепочка наследования известна не до конца, класс
             * пришёл из неполной документации или разрешается неоднозначно.
             */
            if (!isProvenRslMemberSet(set)) {
                return undefined;
            }

            if (findRslMemberSetMember(
                set,
                token.value,
                chainOptions(receiver.start)
            )) {
                return undefined;
            }

            return {
                name: token.value,
                className: typeName,
                start: token.start,
                end: token.end,
                line: token.line,
                character: token.character
            };
        }
    };
}

/** Тип получателя: объявленный или выведенный моделью. */
function receiverTypeName(
    module: IIndexedModule,
    resolver: RslScopeResolver,
    receiver: IRslToken
): string {
    const resolved = resolver.resolveAt(
        module.uri,
        module.symbolTree,
        receiver.start
    );

    if (!resolved) {
        return "";
    }

    const typeName = resolver.effectiveTypeName(
        module.uri,
        module.symbolTree,
        resolved.symbol,
        receiver.start
    );

    /*
     * Variant — это «тип неизвестен», а не тип: состав такого объекта
     * определяется во время исполнения.
     */
    return !typeName || normalizeIdentifier(typeName) === "variant"
        ? ""
        : typeName;
}

/** Сколько классов с таким именем объявлено в файле. */
function countOwnClasses(
    module: IIndexedModule,
    className: string
): number {
    const wanted = normalizeIdentifier(className);
    let count = 0;

    const visit = (symbol: { name: string; kind: number;
        children: readonly { name: string; kind: number;
            children: readonly unknown[] }[] }): void => {
        if (
            symbol.kind === CLASS_KIND &&
            normalizeIdentifier(symbol.name) === wanted
        ) {
            count++;
        }

        for (const child of symbol.children) {
            visit(child as never);
        }
    };

    visit(module.symbolTree as never);

    return count;
}
