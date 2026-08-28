import {
    runRslCheck,
    RSL_CHECK_EXIT,
    type IRslCheckOutput
} from "./checkCommand";

/**
 * Точка входа `rsl-plus`.
 *
 * В stdout уходит только результат выбранного формата. Всё остальное —
 * прогресс, предупреждения, описания сбоев — в stderr: в машинном режиме любая
 * посторонняя строка в stdout ломает разбор, и заметить это тот, кто вызывает
 * команду, сможет далеко не сразу.
 */

const USAGE = [
    "rsl-plus — анализатор RSL",
    "",
    "  rsl-plus check --context <корень проекта> <файл.mac> [ещё файлы]",
    "",
    "Подробнее: rsl-plus check --help"
].join("\n");

export function runRslCli(
    argv: readonly string[],
    cwd: string,
    output: IRslCheckOutput
): number {
    const [command, ...rest] = argv;

    if (!command || command === "--help" || command === "-h") {
        output.stderr(USAGE);

        return command ? RSL_CHECK_EXIT.ok : RSL_CHECK_EXIT.badArguments;
    }

    if (command !== "check") {
        output.stderr("rsl-plus: неизвестная команда: " + command);
        output.stderr(USAGE);

        return RSL_CHECK_EXIT.badArguments;
    }

    return runRslCheck(rest, cwd, output);
}

/**
 * Запуск как программы.
 *
 * Вынесено в функцию, а не в проверку require.main: запуск идёт через тонкий
 * файл в bin, и для него этот модуль главным не является.
 */
export function runRslCliProcess(): void {
    const code = runRslCli(process.argv.slice(2), process.cwd(), {
        stdout: line => process.stdout.write(line + "\n"),
        stderr: line => process.stderr.write(line + "\n")
    });

    /*
     * Код ставится, но процесс не убивается.
     *
     * process.exit обрывает ещё не записанный вывод: запись в канал на Windows
     * асинхронна, и убийство процесса сразу после write теряет весь результат.
     * Держать петлю событий анализу нечем — ни таймеров сохранения, ни
     * наблюдателей за файлами он не заводит, — поэтому процесс завершается сам.
     */
    process.exitCode = code;
}
