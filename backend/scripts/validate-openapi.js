#!/usr/bin/env node
"use strict";

const path = require("path");
const Parser = require("@apidevtools/swagger-parser");

async function run(argv = process.argv.slice(2)) {
  const root = path.resolve(__dirname, "../..");
  const specification = path.resolve(root, argv[0] || "docs/openapi.yml");
  const document = await Parser.validate(specification);
  console.log(
    `OpenAPI validation passed: ${document.openapi}, ${Object.keys(document.paths || {}).length} paths.`,
  );
}

if (require.main === module) {
  run().catch((error) => {
    console.error(`OpenAPI validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
