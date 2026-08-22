/**
 * src/schemas/index.js
 *
 * Barrel export for all declarative request schemas so routes can
 * `require("../schemas")` and pick what they need from one place.
 */
"use strict";

module.exports = {
  ...require("./common"),
  ...require("./donations"),
  ...require("./projects"),
  ...require("./admin"),
};
