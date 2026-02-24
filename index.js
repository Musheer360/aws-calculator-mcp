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
          options: comp.options?.map((o) => o.label || o.value) || null,
        };
        
        // Issue 5 & 6: Add format hints for frequency/fileSize types
        if (field.type === "frequency" || field.type === "fileSize") {
          if (comp.unitOptions) {
            field.unitOptions = comp.unitOptions;
            field.format = "value with unit selector";
          } else if (field.unit) {
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

// Issue 2: Build calculationComponents - only include meaningful defaults
function buildCalcComponents(inputs, userInputs = {}) {
  const cc = {};
  
  // If user provided inputs, use them
  if (userInputs && Object.keys(userInputs).length > 0) {
    for (const [k, v] of Object.entries(userInputs)) {
      cc[k] = typeof v === "object" && v !== null && "value" in v ? v : { value: v };
    }
    return cc;
  }
  
  // Otherwise, only include fields with meaningful defaults (not empty/null)
  for (const inp of inputs) {
    if (inp.id && inp.default != null && inp.default !== "") {
      cc[inp.id] = { value: inp.default };
    }
  }
  
  return cc;
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
  "Get the input schema for a specific AWS service. Returns the fields you can set in calculationComponents when creating an estimate. Use the serviceCode from search_services.",
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
  `Create an AWS Pricing Calculator estimate and return a shareable link.
Each service needs: serviceCode, region, serviceName, monthlyCost.
Optionally provide calculationComponents (key-value pairs from get_service_schema) for the estimate to render detailed configs when opened.
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

      // Issue 2: If user provided calculationComponents, use them as-is
      if (svc.calculationComponents) {
        for (const [k, v] of Object.entries(svc.calculationComponents)) {
          cc[k] = typeof v === "object" && v !== null && "value" in v ? v : { value: v };
        }
      }

      // Try to fetch service definition for version and structure
      let version = "0.0.1", estimateFor = svc.serviceCode, subServices = undefined;
      try {
        const def = await fetchJSON(API.serviceDef(svc.serviceCode));
        version = def.version || version;
        estimateFor = def.estimateFor || def.serviceCode;

        // If service has subServices in its definition, build them properly
        if (def.subServices?.length && !svc.calculationComponents) {
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

        // If no user-provided cc, build defaults from definition
        if (!svc.calculationComponents) {
          const inputs = extractInputs(def);
          cc = buildCalcComponents(inputs);
        }
      } catch {
        // Service definition not found, use minimal structure
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
        regionName: svc.regionName || svc.region,
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
      // Issue 2: Fallback - strip calculationComponents and retry
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
      
      // Issue 7: Provide feedback on what was stripped
      warnings.push(`⚠️  Original attempt with calculationComponents failed (${resp.status}: ${respText.substring(0, 200)}). Retried without calculationComponents — estimate saved successfully but service configurations won't render in detail.`);
      if (strippedServices.length > 0) {
        warnings.push(`Services with stripped components: ${strippedServices.join(", ")}`);
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
    // Extract ID from URL if needed
    const match = estimateId.match(/id=([a-f0-9]+)/);
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
    }));

    const summary = [
      `📋 Estimate: ${data.name}`,
      `💰 Monthly: $${data.totalCost?.monthly?.toFixed(2)} | Upfront: $${data.totalCost?.upfront?.toFixed(2)}`,
      `📅 Created: ${data.metaData?.createdOn}`,
      "",
      "Services:",
      ...services.map((s) => `  • ${s.serviceName} (${s.regionName}): $${s.monthlyCost.toFixed(2)}/mo`),
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
