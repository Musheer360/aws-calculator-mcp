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
        inputs.push({
          id: comp.id,
          label: comp.label,
          type: comp.subType || comp.type,
          description: comp.description || "",
          default: comp.defaultValue ?? comp.value ?? null,
          unit: comp.unit || null,
          options: comp.options?.map((o) => o.label || o.value) || null,
        });
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

// Build calculationComponents from user inputs + service definition defaults
function buildCalcComponents(inputs, userInputs = {}) {
  const cc = {};
  for (const inp of inputs) {
    if (inp.id) {
      const val = userInputs[inp.id] ?? inp.default ?? "";
      // Check if already wrapped in {value: ...} format
      if (typeof val === "object" && val !== null && "value" in val) {
        cc[inp.id] = val;
      } else {
        cc[inp.id] = { value: val };
      }
    }
  }
  // Merge any extra user inputs not in the definition
  for (const [k, v] of Object.entries(userInputs)) {
    if (!cc[k]) {
      cc[k] = typeof v === "object" && v !== null && "value" in v ? v : { value: v };
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
Optionally provide calculationComponents (key-value pairs from get_service_schema) for the estimate to render detailed configs when opened.`,
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
        })
      )
      .describe("Array of services to include"),
    groups: z
      .record(
        z.object({
          name: z.string(),
          serviceKeys: z.array(z.string()).describe("Service keys to include in this group"),
        })
      )
      .optional()
      .describe("Optional groups to organize services"),
  },
  async ({ name, services, groups }) => {
    const svcMap = {};
    let totalMonthly = 0, totalUpfront = 0;

    for (const svc of services) {
      const key = `${svc.serviceCode}-${crypto.randomUUID()}`;
      let cc = {};

      // If user provided calculationComponents, wrap values properly
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
    }

    // Build groups structure
    const groupsMap = {};
    if (groups) {
      for (const [groupKey, groupData] of Object.entries(groups)) {
        const groupId = `group-${crypto.randomUUID()}`;
        groupsMap[groupId] = {
          name: groupData.name,
          services: groupData.serviceKeys,
        };
      }
    }

    const payload = {
      name,
      services: svcMap,
      groups: groupsMap,
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

    const resp = await fetch(API.save, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    
    if (!resp.ok) {
      throw new Error(`Failed to save estimate: ${resp.status} ${resp.statusText}`);
    }
    
    const result = await resp.json();
    if (result.statusCode !== 201 || !result.body) {
      throw new Error(`Save API returned unexpected response: ${JSON.stringify(result)}`);
    }
    
    const body = JSON.parse(result.body);
    if (!body.savedKey) {
      throw new Error(`No savedKey in response: ${JSON.stringify(body)}`);
    }
    
    const url = `https://calculator.aws/#/estimate?id=${body.savedKey}`;

    return {
      content: [
        {
          type: "text",
          text: [
            `✅ Estimate "${name}" saved successfully!`,
            "",
            `🔗 Shareable link: ${url}`,
            "",
            `Monthly: $${totalMonthly.toFixed(2)} | Upfront: $${totalUpfront.toFixed(2)} | 12-month: $${(totalMonthly * 12 + totalUpfront).toFixed(2)}`,
            "",
            `Services: ${services.length}`,
            ...services.map((s) => `  • ${s.serviceName} (${s.region}): $${s.monthlyCost.toFixed(2)}/mo`),
          ].join("\n"),
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
