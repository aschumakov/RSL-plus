import { FileChangeType } from "vscode-languageserver/node";

/**
 * Нужно ли реагировать на событие файловой системы.
 *
 * У открытого файла источник истины — буфер редактора, а не диск. Событие
 * watcher по нему приходит и от собственного сохранения документа, поэтому
 * реакция на него означала полный повторный анализ файла, содержимое которого
 * не менялось: каждое Ctrl+S оплачивалось лексированием, разбором, моделью и
 * Problems. О настоящих изменениях — включая внешние, вроде git checkout —
 * редактор сообщает сам через didChange.
 *
 * Удаление — исключение: файла на диске больше нет, и это меняет разрешение
 * имён у зависимых файлов независимо от того, открыт он или нет.
 */
export function shouldHandleWatchedFileChange(
    type: FileChangeType,
    isDocumentOpen: boolean
): boolean {
    return type === FileChangeType.Deleted || !isDocumentOpen;
}
