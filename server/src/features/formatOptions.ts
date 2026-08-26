import type { IRslFormatOptions } from "../format";
import type { IRslFormatSettings } from "../interfaces";
import type { IRslIndentStyle } from "../services/editorConfigService";

/**
 * Настройки одного форматирования.
 *
 * Источников три, и порядок между ними важен. Ближе всех .editorconfig: он
 * лежит в проекте и описывает договорённость команды. Затем настройки плагина:
 * их пишет тот же проект, но для тех, у кого .editorconfig нет. Дальше всех
 * настройки редактора: они личные и о конкретном проекте ничего не знают.
 *
 * Ширина отступа и его символ берутся именно так; всё остальное — только из
 * настроек плагина, потому что в .editorconfig этому места нет.
 */

export interface IRslEditorFormatOptions {
    tabSize: number;
    insertSpaces: boolean;
}

export function resolveRslFormatOptions(
    editor: IRslEditorFormatOptions,
    settings?: IRslFormatSettings,
    editorConfig?: IRslIndentStyle
): IRslFormatOptions & { tabSize: number } {
    const fromProject = settings?.useEditorConfig === false
        ? {}
        : editorConfig || {};
    const settingsSpaces = settings?.indentStyle === "space"
        ? true
        : settings?.indentStyle === "tab" ? false : undefined;
    const settingsSize = settings?.indentSize && settings.indentSize > 0
        ? settings.indentSize
        : undefined;

    return {
        tabSize: Math.max(
            1,
            fromProject.tabSize ?? settingsSize ?? editor.tabSize ?? 4
        ),
        insertSpaces: fromProject.insertSpaces ??
            settingsSpaces ??
            editor.insertSpaces !== false,
        spaceAroundOperators: settings?.spaceAroundOperators !== false,
        alignAssignments: settings?.alignAssignments !== false
    };
}

/**
 * Регистр ключевого слова, которое вставляет плагин.
 *
 * Уже написанное пользователем не меняется — это его дело; речь только о том,
 * что дописывает Smart Enter, Quick Fix и сниппеты.
 *
 * Значение по умолчанию — "asIs": слово вставляется так, как его писал плагин
 * до появления настройки, у каждого места своё привычное написание (end; в
 * нижнем регистре, Var с большой буквы). Настройка нужна проекту с единым
 * стилем, а не для того, чтобы менять поведение всем без спроса.
 */
export function applyRslKeywordCase(
    text: string,
    keywordCase: string | undefined
): string {
    if (keywordCase === "lower") {
        return text.toLowerCase();
    }

    if (keywordCase === "upper") {
        return text.toUpperCase();
    }

    if (keywordCase === "capitalize") {
        return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
    }

    return text;
}
