#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
const REQUEST_NARROWING_LIMITS = ["minLength", "minimum", "exclusiveMinimum", "minItems", "minProperties"];
const REQUEST_LOWERING_LIMITS = ["maxLength", "maximum", "exclusiveMaximum", "maxItems", "maxProperties"];

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, "utf8"), { filename: file });
}

function pointerValue(document, pointer) {
  if (!pointer.startsWith("#/")) return undefined;
  return pointer.slice(2).split("/").reduce((value, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    return value && value[key];
  }, document);
}

function resolve(document, value) {
  if (!value || typeof value !== "object" || !value.$ref) return value;
  return pointerValue(document, value.$ref) || value;
}

function stableId(kind, location) {
  const digest = crypto.createHash("sha256").update(`${kind}:${location}`).digest("hex").slice(0, 12);
  return `api-compat-${digest}`;
}

function change(kind, location, message) {
  return { id: stableId(kind, location), kind, location, message };
}

function values(value) {
  return Array.isArray(value) ? value : [];
}

function sameScalar(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareSchema(baselineDocument, currentDocument, baselineValue, currentValue, context, location, changes, seen = new Set()) {
  const baseline = resolve(baselineDocument, baselineValue);
  const current = resolve(currentDocument, currentValue);
  if (!baseline || typeof baseline !== "object") return;
  if (!current || typeof current !== "object") {
    changes.push(change("schema-removed", location, `Schema removed at ${location}`));
    return;
  }

  const pair = `${baselineValue?.$ref || location}|${currentValue?.$ref || location}|${context}`;
  if (seen.has(pair)) return;
  seen.add(pair);

  for (const keyword of ["type", "format", "nullable"]) {
    if (baseline[keyword] !== undefined && !sameScalar(baseline[keyword], current[keyword])) {
      changes.push(change(
        `schema-${keyword}-changed`,
        `${location}.${keyword}`,
        `${keyword} changed from ${JSON.stringify(baseline[keyword])} to ${JSON.stringify(current[keyword])} at ${location}`,
      ));
    }
  }

  if (baseline.additionalProperties !== false && current.additionalProperties === false) {
    changes.push(change(
      "additional-properties-forbidden",
      location,
      `additionalProperties became forbidden at ${location}`,
    ));
  }

  const baselineEnum = values(baseline.enum);
  const currentEnum = values(current.enum);
  if (baselineEnum.length > 0 && currentEnum.length > 0) {
    const missing = baselineEnum.filter((item) => !currentEnum.some((candidate) => sameScalar(item, candidate)));
    const added = currentEnum.filter((item) => !baselineEnum.some((candidate) => sameScalar(item, candidate)));
    if (missing.length > 0) {
      changes.push(change(
        "enum-values-removed",
        `${location}.enum`,
        `Enum values removed at ${location}: ${missing.map(String).join(", ")}`,
      ));
    }
    if (context === "response" && added.length > 0) {
      changes.push(change(
        "response-enum-values-added",
        `${location}.enum`,
        `Possible response enum values added at ${location}: ${added.map(String).join(", ")}`,
      ));
    }
  }

  if (context === "request") {
    for (const keyword of REQUEST_NARROWING_LIMITS) {
      if (current[keyword] !== undefined && (baseline[keyword] === undefined || current[keyword] > baseline[keyword])) {
        changes.push(change("request-bound-tightened", `${location}.${keyword}`, `${keyword} tightened at ${location}`));
      }
    }
    for (const keyword of REQUEST_LOWERING_LIMITS) {
      if (current[keyword] !== undefined && (baseline[keyword] === undefined || current[keyword] < baseline[keyword])) {
        changes.push(change("request-bound-tightened", `${location}.${keyword}`, `${keyword} tightened at ${location}`));
      }
    }
  }

  const baselineProperties = baseline.properties || {};
  const currentProperties = current.properties || {};
  for (const [name, property] of Object.entries(baselineProperties)) {
    if (!(name in currentProperties)) {
      changes.push(change("property-removed", `${location}.properties.${name}`, `Property ${name} removed at ${location}`));
      continue;
    }
    compareSchema(
      baselineDocument,
      currentDocument,
      property,
      currentProperties[name],
      context,
      `${location}.properties.${name}`,
      changes,
      seen,
    );
  }

  const baselineRequired = new Set(values(baseline.required));
  const currentRequired = new Set(values(current.required));
  if (context === "request") {
    for (const name of currentRequired) {
      if (!baselineRequired.has(name)) {
        changes.push(change("request-property-required", `${location}.required.${name}`, `Request property ${name} became required at ${location}`));
      }
    }
  } else {
    for (const name of baselineRequired) {
      if (!currentRequired.has(name)) {
        changes.push(change("response-required-removed", `${location}.required.${name}`, `Response property ${name} is no longer guaranteed at ${location}`));
      }
    }
  }

  if (baseline.items) {
    compareSchema(
      baselineDocument,
      currentDocument,
      baseline.items,
      current.items,
      context,
      `${location}.items`,
      changes,
      seen,
    );
  }

  for (const composition of ["allOf", "oneOf", "anyOf"]) {
    const oldItems = values(baseline[composition]);
    const newItems = values(current[composition]);
    if (oldItems.length > newItems.length) {
      changes.push(change(`${composition}-branch-removed`, `${location}.${composition}`, `${composition} branch removed at ${location}`));
    }
    oldItems.forEach((item, index) => compareSchema(
      baselineDocument,
      currentDocument,
      item,
      newItems[index],
      context,
      `${location}.${composition}[${index}]`,
      changes,
      seen,
    ));
  }
}

function parameterMap(document, parameters) {
  return new Map(values(parameters).map((parameterValue) => {
    const parameter = resolve(document, parameterValue);
    return [`${parameter.in}:${parameter.name}`, parameter];
  }));
}

function combinedParameters(pathItem, operation) {
  return [...values(pathItem.parameters), ...values(operation.parameters)];
}

function compareParameters(baselineDocument, currentDocument, baselinePath, currentPath, baselineOperation, currentOperation, location, changes) {
  const baseline = parameterMap(baselineDocument, combinedParameters(baselinePath, baselineOperation));
  const current = parameterMap(currentDocument, combinedParameters(currentPath, currentOperation));

  for (const [key, parameter] of baseline) {
    const currentParameter = current.get(key);
    if (!currentParameter) {
      changes.push(change("parameter-removed", `${location}.parameters.${key}`, `Parameter ${key} removed from ${location}`));
      continue;
    }
    if (!parameter.required && currentParameter.required) {
      changes.push(change("parameter-became-required", `${location}.parameters.${key}`, `Parameter ${key} became required at ${location}`));
    }
    compareSchema(
      baselineDocument,
      currentDocument,
      parameter.schema,
      currentParameter.schema,
      "request",
      `${location}.parameters.${key}.schema`,
      changes,
    );
  }

  for (const [key, parameter] of current) {
    if (!baseline.has(key) && parameter.required) {
      changes.push(change("required-parameter-added", `${location}.parameters.${key}`, `New required parameter ${key} added at ${location}`));
    }
  }
}

function compareContent(baselineDocument, currentDocument, baselineContent, currentContent, context, location, changes) {
  for (const [mediaType, media] of Object.entries(baselineContent || {})) {
    if (!currentContent || !currentContent[mediaType]) {
      changes.push(change("media-type-removed", `${location}.${mediaType}`, `Media type ${mediaType} removed at ${location}`));
      continue;
    }
    compareSchema(
      baselineDocument,
      currentDocument,
      media.schema,
      currentContent[mediaType].schema,
      context,
      `${location}.${mediaType}.schema`,
      changes,
    );
  }
}

function compareOperation(baselineDocument, currentDocument, baselinePath, currentPath, baselineOperation, currentOperation, location, changes) {
  compareParameters(
    baselineDocument,
    currentDocument,
    baselinePath,
    currentPath,
    baselineOperation,
    currentOperation,
    location,
    changes,
  );

  const baselineBody = resolve(baselineDocument, baselineOperation.requestBody);
  const currentBody = resolve(currentDocument, currentOperation.requestBody);
  if (baselineBody && !currentBody) {
    changes.push(change("request-body-removed", `${location}.requestBody`, `Request body contract removed at ${location}`));
  } else if (baselineBody && currentBody) {
    if (!baselineBody.required && currentBody.required) {
      changes.push(change("request-body-became-required", `${location}.requestBody`, `Request body became required at ${location}`));
    }
    compareContent(
      baselineDocument,
      currentDocument,
      baselineBody.content,
      currentBody.content,
      "request",
      `${location}.requestBody.content`,
      changes,
    );
  } else if (!baselineBody && currentBody?.required) {
    changes.push(change("required-request-body-added", `${location}.requestBody`, `Required request body added at ${location}`));
  }

  for (const [status, baselineResponseValue] of Object.entries(baselineOperation.responses || {})) {
    const currentResponseValue = (currentOperation.responses || {})[status];
    if (!currentResponseValue) {
      changes.push(change("response-status-removed", `${location}.responses.${status}`, `Response status ${status} removed at ${location}`));
      continue;
    }
    const baselineResponse = resolve(baselineDocument, baselineResponseValue);
    const currentResponse = resolve(currentDocument, currentResponseValue);
    compareContent(
      baselineDocument,
      currentDocument,
      baselineResponse.content,
      currentResponse.content,
      "response",
      `${location}.responses.${status}.content`,
      changes,
    );
  }

  if (baselineOperation.security === undefined && currentOperation.security?.length > 0) {
    changes.push(change("authentication-added", `${location}.security`, `Authentication became required at ${location}`));
  }
}

function applyPathAliases(requestPath, currentDocument) {
  const aliases = values(currentDocument["x-compatibility"]?.pathAliases);
  for (const alias of aliases) {
    if (typeof alias?.from === "string" && typeof alias?.to === "string" &&
        requestPath.startsWith(alias.from) && !requestPath.startsWith(alias.to)) {
      return `${alias.to}${requestPath.slice(alias.from.length)}`;
    }
  }
  return requestPath;
}

function detectBreakingChanges(baselineDocument, currentDocument) {
  const changes = [];
  const baselinePaths = baselineDocument.paths || {};
  const currentPaths = currentDocument.paths || {};

  for (const [publishedPath, baselinePathValue] of Object.entries(baselinePaths)) {
    const currentPathName = applyPathAliases(publishedPath, currentDocument);
    const currentPathValue = currentPaths[currentPathName];
    if (!currentPathValue) {
      changes.push(change("path-removed", publishedPath, `Path ${publishedPath} removed (compared as ${currentPathName})`));
      continue;
    }
    const baselinePath = resolve(baselineDocument, baselinePathValue);
    const currentPath = resolve(currentDocument, currentPathValue);
    for (const [method, baselineOperation] of Object.entries(baselinePath)) {
      if (!HTTP_METHODS.has(method)) continue;
      if (!currentPath[method]) {
        changes.push(change("operation-removed", `${publishedPath}.${method}`, `${method.toUpperCase()} ${publishedPath} removed`));
        continue;
      }
      compareOperation(
        baselineDocument,
        currentDocument,
        baselinePath,
        currentPath,
        baselineOperation,
        currentPath[method],
        `${currentPathName}.${method}`,
        changes,
      );
    }
  }

  for (const [name, baselineSchema] of Object.entries(baselineDocument.components?.schemas || {})) {
    const currentSchema = currentDocument.components?.schemas?.[name];
    if (!currentSchema) {
      changes.push(change("component-schema-removed", `components.schemas.${name}`, `Component schema ${name} removed`));
      continue;
    }
    compareSchema(
      baselineDocument,
      currentDocument,
      baselineSchema,
      currentSchema,
      "response",
      `components.schemas.${name}`,
      changes,
    );
  }

  return [...new Map(changes.map((item) => [item.id, item])).values()];
}

function approvalIds(registry) {
  return new Set(values(registry?.approvedBreakingChanges).filter((entry) => (
    entry &&
    typeof entry.id === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(entry.announcedAt) &&
    /^v(?:[2-9]|[1-9][0-9]+)$/.test(entry.targetVersion) &&
    typeof entry.owner === "string" && entry.owner.length > 0 &&
    typeof entry.rationale === "string" && entry.rationale.length > 0 &&
    typeof entry.migrationGuide === "string" && entry.migrationGuide.length > 0
  )).map((entry) => entry.id));
}

function checkCompatibility(baselineDocument, currentDocument, approvalRegistry = {}) {
  const changes = detectBreakingChanges(baselineDocument, currentDocument);
  const approved = approvalIds(approvalRegistry);
  return {
    changes,
    unapproved: changes.filter((item) => !approved.has(item.id)),
    staleApprovals: [...approved].filter((id) => !changes.some((item) => item.id === id)),
  };
}

function run(argv = process.argv.slice(2)) {
  const root = path.resolve(__dirname, "../..");
  const baselinePath = path.resolve(root, argv[0] || "docs/openapi-v1.previous.yml");
  const currentPath = path.resolve(root, argv[1] || "docs/openapi.yml");
  const approvalPath = path.resolve(root, argv[2] || "docs/api-breaking-changes.yml");

  const result = checkCompatibility(
    readYaml(baselinePath),
    readYaml(currentPath),
    readYaml(approvalPath),
  );

  if (result.unapproved.length > 0) {
    console.error(`OpenAPI compatibility failed: ${result.unapproved.length} unannounced breaking change(s).`);
    for (const item of result.unapproved) {
      console.error(`- ${item.id} [${item.kind}] ${item.message}`);
    }
    console.error(`Announce intentional new-major changes in ${path.relative(root, approvalPath)} with a migration guide.`);
    return 1;
  }

  if (result.staleApprovals.length > 0) {
    console.warn(`OpenAPI compatibility warning: stale approvals: ${result.staleApprovals.join(", ")}`);
  }
  console.log(`OpenAPI compatibility passed: ${result.changes.length} breaking change(s), all announced.`);
  return 0;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  applyPathAliases,
  checkCompatibility,
  compareSchema,
  detectBreakingChanges,
  readYaml,
  run,
  stableId,
};
