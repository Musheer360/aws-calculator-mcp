import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We can't directly import the functions from index.js since they're not exported
// and the file connects to MCP on import. So we extract and test the pure logic here.

// ---- Replicate the pure functions from index.js for testing ----

function extractInputs(def) {
  const inputs = [];
  
  function walkComponents(comps) {
    for (const comp of comps || []) {
      if (comp.id) {
        const field = {
          id: comp.id,
          label: comp.label,
          type: comp.subType || comp.type,
          description: comp.description || "",
          default: comp.defaultValue ?? comp.value ?? null,
          unit: comp.unit || null,
          options: comp.options?.map((o) => ({ label: o.label || o.value, value: o.value })) || null,
        };
        
        if (field.type === "frequency" || field.type === "fileSize") {
          if (comp.unitOptions) {
            field.unitOptions = comp.unitOptions;
            field.defaultUnit = comp.unitOptions[0]?.value || comp.unit || null;
            field.format = "value with unit selector";
          } else if (field.unit) {
            field.defaultUnit = field.unit;
            field.format = `value in ${field.unit}`;
          }
        }
        
        inputs.push(field);
      }
      if (comp.components) walkComponents(comp.components);
    }
  }
  
  for (const tmpl of def.templates || []) {
    for (const card of tmpl.cards || []) {
      walkComponents(card.inputSection?.components);
    }
  }
  return inputs;
}

function resolveValue(input, rawValue) {
  if (input.options && typeof rawValue === "string") {
    const match = input.options.find(
      (o) => o.label === rawValue || o.value === rawValue
    );
    if (match) return match.value;
  }
  return rawValue;
}

function buildComponentValue(input, value) {
  if (!input) return { value };
  if ((input.type === "frequency" || input.type === "fileSize") && input.defaultUnit) {
    return { value, unit: input.defaultUnit };
  }
  return { value };
}

function buildCalcComponents(inputs, userInputs = {}) {
  const cc = {};
  const inputMap = {};
  for (const inp of inputs) {
    if (inp.id) inputMap[inp.id] = inp;
  }
  
  if (userInputs && Object.keys(userInputs).length > 0) {
    for (const inp of inputs) {
      if (inp.id && inp.default != null && inp.default !== "") {
        cc[inp.id] = buildComponentValue(inp, inp.default);
      }
    }
    for (const [k, v] of Object.entries(userInputs)) {
      if (typeof v === "object" && v !== null && "value" in v) {
        const inp = inputMap[k];
        const resolved = inp ? resolveValue(inp, v.value) : v.value;
        cc[k] = { ...v, value: resolved };
      } else {
        const inp = inputMap[k];
        const resolved = inp ? resolveValue(inp, v) : v;
        cc[k] = buildComponentValue(inp, resolved);
      }
    }
    return cc;
  }
  
  for (const inp of inputs) {
    if (inp.id && inp.default != null && inp.default !== "") {
      cc[inp.id] = buildComponentValue(inp, inp.default);
    }
  }
  
  return cc;
}

// ---- Tests ----

describe("extractInputs", () => {
  it("should return options as objects with label and value", () => {
    const def = {
      templates: [{
        cards: [{
          inputSection: {
            components: [{
              id: "storageClass",
              label: "Storage Class",
              type: "dropdown",
              defaultValue: "s3Standard",
              options: [
                { label: "S3 Standard", value: "s3Standard" },
                { label: "S3 Intelligent-Tiering", value: "s3IntelligentTiering" },
              ],
            }],
          },
        }],
      }],
    };
    
    const inputs = extractInputs(def);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].id, "storageClass");
    
    // Options should be objects with both label and value
    assert.deepEqual(inputs[0].options, [
      { label: "S3 Standard", value: "s3Standard" },
      { label: "S3 Intelligent-Tiering", value: "s3IntelligentTiering" },
    ]);
  });

  it("should extract frequency fields with unit info", () => {
    const def = {
      templates: [{
        cards: [{
          inputSection: {
            components: [{
              id: "requestRate",
              label: "Request Rate",
              subType: "frequency",
              type: "number",
              defaultValue: 1000,
              unit: "per second",
              unitOptions: [
                { label: "per second", value: "per second" },
                { label: "per minute", value: "per minute" },
              ],
            }],
          },
        }],
      }],
    };
    
    const inputs = extractInputs(def);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].type, "frequency");
    assert.equal(inputs[0].defaultUnit, "per second");
    assert.equal(inputs[0].format, "value with unit selector");
    assert.deepEqual(inputs[0].unitOptions, [
      { label: "per second", value: "per second" },
      { label: "per minute", value: "per minute" },
    ]);
  });

  it("should handle fileSize fields with unit fallback", () => {
    const def = {
      templates: [{
        cards: [{
          inputSection: {
            components: [{
              id: "dataSize",
              label: "Data Size",
              subType: "fileSize",
              type: "number",
              defaultValue: 100,
              unit: "GB",
            }],
          },
        }],
      }],
    };
    
    const inputs = extractInputs(def);
    assert.equal(inputs[0].type, "fileSize");
    assert.equal(inputs[0].defaultUnit, "GB");
    assert.equal(inputs[0].format, "value in GB");
  });

  it("should recursively walk nested components", () => {
    const def = {
      templates: [{
        cards: [{
          inputSection: {
            components: [{
              id: "outer",
              label: "Outer",
              type: "text",
              defaultValue: "a",
              components: [{
                id: "inner",
                label: "Inner",
                type: "number",
                defaultValue: 42,
              }],
            }],
          },
        }],
      }],
    };
    
    const inputs = extractInputs(def);
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].id, "outer");
    assert.equal(inputs[1].id, "inner");
  });

  it("should handle empty definition gracefully", () => {
    assert.deepEqual(extractInputs({}), []);
    assert.deepEqual(extractInputs({ templates: [] }), []);
    assert.deepEqual(extractInputs({ templates: [{ cards: [] }] }), []);
  });
});

describe("resolveValue", () => {
  const input = {
    id: "storageClass",
    options: [
      { label: "S3 Standard", value: "s3Standard" },
      { label: "S3 Glacier", value: "s3Glacier" },
    ],
  };

  it("should resolve a label to its value", () => {
    assert.equal(resolveValue(input, "S3 Standard"), "s3Standard");
    assert.equal(resolveValue(input, "S3 Glacier"), "s3Glacier");
  });

  it("should pass through a value that already matches", () => {
    assert.equal(resolveValue(input, "s3Standard"), "s3Standard");
  });

  it("should return raw value if no option matches", () => {
    assert.equal(resolveValue(input, "unknownOption"), "unknownOption");
  });

  it("should handle input with no options", () => {
    const noOptions = { id: "count", options: null };
    assert.equal(resolveValue(noOptions, 42), 42);
  });

  it("should handle non-string values", () => {
    assert.equal(resolveValue(input, 42), 42);
    assert.equal(resolveValue(input, true), true);
  });
});

describe("buildComponentValue", () => {
  it("should wrap simple values", () => {
    const input = { id: "count", type: "number" };
    assert.deepEqual(buildComponentValue(input, 42), { value: 42 });
  });

  it("should include unit for frequency fields", () => {
    const input = { id: "rate", type: "frequency", defaultUnit: "per second" };
    assert.deepEqual(buildComponentValue(input, 1000), { value: 1000, unit: "per second" });
  });

  it("should include unit for fileSize fields", () => {
    const input = { id: "size", type: "fileSize", defaultUnit: "GB" };
    assert.deepEqual(buildComponentValue(input, 100), { value: 100, unit: "GB" });
  });

  it("should not include unit for frequency fields without defaultUnit", () => {
    const input = { id: "rate", type: "frequency" };
    assert.deepEqual(buildComponentValue(input, 1000), { value: 1000 });
  });

  it("should handle null input", () => {
    assert.deepEqual(buildComponentValue(null, "test"), { value: "test" });
  });
});

describe("buildCalcComponents", () => {
  const inputs = [
    { id: "region", type: "dropdown", default: "us-east-1", options: [
      { label: "US East (N. Virginia)", value: "us-east-1" },
      { label: "US West (Oregon)", value: "us-west-2" },
    ]},
    { id: "storageClass", type: "dropdown", default: "s3Standard", options: [
      { label: "S3 Standard", value: "s3Standard" },
      { label: "S3 Glacier", value: "s3Glacier" },
    ]},
    { id: "dataSize", type: "fileSize", default: 100, defaultUnit: "GB" },
    { id: "requests", type: "frequency", default: 1000, defaultUnit: "per month" },
    { id: "emptyField", type: "text", default: null },
  ];

  it("should build defaults from inputs when no user inputs", () => {
    const cc = buildCalcComponents(inputs);
    assert.deepEqual(cc.region, { value: "us-east-1" });
    assert.deepEqual(cc.storageClass, { value: "s3Standard" });
    assert.deepEqual(cc.dataSize, { value: 100, unit: "GB" });
    assert.deepEqual(cc.requests, { value: 1000, unit: "per month" });
    assert.equal(cc.emptyField, undefined); // null defaults excluded
  });

  it("should merge user inputs with defaults (user takes priority)", () => {
    const userInputs = { storageClass: "s3Glacier" };
    const cc = buildCalcComponents(inputs, userInputs);
    
    // User-provided value overrides default
    assert.deepEqual(cc.storageClass, { value: "s3Glacier" });
    // Defaults still present
    assert.deepEqual(cc.region, { value: "us-east-1" });
    assert.deepEqual(cc.dataSize, { value: 100, unit: "GB" });
  });

  it("should resolve labels to values in user inputs", () => {
    const userInputs = { storageClass: "S3 Glacier" };
    const cc = buildCalcComponents(inputs, userInputs);
    
    // Label "S3 Glacier" should be resolved to value "s3Glacier"
    assert.deepEqual(cc.storageClass, { value: "s3Glacier" });
  });

  it("should handle user inputs in { value } format", () => {
    const userInputs = { storageClass: { value: "S3 Glacier" } };
    const cc = buildCalcComponents(inputs, userInputs);
    
    // Label inside { value } should also be resolved
    assert.deepEqual(cc.storageClass, { value: "s3Glacier" });
  });

  it("should handle user inputs in { value, unit } format", () => {
    const userInputs = { dataSize: { value: 500, unit: "TB" } };
    const cc = buildCalcComponents(inputs, userInputs);
    
    assert.deepEqual(cc.dataSize, { value: 500, unit: "TB" });
  });

  it("should handle unknown field IDs in user inputs", () => {
    const userInputs = { unknownField: "someValue" };
    const cc = buildCalcComponents(inputs, userInputs);
    
    // Unknown fields should still be included
    assert.deepEqual(cc.unknownField, { value: "someValue" });
    // Defaults should also be present
    assert.deepEqual(cc.region, { value: "us-east-1" });
  });

  it("should handle empty inputs array", () => {
    const cc = buildCalcComponents([]);
    assert.deepEqual(cc, {});
  });

  it("should handle empty user inputs", () => {
    const cc = buildCalcComponents(inputs, {});
    // Empty object should be treated as no user inputs → use defaults
    assert.deepEqual(cc.region, { value: "us-east-1" });
  });
});

describe("Estimate ID extraction", () => {
  // Replicate the regex from load_estimate
  const extractId = (estimateId) => {
    const match = estimateId.match(/id=([a-zA-Z0-9-]+)/);
    return match ? match[1] : estimateId;
  };

  it("should extract ID from standard URL with lowercase hex", () => {
    assert.equal(extractId("https://calculator.aws/#/estimate?id=abc123def456"), "abc123def456");
  });

  it("should extract ID from URL with uppercase hex", () => {
    assert.equal(extractId("https://calculator.aws/#/estimate?id=ABC123DEF456"), "ABC123DEF456");
  });

  it("should extract ID from URL with mixed case", () => {
    assert.equal(extractId("https://calculator.aws/#/estimate?id=aBc123DeF456"), "aBc123DeF456");
  });

  it("should extract ID from URL with hyphens", () => {
    assert.equal(extractId("https://calculator.aws/#/estimate?id=abc-123-def"), "abc-123-def");
  });

  it("should use raw string when not a URL", () => {
    assert.equal(extractId("abc123def456"), "abc123def456");
  });
});
