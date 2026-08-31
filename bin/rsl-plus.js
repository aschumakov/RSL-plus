#!/usr/bin/env node
"use strict";

/*
 * Точка входа `rsl-plus check`.
 *
 * Рядом ищется собранный bundle, и только если его нет — сборка tsc. Порядок
 * именно такой из-за поставки: в VSIX из server/out попадают лишь entry-файлы,
 * и обращение к server/out/cli/main внутри пакета указывало в пустоту. В
 * рабочем дереве bundle обычно не собран, там берётся tsc.
 */

const fs = require("fs");
const path = require("path");

const bundled = path.join(__dirname, "rsl-plus-cli.js");
const entry = fs.existsSync(bundled)
    ? bundled
    : path.join(__dirname, "..", "server", "out", "cli", "main.js");

require(entry).runRslCliProcess();
