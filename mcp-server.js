#!/usr/bin/env node
// AWS Pricing Calculator MCP Server
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const { PARTITIONS, loadManifest, findService, fetchServiceDefinition, extractInputFields, enrichFieldsWithMetadata, searchServices, fetchEstimate, estimateToMarkdown } = require('./lib/aws-client');
const EstimateBuilder = require('./lib/estimate-builder');

const estimates = new Map();
const ESTIMATE_TTL_MS = 3600000; // 1 hour
const ESTIMATE_MAX = 50;
const META_KEYS = new Set(['region', 'description']);

function pruneEstimates() {
  const now = Date.now();
  for (const [id, est] of estimates) {
    if (now - est._createdAt > ESTIMATE_TTL_MS) estimates.delete(id);
  }
  // Hard cap: remove oldest if still over limit
  if (estimates.size > ESTIMATE_MAX) {
    const sorted = [...estimates.entries()].sort((a, b) => a[1]._createdAt - b[1]._createdAt);
    while (sorted.length > ESTIMATE_MAX) {
      const [id] = sorted.shift();
      estimates.delete(id);
    }
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = d[0]; d[0] = j;
    for (let i = 1; i <= m; i++) { const tmp = d[i]; d[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, d[i], d[i - 1]); prev = tmp; }
  }
  return d[m];
}

function suggestMatch(invalid, validIds, max = 3) {
  const lower = invalid.toLowerCase();
  return validIds.map(id => ({ id, dist: levenshtein(lower, id.toLowerCase()) })).filter(m => m.dist <= Math.max(Math.floor(invalid.length * 0.6), 3)).sort((a, b) => a.dist - b.dist).slice(0, max).map(m => m.id);
}

async function validateConfigKeys(serviceKey, config, partition) {
  if (serviceKey.toLowerCase() === 'ec2enhancement') return null;
  const configKeys = Object.keys(config).filter(k => !META_KEYS.has(k));
  if (configKeys.length === 0) return null;
  try {
    const manifest = await loadManifest(partition || 'aws');
    const svc = findService(manifest, serviceKey);
    if (!svc) return null;
    const def = await fetchServiceDefinition(manifest, svc.key, partition || 'aws');
    if (!def) return null;
    const fields = extractInputFields(def);
    const validIds = fields.map(f => f.id);
    const validSet = new Set(validIds);
    const invalid = configKeys.filter(k => !validSet.has(k));
    if (invalid.length > 0) {
      const lines = invalid.map(k => {
        const suggestions = suggestMatch(k, validIds);
        return suggestions.length ? `  "${k}" — did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?` : `  "${k}" — no close match found`;
      });
      return `Invalid field IDs for ${svc.key}:\n${lines.join('\n')}\nUse get_service_fields to discover valid field IDs.`;
    }
    const enriched = await enrichFieldsWithMetadata(def, fields);
    const selectorErrors = [];
    for (const field of enriched) {
      if (field.type !== 'columnFormIPM' || !field.selectorValues) continue;
      const configVal = config[field.id];
      if (!configVal || !configVal.value || !Array.isArray(configVal.value)) continue;
      for (const row of configVal.value) {
        for (const [selectorId, allowedValues] of Object.entries(field.selectorValues)) {
          if (!allowedValues || allowedValues.length === 0) continue;
          const cell = row[selectorId];
          if (!cell) continue;
          const cellValue = typeof cell === 'object' && cell.value !== undefined ? cell.value : cell;
          if (typeof cellValue !== 'string') continue;
          if (!allowedValues.includes(cellValue)) {
            const suggestions = suggestMatch(cellValue, allowedValues);
            const hint = suggestions.length ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?` : '';
            selectorErrors.push(`  Field "${field.id}", selector "${selectorId}": "${cellValue}" is not valid.${hint}\n    Allowed: ${allowedValues.slice(0, 10).join(', ')}${allowedValues.length > 10 ? ` ... (${allowedValues.length} total)` : ''}`);
          }
        }
      }
    }
    if (selectorErrors.length > 0) return `Invalid selector values for ${svc.key}:\n${selectorErrors.join('\n')}`;
    return null;
  } catch { return null; }
}

const pkg = require('./package.json');
const server = new McpServer({ name: pkg.name, version: pkg.version });

server.tool('search_services', 'Search AWS services available in the calculator. Returns service keys and names. Supports multiple comma-separated search terms (e.g. "Lambda, S3, API Gateway").', {
  query: z.string().describe('One or more search terms, comma-separated'),
  partition: z.string().optional().describe('AWS partition (default: "aws"). Valid: "aws", "aws-iso", "aws-iso-b"'),
}, async ({ query, partition }) => {
  const p = partition || 'aws';
  if (!PARTITIONS[p]) return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
  const manifest = await loadManifest(p);
  return { content: [{ type: 'text', text: JSON.stringify(searchServices(manifest, query), null, 2) }] };
});

server.tool('get_service_fields', 'Get input fields for one or more AWS services. Returns field IDs, types, labels, and valid options. Accepts multiple comma-separated service keys. IMPORTANT: When duplicate fields exist with version suffixes (e.g. fieldName and fieldName_v2), ALWAYS use the highest version.', {
  service: z.string().describe('One or more service keys, comma-separated'),
  partition: z.string().optional().describe('AWS partition (default: "aws"). Valid: "aws", "aws-iso", "aws-iso-b"'),
}, async ({ service, partition }) => {
  const p = partition || 'aws';
  if (!PARTITIONS[p]) return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
  const manifest = await loadManifest(p);
  const keys = service.split(',').map(s => s.trim()).filter(Boolean);
  const results = [], errors = [];
  for (const key of keys) {
    const svc = findService(manifest, key);
    if (!svc) {
      // Fuzzy match: suggest closest service keys
      const allKeys = [...manifest.keys()];
      const suggestions = suggestMatch(key, allKeys, 3);
      errors.push(suggestions.length ? `Service "${key}" not found. Did you mean: ${suggestions.join(', ')}?` : `Service "${key}" not found. Use search_services to find valid keys.`);
      continue;
    }
    const definition = await fetchServiceDefinition(manifest, svc.key, p).catch(async () => {
      // Retry once after 2s on failure
      await new Promise(r => setTimeout(r, 2000));
      return fetchServiceDefinition(manifest, svc.key, p).catch(() => null);
    });
    if (!definition) { errors.push(`Failed to fetch definition for "${svc.key}". Try again.`); continue; }
    const fields = extractInputFields(definition);
    const enriched = await enrichFieldsWithMetadata(definition, fields);
    results.push({ serviceCode: svc.key, serviceName: svc.name, fields: enriched });
  }
  const output = errors.length ? { services: results, errors } : keys.length === 1 ? results[0] : results;
  return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
});

server.tool('create_estimate', 'Create a new empty estimate. Returns an estimate ID to use with add_service and export_estimate.', {
  name: z.string().optional().describe('Name for the estimate (default: "My Estimate")'),
  partition: z.string().optional().describe('AWS partition (default: "aws"). Valid: "aws", "aws-iso", "aws-iso-b"'),
}, async ({ name, partition }) => {
  const p = partition || undefined;
  if (p && !PARTITIONS[p]) return { content: [{ type: 'text', text: `Unknown partition '${p}'. Valid partitions: ${Object.keys(PARTITIONS).join(', ')}` }], isError: true };
  pruneEstimates();
  const estimate = new EstimateBuilder(name, p);
  estimate._createdAt = Date.now();
  estimates.set(estimate.id, estimate);
  return { content: [{ type: 'text', text: JSON.stringify({ estimate_id: estimate.id, name: estimate.name }) }] };
});

async function resolveServiceKey(service, instance, partition) {
  if (!instance) return service;
  // If instance is provided, check if it's a valid sub-service of the parent
  const manifest = await loadManifest(partition || 'aws');
  const parent = findService(manifest, service);
  if (parent && parent.subType === 'subServiceSelector' && Array.isArray(parent.templates)) {
    const match = parent.templates.find(t => t.toLowerCase() === instance.toLowerCase());
    if (match) return match; // Use the sub-service directly
  }
  // Fallback: check if instance itself is a valid service
  const direct = findService(manifest, instance);
  if (direct) return direct.key;
  return service; // Last resort: use as-is
}

function estimateServiceCount(estimate) {
  let count = Object.keys(estimate.services).length;
  for (const g of Object.values(estimate.groups)) count += Object.keys(g.services).length;
  return count;
}

server.tool('add_service', `Add one or more AWS services to an estimate. Field values follow these patterns based on field type:
- numericInput: plain string value, e.g. "1000"
- frequency: object with value and unit, e.g. {"value": "19", "unit": "millionPerMonth"}
- fileSize: object with value and unit, e.g. {"value": "512", "unit": "mb|NA"}
- dropdown: string matching one of the option IDs from get_service_fields
- durationInput: object with value and unit, e.g. {"value": "960", "unit": "min"}
- dataTransferV2: array of transfer entries. Format: [{"entryType":"OUTBOUND","value":"500","unit":"gb_month","toRegion":"External"},{"entryType":"INBOUND","value":"","unit":"tb_month","fromRegion":""},{"entryType":"INTRA_REGION","value":"","unit":"gb_month"}]. Use "External" for internet, or a region code for inter-region.
- pricingStrategy (EC2 only): object with model, term, upfrontPayment keys
Amazon EC2 (ec2Enhancement) has special config fields: instanceType, selectedOS, tenancy, pricingStrategy, quantity, storageType, storageAmount, snapshotFrequency, gp3Iops, gp3Throughput, iops, iops2, storageAmountIo2. Do NOT use get_service_fields for EC2.
Sub-services: Use the sub-service key directly (e.g. "applicationLoadBalancer" not "elasticLoadBalancing" with instance). Or pass instance and the parent will be resolved automatically.
IMPORTANT: Always include "region" in each service config. Descriptions and group names must NOT contain <, >, or & characters.
Config keys are validated against the service definition with typo detection.`, {
  estimate_id: z.string().describe('Estimate ID from create_estimate'),
  services: z.string().describe('JSON array of service entries. Each: {"service":"serviceKey","instance":"optional sub-service","group":"optional","config":{...with region, description, and field values}}'),
}, async ({ estimate_id, services: servicesStr }) => {
  const estimate = estimates.get(estimate_id);
  if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found. It may have expired (estimates expire after 1 hour).` }], isError: true };
  let entries;
  try { entries = JSON.parse(servicesStr); if (!Array.isArray(entries)) entries = [entries]; } catch { return { content: [{ type: 'text', text: 'Invalid JSON in services parameter.' }], isError: true }; }
  const results = [];
  for (const entry of entries) {
    const { service, instance, group } = entry;
    let config = entry.config;
    if (!service || !config) { results.push({ error: 'Missing "service" or "config" in entry', entry }); continue; }
    if (typeof config === 'string') { try { config = JSON.parse(config); } catch { results.push({ error: 'Invalid JSON in config', service }); continue; } }
    // Resolve instance syntax: elasticLoadBalancing + instance:applicationLoadBalancer → applicationLoadBalancer
    const resolvedKey = await resolveServiceKey(service, instance, estimate.partition);
    // Warn if using a parent selector without specifying a sub-service
    const manifest = await loadManifest(estimate.partition || 'aws');
    const resolvedSvc = findService(manifest, resolvedKey);
    if (resolvedSvc && resolvedSvc.subType === 'subServiceSelector') {
      const subs = resolvedSvc.templates || [];
      results.push({ error: `"${resolvedKey}" is a service category, not a calculable service. You must use one of its sub-services: ${subs.join(', ')}. Pass it as "service" directly or use "instance".`, service: resolvedKey });
      continue;
    }
    const validationError = await validateConfigKeys(resolvedKey, config, estimate.partition);
    if (validationError) { results.push({ error: validationError, service: resolvedKey }); continue; }
    estimate.addService(resolvedKey, config, { group });
    results.push({ success: true, service: resolvedKey, group: group || '(ungrouped)', description: config.description || null });
  }
  const total = estimateServiceCount(estimate);
  return { content: [{ type: 'text', text: JSON.stringify({ added: results, estimate_total_services: total, hint: 'Use export_estimate then refresh_estimate to get actual costs.' }, null, 2) }] };
});

server.tool('export_estimate', 'Export an estimate to calculator.aws and get a shareable URL. The link will show the full estimate with AWS-calculated pricing.', {
  estimate_id: z.string().describe('Estimate ID from create_estimate'),
}, async ({ estimate_id }) => {
  const estimate = estimates.get(estimate_id);
  if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found. It may have expired (estimates expire after 1 hour).` }], isError: true };
  try {
    const result = await estimate.export();
    return { content: [{ type: 'text', text: JSON.stringify({ sharable_url: result.shareableUrl, aws_estimate_id: result.estimateId, note: 'Costs take ~15-30s to propagate. Wait before calling refresh_estimate.' }) }] };
  } catch (err) { return { content: [{ type: 'text', text: `Export failed: ${err.message}` }], isError: true }; }
});

server.tool('update_service', 'Update an existing service in an estimate by replacing its config. Use this to tweak values without recreating the entire estimate. Identifies the service by its key (and optionally group). Merges new config over existing config unless replace=true.', {
  estimate_id: z.string().describe('Estimate ID'),
  service: z.string().describe('Service key to update (e.g. "amazonRDSMySQLDB", "ec2Enhancement"). For duplicate services, append :description (e.g. "ec2Enhancement:BastionHost")'),
  group: z.string().optional().describe('Group name if the service is in a group'),
  config: z.string().describe('JSON object with config fields to update. Only specified fields are changed (merged). Pass "__replace": true to replace entire config.'),
}, async ({ estimate_id, service: serviceKey, group, config: configStr }) => {
  const estimate = estimates.get(estimate_id);
  if (!estimate) return { content: [{ type: 'text', text: `Estimate "${estimate_id}" not found.` }], isError: true };
  let newConfig;
  try { newConfig = JSON.parse(configStr); } catch { return { content: [{ type: 'text', text: 'Invalid JSON in config parameter.' }], isError: true }; }
  const replace = newConfig.__replace; delete newConfig.__replace;

  // Find the service in the estimate
  const findInMap = (map) => {
    // Exact match
    if (map[serviceKey]) return serviceKey;
    // Match by prefix (for keys with :description suffix)
    for (const k of Object.keys(map)) {
      if (k === serviceKey || k.startsWith(serviceKey + ':')) return k;
    }
    // Match by description
    for (const [k, v] of Object.entries(map)) {
      if (k.split(':')[0] === serviceKey.split(':')[0] && v.description && serviceKey.includes(v.description.replace(/\s+/g, ''))) return k;
    }
    return null;
  };

  let target, foundKey;
  if (group) {
    const g = estimate.groups[group];
    if (!g) return { content: [{ type: 'text', text: `Group "${group}" not found. Available: ${Object.keys(estimate.groups).join(', ')}` }], isError: true };
    foundKey = findInMap(g.services);
    if (foundKey) target = g.services;
  } else {
    // Search ungrouped first, then all groups
    foundKey = findInMap(estimate.services);
    if (foundKey) { target = estimate.services; }
    else {
      for (const [gName, g] of Object.entries(estimate.groups)) {
        foundKey = findInMap(g.services);
        if (foundKey) { target = g.services; group = gName; break; }
      }
    }
  }

  if (!foundKey || !target) {
    const allKeys = [...Object.keys(estimate.services), ...Object.values(estimate.groups).flatMap(g => Object.keys(g.services))];
    return { content: [{ type: 'text', text: `Service "${serviceKey}" not found in estimate. Available services: ${allKeys.join(', ')}` }], isError: true };
  }

  // Validate new config keys
  const resolvedSvc = foundKey.split(':')[0];
  const validationError = await validateConfigKeys(resolvedSvc, newConfig, estimate.partition);
  if (validationError) return { content: [{ type: 'text', text: validationError }], isError: true };

  // Apply update
  if (replace) {
    // Preserve region and description if not in new config
    const old = target[foundKey];
    if (!newConfig.region && old.region) newConfig.region = old.region;
    if (!newConfig.description && old.description) newConfig.description = old.description;
    target[foundKey] = newConfig;
  } else {
    target[foundKey] = { ...target[foundKey], ...newConfig };
  }

  return { content: [{ type: 'text', text: JSON.stringify({ success: true, service: foundKey, group: group || '(ungrouped)', updated_fields: Object.keys(newConfig), hint: 'Use export_estimate then refresh_estimate to get updated costs.' }) }] };
});

server.tool('import_estimate', 'Download an existing AWS Pricing Calculator estimate by URL or ID. Returns JSON (raw, for modifications) or Markdown (for LLM consumption).', {
  estimate_id: z.string().describe('Estimate ID or full calculator.aws URL'),
  format: z.enum(['json', 'markdown']).optional().describe('Output format: "json" (default) or "markdown"'),
}, async ({ estimate_id, format }) => {
  let id = estimate_id.trim();
  const urlMatch = id.match(/[?&#]id=([a-fA-F0-9]+)/) || id.match(/^(?:https?:\/\/)?calculator\.aws.*?([a-fA-F0-9]{20,})$/);
  if (urlMatch) id = urlMatch[1];
  try {
    const data = await fetchEstimate(id);
    const output = (format === 'markdown') ? estimateToMarkdown(data) : JSON.stringify(data, null, 2);
    return { content: [{ type: 'text', text: output }] };
  } catch (err) { return { content: [{ type: 'text', text: `Import failed: ${err.message}` }], isError: true }; }
});

server.tool('refresh_estimate', 'Open an estimate URL in a headless browser, trigger cost recalculation, and return the updated pricing. This is the ONLY way to get actual dollar amounts — the API does not calculate costs. Automatically retries once after 15s if costs show $0 (propagation delay). Requires Chrome/Chromium.', {
  estimate_url: z.string().describe('Full calculator.aws estimate URL (e.g. "https://calculator.aws/#/estimate?id=abc123")'),
}, async ({ estimate_url }) => {
  try {
    const { refreshEstimate } = require('./lib/browser');
    let result = await refreshEstimate(estimate_url);
    // Propagation retry: exponential backoff if costs are $0 but services exist
    if (result.success && result.data.monthlyCost === 0 && result.data.services.length > 0) {
      for (const delay of [5000, 10000, 20000]) {
        console.error(`[refresh] $0 detected — retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
        result = await refreshEstimate(estimate_url);
        if (result.data.monthlyCost > 0) break;
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Refresh failed: ${err.message}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => { console.error(err); process.exit(1); });
