#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API = {
  save: "https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs",
  load: "https://d3knqfixx3sbls.cloudfront.net",
  manifest: "https://d1qsjq9pzbk1k6.cloudfront.net/manifest/en_US.json",
  serviceDef: (code) => `https://d1qsjq9pzbk1k6.cloudfront.net/data/${code}/en_US.json`,
};

const REGION_NAMES = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "af-south-1": "Africa (Cape Town)",
  "ap-east-1": "Asia Pacific (Hong Kong)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ap-south-2": "Asia Pacific (Hyderabad)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-southeast-3": "Asia Pacific (Jakarta)",
  "ap-southeast-4": "Asia Pacific (Melbourne)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-northeast-3": "Asia Pacific (Osaka)",
  "ca-central-1": "Canada (Central)",
  "eu-central-1": "Europe (Frankfurt)",
  "eu-central-2": "Europe (Zurich)",
  "eu-west-1": "Europe (Ireland)",
  "eu-west-2": "Europe (London)",
  "eu-west-3": "Europe (Paris)",
  "eu-south-1": "Europe (Milan)",
  "eu-south-2": "Europe (Spain)",
  "eu-north-1": "Europe (Stockholm)",
  "il-central-1": "Israel (Tel Aviv)",
  "me-south-1": "Middle East (Bahrain)",
  "me-central-1": "Middle East (UAE)",
  "sa-east-1": "South America (São Paulo)",
};

let manifestCache = null;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
  return r.json();
}

async function getManifest() {
  if (!manifestCache) {
    manifestCache = fetchJSON(API.manifest).catch(e => {
      manifestCache = null;
      throw e;
    });
  }
  return manifestCache;
}

// Extract input fields from a service definition's templates (fully recursive)
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
        
        // Add format hints and unit info for frequency/fileSize types
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

// Resolve a user-provided value: if it matches an option label, return the option value
function resolveValue(input, rawValue) {
  if (input.options && typeof rawValue === "string") {
    const match = input.options.find(
      (o) => o.label === rawValue || o.value === rawValue
    );
    if (match) return match.value;
  }
  return rawValue;
}

// Build calculationComponents with proper format for all field types
function buildCalcComponents(inputs, userInputs = {}) {
  const cc = {};
  const inputMap = {};
  for (const inp of inputs) {
    if (inp.id) inputMap[inp.id] = inp;
  }
  
  // If user provided inputs, merge them with defaults (user inputs take priority)
  if (userInputs && Object.keys(userInputs).length > 0) {
    // First, add all defaults
    for (const inp of inputs) {
      if (inp.id && inp.default != null && inp.default !== "") {
        cc[inp.id] = buildComponentValue(inp, inp.default);
      }
    }
    // Then overlay user-provided values
    for (const [k, v] of Object.entries(userInputs)) {
      if (typeof v === "object" && v !== null && "value" in v) {
        // Already in { value, unit? } format - resolve label if applicable
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
  
  // No user inputs: include all fields with meaningful defaults
  for (const inp of inputs) {
    if (inp.id && inp.default != null && inp.default !== "") {
      cc[inp.id] = buildComponentValue(inp, inp.default);
    }
  }
  
  return cc;
}

// Build a properly formatted component value including unit if needed
function buildComponentValue(input, value) {
  if (!input) return { value };
  if ((input.type === "frequency" || input.type === "fileSize") && input.defaultUnit) {
    return { value, unit: input.defaultUnit };
  }
  return { value };
}

const server = new McpServer({
  name: "aws-calculator",
  version: "1.0.0",
});

// Tool 1: Search services
server.tool(
  "search_services",
  "Search AWS services available in the pricing calculator by keyword. Returns service codes needed for create_estimate.",
  { query: z.string().describe("Search keyword (e.g. 'EC2', 'Lambda', 'CloudFront')") },
  async ({ query }) => {
    const manifest = await getManifest();
    const q = query.toLowerCase();
    const matches = manifest.awsServices
      .filter((s) => {
        const haystack = `${s.name} ${s.serviceCode} ${(s.searchKeywords || []).join(" ")}`.toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 15)
      .map((s) => ({
        name: s.name.trim(),
        serviceCode: s.serviceCode,
        slug: s.slug || null,
        regions: s.regions?.length || 0,
      }));
    return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
  }
);

// Tool 2: Get service schema (input fields)
server.tool(
  "get_service_schema",
  `Get the input schema for a specific AWS service. Returns the fields you can set in calculationComponents when creating an estimate.
Use the serviceCode from search_services. Each field has an 'id' (use as the key in calculationComponents) and for dropdown fields,
use the 'value' property from the options array (not the 'label') when setting calculationComponents.
For frequency/fileSize fields, provide { value: number, unit: "unitString" }.`,
  { serviceCode: z.string().describe("Service code (e.g. 'amazonCloudFront', 'eC2Next')") },
  async ({ serviceCode }) => {
    const def = await fetchJSON(API.serviceDef(serviceCode));
    const inputs = extractInputs(def);
    const result = {
      serviceName: def.serviceName,
      serviceCode: def.serviceCode,
      version: def.version,
      layout: def.layout,
      subServices: [],
      inputs,
    };
    
    // Issue 4: Add note for loader layout services
    if (def.layout === "loader" && inputs.length === 0) {
      result.note = "This service uses dynamic loading (layout: 'loader'). calculationComponents cannot be auto-populated and should be omitted when creating estimates.";
    }
    
    // Fetch subService schemas if they exist
    if (def.subServices?.length) {
      for (const sub of def.subServices) {
        try {
          const subDef = await fetchJSON(API.serviceDef(sub.serviceCode));
          const subInputs = extractInputs(subDef);
          result.subServices.push({
            serviceCode: sub.serviceCode,
            serviceName: subDef.serviceName,
            version: subDef.version,
            inputs: subInputs,
          });
        } catch {
          result.subServices.push({
            serviceCode: sub.serviceCode,
            serviceName: sub.serviceCode,
            version: "0.0.1",
            inputs: [],
          });
        }
      }
    }
    
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// Tool 3: Create estimate and get shareable link
server.tool(
  "create_estimate",
  `Create an AWS Pricing Calculator estimate and return a shareable, editable link.
Each service needs: serviceCode, region, serviceName, monthlyCost.
Optionally provide calculationComponents (key-value pairs from get_service_schema) for the estimate to render detailed configs when opened.
Use the 'value' field (not the 'label') from option objects returned by get_service_schema.
For frequency/fileSize fields, provide { value: number, unit: "unitString" }.
Optionally provide a 'group' name for each service to organize them into groups.`,
  {
    name: z.string().describe("Estimate name"),
    services: z
      .array(
        z.object({
          serviceCode: z.string().describe("Service code from search_services"),
          region: z.string().default("us-east-1").describe("AWS region code"),
          regionName: z.string().optional().describe("Human-readable region name"),
          serviceName: z.string().describe("Display name (e.g. 'Amazon EC2')"),
          description: z.string().optional().describe("Service description/notes"),
          monthlyCost: z.number().describe("Monthly cost in USD"),
          upfrontCost: z.number().default(0).describe("Upfront cost in USD"),
          configSummary: z.string().optional().describe("Brief config summary shown in the estimate table"),
          calculationComponents: z.record(z.any()).optional().describe("Key-value input params from get_service_schema"),
          group: z.string().optional().describe("Group name to organize this service under"),
        })
      )
      .describe("Array of services to include"),
  },
  async ({ name, services }) => {
    const svcMap = {};
    const groupMap = {}; // Track which services belong to which groups
    let totalMonthly = 0, totalUpfront = 0;

    for (const svc of services) {
      const key = `${svc.serviceCode}-${crypto.randomUUID()}`;
      let cc = {};

      // Try to fetch service definition for version, structure, and input schema
      let version = "0.0.1", estimateFor = svc.serviceCode, subServices = undefined;
      let inputs = [];
      try {
        const def = await fetchJSON(API.serviceDef(svc.serviceCode));
        version = def.version || version;
        estimateFor = def.estimateFor || def.serviceCode;
        inputs = extractInputs(def);

        // If service has subServices in its definition, build them properly
        if (def.subServices?.length) {
          subServices = [];
          for (const sub of def.subServices) {
            try {
              const subDef = await fetchJSON(API.serviceDef(sub.serviceCode));
              const subInputs = extractInputs(subDef);
              const subCC = buildCalcComponents(subInputs);
              subServices.push({
                serviceCode: sub.serviceCode,
                region: svc.region,
                estimateFor: subDef.estimateFor || sub.serviceCode,
                version: subDef.version || "0.0.1",
                description: null,
                calculationComponents: subCC,
                serviceCost: { monthly: 0, upfront: 0 },
              });
            } catch {
              subServices.push({
                serviceCode: sub.serviceCode,
                region: svc.region,
                estimateFor: sub.serviceCode,
                version: "0.0.1",
                description: null,
                calculationComponents: {},
                serviceCost: { monthly: 0, upfront: 0 },
              });
            }
          }
        }

        // Build calculationComponents: merge defaults with user inputs, resolving labels
        cc = buildCalcComponents(inputs, svc.calculationComponents || {});
      } catch {
        // Service definition not found, use user-provided components or empty
        if (svc.calculationComponents) {
          for (const [k, v] of Object.entries(svc.calculationComponents)) {
            cc[k] = typeof v === "object" && v !== null && "value" in v ? v : { value: v };
          }
        }
      }

      const entry = {
        version,
        serviceCode: svc.serviceCode,
        estimateFor,
        region: svc.region,
        description: svc.description || null,
        calculationComponents: cc,
        serviceCost: { monthly: svc.monthlyCost, upfront: svc.upfrontCost || 0 },
        serviceName: svc.serviceName,
        regionName: svc.regionName || REGION_NAMES[svc.region] || svc.region,
        configSummary: svc.configSummary || "",
      };
      if (subServices) entry.subServices = subServices;

      svcMap[key] = entry;
      totalMonthly += svc.monthlyCost;
      totalUpfront += svc.upfrontCost || 0;
      
      // Issue 1: Track group membership
      if (svc.group) {
        if (!groupMap[svc.group]) groupMap[svc.group] = [];
        groupMap[svc.group].push(key);
      }
    }

    // Issue 1: Build groups structure from groupMap
    const groupsObj = {};
    for (const [groupName, serviceKeys] of Object.entries(groupMap)) {
      const groupId = `group-${crypto.randomUUID()}`;
      groupsObj[groupId] = {
        name: groupName,
        services: serviceKeys,
      };
    }

    const payload = {
      name,
      services: svcMap,
      groups: groupsObj,
      groupSubtotal: { monthly: totalMonthly, upfront: totalUpfront },
      totalCost: { monthly: totalMonthly, upfront: totalUpfront },
      support: {},
      metaData: {
        locale: "en_US",
        currency: "USD",
        createdOn: new Date().toISOString(),
        source: "calculator-platform",
      },
    };

    // Issue 2 & 3: Try with calculationComponents first, fallback without them
    let resp = await fetch(API.save, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    let respText = await resp.text();
    let warnings = [];
    
    // Issue 3: Better error handling with response body
    if (!resp.ok) {
      // Fallback - strip calculationComponents and retry
      const strippedServices = [];
      for (const [key, svc] of Object.entries(payload.services)) {
        if (Object.keys(svc.calculationComponents || {}).length > 0) {
          strippedServices.push(svc.serviceName);
        }
        svc.calculationComponents = {};
        if (svc.subServices) {
          for (const sub of svc.subServices) {
            sub.calculationComponents = {};
          }
        }
      }
      
      const retryResp = await fetch(API.save, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      
      const retryText = await retryResp.text();
      
      if (!retryResp.ok) {
        throw new Error(`Failed to save estimate: ${resp.status} ${resp.statusText}. Response: ${respText}. Retry also failed: ${retryResp.status} ${retryText}`);
      }
      
      warnings.push(`⚠️ calculationComponents were rejected by the API (${resp.status}: ${respText.substring(0, 200)}). The estimate was saved without detailed configurations.`);
      warnings.push(`To fix: use get_service_schema to verify field IDs and option values, then recreate with corrected calculationComponents.`);
      if (strippedServices.length > 0) {
        warnings.push(`Affected services: ${strippedServices.join(", ")}`);
      }
      
      resp = retryResp;
      respText = retryText;
    }
    
    const result = JSON.parse(respText);
    if (result.statusCode !== 201 || !result.body) {
      throw new Error(`Save API returned unexpected response: ${respText}`);
    }
    
    const body = JSON.parse(result.body);
    if (!body.savedKey) {
      throw new Error(`No savedKey in response: ${JSON.stringify(body)}`);
    }
    
    const url = `https://calculator.aws/#/estimate?id=${body.savedKey}`;

    const output = [
      `✅ Estimate "${name}" saved successfully!`,
      "",
      `🔗 Shareable link: ${url}`,
      "",
      `Monthly: $${totalMonthly.toFixed(2)} | Upfront: $${totalUpfront.toFixed(2)} | 12-month: $${(totalMonthly * 12 + totalUpfront).toFixed(2)}`,
      "",
    ];
    
    if (Object.keys(groupsObj).length > 0) {
      output.push(`Groups: ${Object.values(groupsObj).map(g => g.name).join(", ")}`);
      output.push("");
    }
    
    output.push(`Services: ${services.length}`);
    for (const s of services) {
      const groupLabel = s.group ? ` [${s.group}]` : "";
      output.push(`  • ${s.serviceName} (${s.region}): $${s.monthlyCost.toFixed(2)}/mo${groupLabel}`);
    }
    
    if (warnings.length > 0) {
      output.push("");
      output.push(...warnings);
    }

    return {
      content: [
        {
          type: "text",
          text: output.join("\n"),
        },
      ],
    };
  }
);

// Tool 4: Load an existing estimate
server.tool(
  "load_estimate",
  "Load an existing AWS Pricing Calculator estimate from a shareable link or estimate ID. Returns the full estimate data.",
  { estimateId: z.string().describe("Estimate ID or full URL (e.g. 'abc123' or 'https://calculator.aws/#/estimate?id=abc123')") },
  async ({ estimateId }) => {
    // Extract ID from URL if needed (IDs can contain hex chars, uppercase, hyphens, etc.)
    const match = estimateId.match(/id=([a-zA-Z0-9-]+)/);
    const id = match ? match[1] : estimateId;

    let data;
    try {
      const resp = await fetch(`${API.load}/${id}`);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}`);
      }
      const text = await resp.text();
      // Check if response is XML (error) or JSON
      if (text.trim().startsWith('<')) {
        throw new Error('Estimate not found or access denied');
      }
      data = JSON.parse(text);
    } catch (e) {
      throw new Error(`Failed to load estimate '${id}': ${e.message}. Check that the estimate ID is valid.`);
    }
    
    const services = Object.values(data.services || {}).map((s) => ({
      serviceName: s.serviceName,
      serviceCode: s.serviceCode,
      region: s.region,
      regionName: s.regionName,
      monthlyCost: s.serviceCost?.monthly || 0,
      upfrontCost: s.serviceCost?.upfront || 0,
      configSummary: s.configSummary,
      description: s.description,
      hasComponents: Object.keys(s.calculationComponents || {}).length > 0,
    }));

    const summary = [
      `📋 Estimate: ${data.name}`,
      `💰 Monthly: $${data.totalCost?.monthly?.toFixed(2)} | Upfront: $${data.totalCost?.upfront?.toFixed(2)}`,
      `📅 Created: ${data.metaData?.createdOn}`,
      "",
      "Services:",
      ...services.map((s) => {
        const editStatus = s.hasComponents ? "✅ editable" : "⚠️ no config data";
        return `  • ${s.serviceName} (${s.regionName}): $${s.monthlyCost.toFixed(2)}/mo [${editStatus}]`;
      }),
    ].join("\n");

    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: "\nFull data:\n" + JSON.stringify(data, null, 2) },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
