import type { IRslModuleModel } from "../moduleModel";
import type { RslSymbol, SymbolId } from "../symbols/rslSymbol";

export interface IIndexedModule extends IRslModuleModel {
    uri: string;
    version: number;
    isOpen: boolean;
}

export interface IIndexedSymbol {
    uri: string;
    symbolId: SymbolId;
    symbol: RslSymbol;
}

export type ModuleResolution<T> =
    | { kind: "resolved"; value: T }
    | { kind: "ambiguous"; candidates: T[] }
    | { kind: "missing" };
