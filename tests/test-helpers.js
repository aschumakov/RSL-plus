"use strict";

const {
  createExternalModuleSummary,
  createOpenModuleModel
} = require("../server/out/moduleModel");

function createSymbolTree(source, syntax) {
  return createOpenModuleModel(source, syntax).symbolTree;
}

function createExternalSymbolTree(source) {
  return createExternalModuleSummary(source).symbolTree;
}

function updateOpenModule(index, uri, source, version = 1, syntax) {
  return index.updateOpenModule(uri, source, version, syntax);
}

module.exports = {
  createExternalSymbolTree,
  createSymbolTree,
  updateOpenModule
};
