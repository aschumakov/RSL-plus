#!/usr/bin/env node
"use strict";

/*
 * Точка входа `rsl-plus check`.
 *
 * Сначала ищется сборка tsc, и только если её нет — собранный рядом bundle.
 * Порядок именно такой, и он важен дважды. В пакете из server/out остаются
 * лишь entry-файлы, поэтому там сборки tsc нет и берётся bundle: без него
 * команда в опубликованном артефакте не запускалась вовсе. В рабочем дереве,
 * наоборот, tsc свежее, и обратный порядок означал бы, что однажды собранный
 * bundle молча подменяет только что скомпилированный код.
 */

const fs = require("fs");
const path = require("path");

const compiled = path.join(
    __dirname, "..", "server", "out", "cli", "main.js"
);
const bundled = path.join(__dirname, "rsl-plus-cli.js");

require(fs.existsSync(compiled) ? compiled : bundled).runRslCliProcess();
