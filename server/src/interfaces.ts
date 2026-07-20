import {
    CompletionItemKind,
    InsertTextFormat,
    CompletionItem,
    Location
} from "vscode-languageserver";

import { varType } from "./enums";
import { CBase } from "./common";


/**
 * Интерфейс для массива с импортированными модулями.
 */
export interface IFAStruct {
    uri: string;
    object: CBase;
}


/**
 * Универсальная пара значений.
 */
export interface If_s<T> {
    first: boolean;
    second: T;
}


/**
 * Запрос на открытие позиции в файле.
 */
export interface IReqOpenLocation {
    uri: string;
    location: Location;
    range: IRange;
}


/**
 * Тип лексического токена.
 *
 * code    — обычный RSL-код;
 * string  — строковый литерал;
 * square  — многострочный блок [ ... ];
 * comment — однострочный или блочный комментарий.
 */
export type TokenKind =
    "code" |
    "string" |
    "square" |
    "comment";


/**
 * Токен исходного текста.
 */
export interface IToken {
    str: string;
    range: IRange;
    kind?: TokenKind;
}


/**
 * Настройки language server.
 */
export interface IRslSettings {
    import: string;
}


/**
 * Диапазон в абсолютных смещениях документа.
 */
export interface IRange {
    start: number;
    end: number;
}


/**
 * Массив строковых значений.
 */
export interface IArray {
    _it: Array<string>;
    is(it: string): If_s<number>;
    str(num: varType | number): string;
}


/**
 * Базовый класс элемента синтаксического дерева.
 */
export abstract class CAbstractBase {
    protected name: string;
    protected private_: boolean;
    protected range: IRange;
    protected objKind: CompletionItemKind;
    protected varType_: string;
    protected description: string;
    protected detail: string;
    protected insertedText: string;

    constructor() {
        this.name = "";
        this.private_ = false;
        this.range = {
            start: 0,
            end: 0
        };
        this.objKind = CompletionItemKind.Unit;
        this.varType_ = "variant";
        this.description = "";
        this.detail = "";
        this.insertedText = "";
    }

    get Private(): boolean {
        return this.private_;
    }

    set Private(flag: boolean) {
        this.private_ = flag;
    }

    get Name(): string {
        return this.name;
    }

    get Type(): string {
        return this.varType_;
    }

    setType(type: string): void {
        this.varType_ = type;
    }

    get Range(): IRange {
        return this.range;
    }

    setRange(range: IRange): void {
        this.range = range;
    }

    get ObjKind(): CompletionItemKind {
        return this.objKind;
    }

    abstract updateCIInfo(): void;

    get CIInfo(): CompletionItem {
        this.updateCIInfo();

        return {
            label: this.name,
            documentation: this.description,
            insertTextFormat: InsertTextFormat.PlainText,
            kind: this.objKind,
            detail: this.detail,
            insertText: this.insertedText
        };
    }

    isObject(): boolean {
        return (
            this.objKind === CompletionItemKind.Class ||
            this.objKind === CompletionItemKind.Function ||
            this.objKind === CompletionItemKind.Method
        );
    }

    abstract isActual(pos: number): boolean;

    Description(desc: string): void {
        this.description = desc;
    }

    /**
     * Объект может отсутствовать — это нормальный результат поиска.
     */
    RecursiveFind(_name: string): CAbstractBase | undefined {
        return undefined;
    }

    abstract reParsing(): void;
}
