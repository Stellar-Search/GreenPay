"use strict";

const { checkCompatibility } = require("./check-openapi-compatibility");

function contract(overrides = {}) {
  return {
    openapi: "3.0.3",
    info: { title: "fixture", version: "1.0.0" },
    paths: {
      "/api/v1/items": {
        get: {
          parameters: [{
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "integer", maximum: 100 },
          }],
          responses: {
            200: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "state"],
                    properties: {
                      id: { type: "string" },
                      state: { type: "string", enum: ["active", "paused"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    components: { schemas: {} },
    ...overrides,
  };
}

describe("OpenAPI compatibility check", () => {
  it("accepts additive optional response fields and new operations", () => {
    const baseline = contract();
    const current = structuredClone(baseline);
    current.paths["/api/v1/items"].get.responses[200].content["application/json"].schema
      .properties.description = { type: "string" };
    current.paths["/api/v1/items"].post = { responses: { 201: { description: "created" } } };

    expect(checkCompatibility(baseline, current).unapproved).toEqual([]);
  });

  it("fails path removal, required request additions, response field removal, and response enum expansion", () => {
    const baseline = contract();
    const current = structuredClone(baseline);
    const operation = current.paths["/api/v1/items"].get;
    operation.parameters[0].required = true;
    const schema = operation.responses[200].content["application/json"].schema;
    delete schema.properties.id;
    schema.properties.state.enum.push("archived");

    const result = checkCompatibility(baseline, current);
    expect(result.unapproved.map((item) => item.kind)).toEqual(expect.arrayContaining([
      "parameter-became-required",
      "property-removed",
      "response-enum-values-added",
    ]));

    const removed = checkCompatibility(baseline, contract({ paths: {} }));
    expect(removed.unapproved[0].kind).toBe("path-removed");
  });

  it("allows only explicitly announced stable change identifiers", () => {
    const baseline = contract();
    const current = contract({ paths: {} });
    const first = checkCompatibility(baseline, current).unapproved[0];
    const result = checkCompatibility(baseline, current, {
      approvedBreakingChanges: [{
        id: first.id,
        announcedAt: "2026-08-28",
        targetVersion: "v2",
        owner: "api-team",
        rationale: "The new major version replaces this operation.",
        migrationGuide: "/docs/v2-migration.md",
      }],
    });

    expect(result.unapproved).toEqual([]);
    expect(result.changes).toHaveLength(1);
  });

  it("maps the historical unversioned documentation prefix before comparison", () => {
    const baseline = contract({
      paths: { "/api/items": contract().paths["/api/v1/items"] },
    });
    const current = contract({
      "x-compatibility": { pathAliases: [{ from: "/api/", to: "/api/v1/" }] },
    });

    expect(checkCompatibility(baseline, current).unapproved).toEqual([]);
  });
});
