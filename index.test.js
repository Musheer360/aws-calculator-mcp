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

// -- Pricing engine helper functions (replicated from index.js) --

const FILE_SIZE_TO_GB = { KB: 1 / (1024 * 1024), MB: 1 / 1024, GB: 1, TB: 1024 };
const FREQ_TO_MONTH = { "per second": 2592000, "per minute": 43200, "per hour": 720, "per day": 30, "per week": 30 / 7, "per month": 1, "per year": 1 / 12 };

function normalizeValue(subType, raw) {
  if (raw == null) return 0;
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    const v = Number(raw.value) || 0;
    const unit = raw.unit;
    if (subType === "fileSize" && unit && FILE_SIZE_TO_GB[unit] != null) return v * FILE_SIZE_TO_GB[unit];
    if (subType === "frequency" && unit && FREQ_TO_MONTH[unit] != null) return v * FREQ_TO_MONTH[unit];
    return v;
  }
  return Number(raw) || 0;
}

function evalDisplayIf(condition, context, pricingByDef) {
  if (!condition) return true;
  if (condition.exists) {
    const e = condition.exists;
    if (e.type === "meteredUnit" && e.mappingDefinitionName) {
      return (pricingByDef[e.mappingDefinitionName] || {})[e.meteredUnit] !== undefined;
    }
    return true;
  }
  if (condition.and) return condition.and.every(c => evalDisplayIf(c, context, pricingByDef));
  if (condition.or) return condition.or.some(c => evalDisplayIf(c, context, pricingByDef));
  if (condition.not) return !evalDisplayIf(condition.not, context, pricingByDef);
  if (condition["=="]) {
    const parts = condition["=="];
    if (Array.isArray(parts) && parts.length === 2) {
      const left = parts[0]?.type === "component" ? context[parts[0].id] : parts[0];
      return String(left) === String(parts[1]);
    }
  }
  return true;
}

function executeMathsSection(mathsOps, context, pricingByDef) {
  const priceDisplays = [];
  function getVal(operand) {
    if (operand == null) return 0;
    if (typeof operand === "number") return operand;
    if ("constant" in operand) return Number(operand.constant) || 0;
    if (operand.variableId) return Number(context[operand.variableId]) || 0;
    if (operand.refer) return Number(context[operand.refer]) || 0;
    if (operand.value != null) return Number(operand.value) || 0;
    return 0;
  }
  for (const op of mathsOps || []) {
    for (const comp of op.components || []) {
      if (comp.displayIf && !evalDisplayIf(comp.displayIf, context, pricingByDef)) continue;
      const st = comp.subType || comp.type;
      if (st === "display" || st === "conversionDisplay") continue;
      if (st === "priceDisplay") {
        if (comp.subTotalRefer) priceDisplays.push({ costType: comp.costType || "Monthly", value: Number(context[comp.subTotalRefer]) || 0 });
        continue;
      }
      if (st === "basicMaths" && comp.id) {
        const operands = (comp.operands || []).map(getVal);
        let result = operands[0] ?? 0;
        for (let i = 1; i < operands.length; i++) {
          if (comp.operation === "multiplication") result *= operands[i];
          else if (comp.operation === "addition") result += operands[i];
          else if (comp.operation === "subtraction") result -= operands[i];
          else if (comp.operation === "division") result = operands[i] !== 0 ? result / operands[i] : 0;
        }
        context[comp.id] = result;
      } else if (st === "maxMin" && comp.id) {
        const operands = (comp.operands || []).map(getVal);
        context[comp.id] = comp.operation === "Maximum" ? Math.max(...operands) : Math.min(...operands);
      } else if (st === "rounding" && comp.id) {
        const val = getVal(comp.operands?.[0]);
        const factor = Number(comp.factor) || 1;
        if (comp.method === "roundUp") context[comp.id] = Math.ceil(val / factor) * factor;
        else if (comp.method === "roundDown") context[comp.id] = Math.floor(val / factor) * factor;
        else context[comp.id] = val;
      } else if (st === "tieredPricingMath" && comp.id) {
        const inputVal = Number(context[comp.inputRefer]) || 0;
        const tiers = context[`__tiers__${comp.tieredPricingRefer}`] || [];
        let total = 0, remaining = inputVal;
        for (const tier of tiers) {
          if (remaining <= 0) break;
          const tierEnd = tier.end === -1 ? Infinity : tier.end;
          const qty = Math.min(remaining, tierEnd - tier.start);
          total += qty * tier.price;
          remaining -= qty;
        }
        context[comp.id] = total;
      }
    }
  }
  return priceDisplays;
}

// -- End pricing engine functions --

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

describe("normalizeValue", () => {
  it("should convert fileSize MB to GB", () => {
    assert.equal(normalizeValue("fileSize", { value: 512, unit: "MB" }), 0.5);
    assert.equal(normalizeValue("fileSize", { value: 1024, unit: "MB" }), 1);
  });

  it("should convert fileSize TB to GB", () => {
    assert.equal(normalizeValue("fileSize", { value: 1, unit: "TB" }), 1024);
  });

  it("should keep fileSize GB as-is", () => {
    assert.equal(normalizeValue("fileSize", { value: 100, unit: "GB" }), 100);
  });

  it("should convert frequency per second to per month", () => {
    assert.equal(normalizeValue("frequency", { value: 1, unit: "per second" }), 2592000);
  });

  it("should keep frequency per month as-is", () => {
    assert.equal(normalizeValue("frequency", { value: 1000000, unit: "per month" }), 1000000);
  });

  it("should return raw number for other types", () => {
    assert.equal(normalizeValue("numericInput", 42), 42);
    assert.equal(normalizeValue("dropdown", { value: "1" }), 1);
  });

  it("should return 0 for null", () => {
    assert.equal(normalizeValue("fileSize", null), 0);
    assert.equal(normalizeValue("frequency", undefined), 0);
  });
});

describe("evalDisplayIf", () => {
  const pricingByDef = {
    lambda: { "Lambda Requests": 0.0000002, "Lambda Duration": 0.0000166667, "Lambda Duration Tier2": 0.0000150000 },
  };

  it("should return true for null condition", () => {
    assert.equal(evalDisplayIf(null, {}, {}), true);
  });

  it("should check metered unit existence", () => {
    assert.equal(evalDisplayIf(
      { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "Lambda Requests" } },
      {}, pricingByDef
    ), true);
    assert.equal(evalDisplayIf(
      { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "NonExistent" } },
      {}, pricingByDef
    ), false);
  });

  it("should handle AND conditions", () => {
    assert.equal(evalDisplayIf({
      and: [
        { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "Lambda Requests" } },
        { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "Lambda Duration" } },
      ]
    }, {}, pricingByDef), true);
    assert.equal(evalDisplayIf({
      and: [
        { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "Lambda Requests" } },
        { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "NonExistent" } },
      ]
    }, {}, pricingByDef), false);
  });

  it("should handle NOT conditions", () => {
    assert.equal(evalDisplayIf({
      not: { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "Lambda Requests" } }
    }, {}, pricingByDef), false);
    assert.equal(evalDisplayIf({
      not: { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "NonExistent" } }
    }, {}, pricingByDef), true);
  });

  it("should handle == conditions", () => {
    const ctx = { storageClass: "s3Standard" };
    assert.equal(evalDisplayIf({
      "==": [{ type: "component", id: "storageClass" }, "s3Standard"]
    }, ctx, {}), true);
    assert.equal(evalDisplayIf({
      "==": [{ type: "component", id: "storageClass" }, "s3Glacier"]
    }, ctx, {}), false);
  });
});

describe("executeMathsSection", () => {
  it("should perform basic multiplication", () => {
    const ctx = { a: 10, b: 5 };
    const ops = [{ components: [{
      type: "maths", subType: "basicMaths", id: "result", operation: "multiplication",
      operands: [{ variableId: "a" }, { variableId: "b" }]
    }] }];
    executeMathsSection(ops, ctx, {});
    assert.equal(ctx.result, 50);
  });

  it("should perform addition with constants", () => {
    const ctx = { a: 100 };
    const ops = [{ components: [{
      type: "maths", subType: "basicMaths", id: "result", operation: "addition",
      operands: [{ variableId: "a" }, { constant: 50 }]
    }] }];
    executeMathsSection(ops, ctx, {});
    assert.equal(ctx.result, 150);
  });

  it("should perform subtraction", () => {
    const ctx = { total: 1000000 };
    const ops = [{ components: [{
      type: "maths", subType: "basicMaths", id: "result", operation: "subtraction",
      operands: [{ variableId: "total" }, { constant: 400000 }]
    }] }];
    executeMathsSection(ops, ctx, {});
    assert.equal(ctx.result, 600000);
  });

  it("should handle max operation", () => {
    const ctx = { a: -100 };
    const ops = [{ components: [{
      type: "maths", subType: "maxMin", id: "result", operation: "Maximum",
      operands: [{ variableId: "a" }, { constant: 0 }]
    }] }];
    executeMathsSection(ops, ctx, {});
    assert.equal(ctx.result, 0);
  });

  it("should handle rounding up", () => {
    const ctx = { a: 5.3 };
    const ops = [{ components: [{
      type: "maths", subType: "rounding", id: "result", method: "roundUp", factor: "1",
      operands: [{ variableId: "a" }]
    }] }];
    executeMathsSection(ops, ctx, {});
    assert.equal(ctx.result, 6);
  });

  it("should calculate tiered pricing", () => {
    const ctx = {
      storageGB: 60000,
      "__tiers__storageTier": [
        { start: 0, end: 51200, price: 0.023 },
        { start: 51201, end: 512000, price: 0.022 },
        { start: 512001, end: -1, price: 0.021 },
      ]
    };
    const ops = [{ components: [{
      type: "maths", subType: "tieredPricingMath", id: "result",
      inputRefer: "storageGB", tieredPricingRefer: "storageTier"
    }] }];
    executeMathsSection(ops, ctx, {});
    // First 51200 × $0.023 = $1177.60, Next 8800 × $0.022 = $193.60
    const expected = 51200 * 0.023 + 8800 * 0.022;
    assert.ok(Math.abs(ctx.result - expected) < 0.01, `Expected ~${expected.toFixed(2)}, got ${ctx.result.toFixed(2)}`);
  });

  it("should collect priceDisplay results", () => {
    const ctx = { totalCost: 42.50 };
    const ops = [{ components: [{
      type: "display", subType: "priceDisplay", costType: "Monthly",
      subTotalRefer: "totalCost", id: "display1"
    }] }];
    const displays = executeMathsSection(ops, ctx, {});
    assert.equal(displays.length, 1);
    assert.equal(displays[0].costType, "Monthly");
    assert.equal(displays[0].value, 42.50);
  });

  it("should skip components with failing displayIf", () => {
    const ctx = { a: 10 };
    const pricingByDef = { lambda: {} }; // No metered units
    const ops = [{ components: [{
      displayIf: { exists: { type: "meteredUnit", mappingDefinitionName: "lambda", meteredUnit: "NonExistent" } },
      type: "maths", subType: "basicMaths", id: "result", operation: "multiplication",
      operands: [{ variableId: "a" }, { constant: 5 }]
    }] }];
    executeMathsSection(ops, ctx, pricingByDef);
    assert.equal(ctx.result, undefined); // Should not have been calculated
  });

  it("should compute a complete Lambda-like calculation", () => {
    // Simulate Lambda pricing: requests × duration(ms) × 0.001 × memory(GB) = GB-seconds
    // Then subtract free tier and multiply by price
    const ctx = {
      numberOfRequests: 10000000,
      durationOfEachRequest: 200,
      sizeOfMemoryAllocated: 0.5,  // 512MB in GB
      requestPrice: 0.0000002,
      durationPrice: 0.0000166667,
    };
    const ops = [{ components: [
      // Step 1: compute seconds = requests × duration(ms) × 0.001
      { type: "maths", subType: "basicMaths", id: "totalSeconds", operation: "multiplication",
        operands: [{ variableId: "numberOfRequests" }, { variableId: "durationOfEachRequest" }, { constant: 0.001 }] },
      // Step 2: GB-seconds = memory × totalSeconds
      { type: "maths", subType: "basicMaths", id: "gbSeconds", operation: "multiplication",
        operands: [{ variableId: "sizeOfMemoryAllocated" }, { variableId: "totalSeconds" }] },
      // Step 3: subtract free tier
      { type: "maths", subType: "basicMaths", id: "billableGBs", operation: "subtraction",
        operands: [{ variableId: "gbSeconds" }, { constant: 400000 }] },
      // Step 4: max(0, billable)
      { type: "maths", subType: "maxMin", id: "cappedGBs", operation: "Maximum",
        operands: [{ variableId: "billableGBs" }, { constant: 0 }] },
      // Step 5: duration cost = cappedGBs × price
      { type: "maths", subType: "basicMaths", id: "durationCost", operation: "multiplication",
        operands: [{ variableId: "cappedGBs" }, { variableId: "durationPrice" }] },
      // Step 6: billable requests
      { type: "maths", subType: "basicMaths", id: "billableRequests", operation: "subtraction",
        operands: [{ variableId: "numberOfRequests" }, { constant: 1000000 }] },
      { type: "maths", subType: "maxMin", id: "cappedRequests", operation: "Maximum",
        operands: [{ variableId: "billableRequests" }, { constant: 0 }] },
      // Step 7: request cost
      { type: "maths", subType: "basicMaths", id: "requestCost", operation: "multiplication",
        operands: [{ variableId: "cappedRequests" }, { variableId: "requestPrice" }] },
      // Step 8: total
      { type: "maths", subType: "basicMaths", id: "totalCost", operation: "addition",
        operands: [{ variableId: "durationCost" }, { variableId: "requestCost" }] },
      // Display
      { type: "display", subType: "priceDisplay", costType: "Monthly", subTotalRefer: "totalCost", id: "display" },
    ] }];
    
    const displays = executeMathsSection(ops, ctx, {});
    // GB-seconds: 10M × 200 × 0.001 × 0.5 = 1,000,000. Billable: 600,000. Cost: $10.00
    // Requests: 9M × $0.0000002 = $1.80. Total: $11.80
    assert.equal(displays.length, 1);
    assert.ok(Math.abs(displays[0].value - 11.80) < 0.01, `Expected ~$11.80, got $${displays[0].value.toFixed(2)}`);
  });
});
