import {
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} from "vscode-languageserver";

import { positionAtOffset } from "../core/documentPosition";
import {
    BLOCK_START_KEYWORDS,
    BRANCH_KEYWORDS,
    END_KEYWORD
} from "../language/rslLanguageReference";
import { normalizeIdentifier, type IRslToken } from "../lexer";
import type { IIndexedModule } from "../workspaceIndex";

/**
 * Код после безусловного выхода из последовательности.
 *
 * Проверка чисто синтаксическая и потому точная: она не рассуждает о значениях
 * условий, а только смотрит, что в одном блоке после RETURN, BREAK или CONTINUE
 * стоит ещё один оператор. Такой код не исполнится никогда, и никакое состояние
 * программы этого не изменит.
 *
 * Работает по потоку токенов, а не по дереву: в рабочей модели документа
 * ReturnStatement и ExpressionStatement не сохраняются (см.
 * shouldRetainCompactStatement) — их узлы стоили бы памяти на каждом операторе
 * каждого файла, а нужны здесь только их позиции.
 *
 * ELSE, ELIF и ONERROR начинают новую ветку, то есть сбрасывают состояние.
 * ONERROR важен особо: в него попадают по ошибке, а не по порядку, поэтому
 * RETURN перед ним о его достижимости ничего не говорит.
 */
export function buildUnreachableCodeDiagnostics(
    module: IIndexedModule
): Diagnostic[] {
    const result: Diagnostic[] = [];
    const frames: IBlockFrame[] = [createFrame(false)];
    const tokens = module.syntax.tokens;
    let previous: IRslToken | undefined;
    let currentLine = -1;
    let canStartStatement = true;

    const finish = (frame: IBlockFrame): void => {
        if (frame.unreachableStart === undefined || frame.suppressed) {
            return;
        }
        result.push(createDiagnostic(
            module,
            frame.unreachableStart,
            previous?.end ?? frame.unreachableStart,
            frame.terminator
        ));
        frame.unreachableStart = undefined;
    };

    for (const token of tokens) {
        if (token.kind === "comment" || token.kind === "whitespace" ||
            token.kind === "newline" || token.kind === "bom") {
            continue;
        }

        if (token.line !== currentLine) {
            currentLine = token.line;
            canStartStatement = true;
        }

        const frame = frames[frames.length - 1];

        if (token.kind !== "identifier") {
            if (token.kind === "symbol" && token.raw === ";") {
                /*
                 * Оператор с терминатором закончился: только теперь всё
                 * следующее в этом блоке недостижимо. Без этого шага
                 * `Return\n  1;` считало бы `1` за отдельный оператор.
                 */
                if (frame.state === "afterTerminator") {
                    frame.state = "terminated";
                }
                canStartStatement = true;
            } else {
                canStartStatement = false;
            }
            previous = token;
            continue;
        }

        const word = normalizeIdentifier(token.value);

        if (word === END_KEYWORD) {
            finish(frame);
            frame.allBranchesTerminated = frame.allBranchesTerminated &&
                branchTerminated(frame);

            if (frames.length > 1) {
                frames.pop();

                /* IF со всеми вышедшими ветками и ELSE — сам выход. */
                if (
                    frame.keyword === "if" &&
                    frame.hasElse &&
                    frame.allBranchesTerminated
                ) {
                    const parent = frames[frames.length - 1];

                    if (parent.state === "normal") {
                        parent.state = "terminated";
                        parent.terminator = "RETURN во всех ветках IF";
                    }
                }
            }
            canStartStatement = false;
            previous = token;
            continue;
        }

        if (BRANCH_KEYWORDS.includes(word)) {
            /* Новая ветка: то, что было до неё, о её достижимости не говорит. */
            finish(frame);
            frame.allBranchesTerminated = frame.allBranchesTerminated &&
                branchTerminated(frame);
            frame.hasElse = frame.hasElse || word === "else";
            frame.state = "normal";
            frame.terminator = "";
            canStartStatement = false;
            previous = token;
            continue;
        }

        if (canStartStatement) {
            if (frame.state === "terminated") {
                frame.state = "unreachable";
                frame.unreachableStart = token.start;
            }

            if (
                frame.state === "normal" &&
                TERMINATORS.includes(word)
            ) {
                frame.state = "afterTerminator";
                frame.terminator = word.toUpperCase();
            }
        }

        if (BLOCK_START_KEYWORDS.includes(word)) {
            /*
             * Вложенный блок наследует недостижимость: сообщать о нём отдельно
             * незачем, внешний диапазон его уже накрыл.
             */
            frames.push(createFrame(
                frame.suppressed || frame.unreachableStart !== undefined,
                word
            ));
        }

        canStartStatement = false;
        previous = token;
    }

    frames.forEach(finish);
    return result;
}

/** Слова, после которых исполнение в этот блок не вернётся. */
const TERMINATORS: readonly string[] = ["return", "break", "continue"];

interface IBlockFrame {
    /**
     * normal — обычный ход;
     * afterTerminator — встретили RETURN, но его оператор ещё не закончился;
     * terminated — оператор закончился, следующий будет недостижим;
     * unreachable — недостижимый участок уже начался.
     */
    state: "normal" | "afterTerminator" | "terminated" | "unreachable";
    terminator: string;
    unreachableStart: number | undefined;
    /** Блок сам недостижим: о его содержимом отдельно не сообщаем. */
    suppressed: boolean;
    /** Слово, открывшее блок: IF рассматривается особо, см. hasElse. */
    keyword: string;
    /**
     * У IF была ветка ELSE и КАЖДАЯ ветка вышла из блока.
     *
     * Тогда сам IF — тоже выход, и код после него недостижим. Без ELSE ложное
     * условие ведёт исполнение дальше, поэтому одного «все ветки вышли» мало. У
     * WHILE и FOR такого вывода нет вовсе: тело может не выполниться ни разу.
     */
    hasElse: boolean;
    allBranchesTerminated: boolean;
}

function createFrame(suppressed: boolean, keyword = ""): IBlockFrame {
    return {
        state: "normal",
        terminator: "",
        unreachableStart: undefined,
        suppressed,
        keyword,
        hasElse: false,
        allBranchesTerminated: true
    };
}

/** Вышла ли текущая ветка блока из последовательности. */
function branchTerminated(frame: IBlockFrame): boolean {
    return frame.state !== "normal";
}

function createDiagnostic(
    module: IIndexedModule,
    start: number,
    end: number,
    terminator: string
): Diagnostic {
    return {
        severity: DiagnosticSeverity.Warning,
        range: {
            start: positionAtOffset(module.lex.lineStarts, start),
            end: positionAtOffset(module.lex.lineStarts, end)
        },
        message: "Код недостижим: исполнение уже покинуло блок " +
            `по ${terminator}`,
        source: "RSL parser",
        /* Тег гасит подсветку кода в редакторе, а не только пишет в Problems. */
        tags: [DiagnosticTag.Unnecessary],
        code: "unreachable-code",
        data: { start, end }
    };
}
