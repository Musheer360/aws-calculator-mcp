// AWS Pricing Calculator MCP — API client.
'use strict';

const PERSIST_ENDPOINT = process.env.AWS_SAVE_URL || 'https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs';
const CATALOG_CDN = 'https://d1qsjq9pzbk1k6.cloudfront.net';
const PRICING_CDN = 'https://calculator.aws';
const READ_ENDPOINT = 'https://d3knqfixx3sbls.cloudfront.net';
const TIMEOUT_MS = 15000;
const SCHEMA_CACHE_LIMIT = 200;
const MAX_RETRIES = 2;

const PARTITIONS = {
  aws: { manifestPath: '/manifest/en_US.json', cdnPrefix: '', contract: null, awsPartition: 'aws', regions: {} },
  'aws-iso': { manifestPath: '/aws-iso/manifest/en_US.json', cdnPrefix: '/aws-iso', contract: '5423f8cd3b711c6f899ba4dade31b50c', awsPartition: 'aws-iso', regions: { 'us-iso-east-1': 'US ISO East', 'us-iso-west-1': 'US ISO West' } },
  'aws-iso-b': { manifestPath: '/aws-iso-b/manifest/en_US.json', cdnPrefix: '/aws-iso-b', contract: '5423f8cd3b711c6f899ba4dade31b50c', awsPartition: 'aws-iso-b', regions: { 'us-isob-east-1': 'US ISOB East (Ohio)' } },
};

class CalculatorError extends Error {
  constructor(msg, code) { super(msg); this.name = 'CalculatorError'; this.code = code; }
}

function timedFetch(url, opts = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

function detectPartition(region) {
  if (!region) return 'aws';
  if (region.startsWith('us-iso-')) return 'aws-iso';
  if (region.startsWith('us-isob-')) return 'aws-iso-b';
  return 'aws';
}

// --- Field extraction constants ---
const FIELD_TYPES = new Set(['input', 'numericInput', 'frequency', 'fileSize', 'durationInput', 'percentInput']);
const FIELD_SUBTYPES = new Set(['dropdown', 'numericInput', 'frequency', 'fileSize', 'durationInput', 'columnFormIPM', 'dataTransferV2']);
const COLUMN_FORM_HINT = 'columnFormIPM expects {value: [rowObject]} — an array of row objects keyed by selectorId. Each cell wraps its value as {value: ...}. Example: {value: [{"Number of Nodes": {value: "1"}, "Instance Type": {value: "db.r6g.xlarge"}, "undefined": {value: {unit: "100", selectedId: "%Utilized/Month"}}, "Deployment Option": {value: "Single-AZ"}, "TermType": {value: "OnDemand"}}]}.';

// --- Singleton API client ---
class CalculatorAPI {
  constructor() {
    this._catalogs = new Map();  // partition → Promise<Map<key, service>>
    this._schemas = new Map();   // "partition:key" → Promise<definition>
    this._metadata = new Map();  // url → Promise<metadata>
  }

  async getServiceCatalog(partition = 'aws') {
    if (!PARTITIONS[partition]) throw new CalculatorError(`Unknown partition '${partition}'. Valid: ${Object.keys(PARTITIONS).join(', ')}`, 'INVALID_PARTITION');
    if (this._catalogs.has(partition)) return this._catalogs.get(partition);
    const url = `${CATALOG_CDN}${PARTITIONS[partition].manifestPath}`;
    const promise = (async () => {
      const res = await timedFetch(url);
      if (!res.ok) throw new CalculatorError(`Catalog fetch failed: HTTP ${res.status}`, 'FETCH_ERROR');
      const raw = await res.json();
      const catalog = new Map();
      for (const s of raw.awsServices) {
        const key = s.key || s.serviceCode;
        if (key) catalog.set(key, { ...s, key });
      }
      console.error(`Loaded ${catalog.size} services from manifest (partition: ${partition})`);
      return catalog;
    })();
    this._catalogs.set(partition, promise);
    promise.catch(() => this._catalogs.delete(partition));
    return promise;
  }

  lookupService(catalog, name) {
    const lower = name.toLowerCase();
    for (const [key, svc] of catalog) {
      if (key.toLowerCase() === lower) return svc;
    }
    return null;
  }

  queryServices(catalog, query) {
    const terms = query.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!terms.length) return [];
    const match = (term) => {
      const hits = [];
      for (const [key, svc] of catalog) {
        if (svc.subType === 'subServiceSelector' || svc.isActive === 'false') continue;
        const found = key.toLowerCase().includes(term) || (svc.name && svc.name.toLowerCase().includes(term)) || svc.searchKeywords?.some(kw => kw.toLowerCase().includes(term));
        if (found) hits.push({ key, name: svc.name });
      }
      return hits;
    };
    if (terms.length === 1) return match(terms[0]);
    const grouped = {};
    for (const t of terms) grouped[t] = match(t);
    return grouped;
  }

  async getServiceSchema(catalog, serviceCode, partition = 'aws') {
    const cacheKey = `${partition}:${serviceCode}`;
    if (this._schemas.has(cacheKey)) return this._schemas.get(cacheKey);
    const svc = catalog.get(serviceCode);
    if (!svc) return null;
    const urlPath = svc.serviceDefinitionUrlPath || `/data/${serviceCode}/en_US.json`;
    const prefix = PARTITIONS[partition]?.cdnPrefix || '';
    // Evict oldest if at capacity
    if (this._schemas.size >= SCHEMA_CACHE_LIMIT) {
      const oldest = this._schemas.keys().next().value;
      this._schemas.delete(oldest);
    }
    const promise = (async () => {
      const res = await timedFetch(`${CATALOG_CDN}${prefix}${urlPath}`);
      if (!res.ok) throw new CalculatorError(`Schema fetch failed for ${serviceCode}: HTTP ${res.status}`, 'FETCH_ERROR');
      return res.json();
    })();
    this._schemas.set(cacheKey, promise);
    promise.catch(() => this._schemas.delete(cacheKey));
    return promise;
  }

  async loadFieldMetadata(mappingDef) {
    if (!mappingDef || mappingDef.mappingDefinitionVersion !== 'PLC_2.0') return null;
    const url = mappingDef.mappingDefinitionURL;
    if (!url || !url.endsWith('metadata.json')) return null;
    const resolved = `${PRICING_CDN}/${url.replace('[currency]', 'USD')}`;
    if (this._metadata.has(resolved)) return this._metadata.get(resolved);
    const promise = (async () => {
      try {
        const res = await timedFetch(resolved);
        if (!res.ok) return null;
        const data = await res.json();
        return { valueAttributes: data.valueAttributes || {}, primarySelectors: data.primarySelectors || [], secondarySelectors: data.secondarySelectors || [] };
      } catch { return null; }
    })();
    this._metadata.set(resolved, promise);
    return promise;
  }

  async persistEstimate(payload) {
    const body = JSON.stringify(payload);
    console.error(`[persist] ${body.length} bytes, ${Object.keys(payload.groups || {}).length} groups`);
    let lastErr;
    for (let i = 0; i <= MAX_RETRIES; i++) {
      try {
        const res = await timedFetch(PERSIST_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', Referer: 'https://calculator.aws/' }, body });
        const raw = await res.text();
        if (!res.ok) {
          let detail;
          try { detail = decodeSaveResponse(raw).message; } catch { detail = raw.substring(0, 200); }
          throw new CalculatorError(`Save API HTTP ${res.status}: ${detail}`, 'SAVE_ERROR');
        }
        const decoded = decodeSaveResponse(raw);
        console.error(`[persist] OK → ${decoded.savedKey}`);
        return { estimateId: decoded.savedKey, shareableUrl: `https://calculator.aws/#/estimate?id=${decoded.savedKey}` };
      } catch (err) {
        lastErr = err;
        if (i < MAX_RETRIES) { await new Promise(r => setTimeout(r, 1000 * (i + 1))); }
      }
    }
    throw lastErr;
  }

  async downloadEstimate(estimateId) {
    const res = await timedFetch(`${READ_ENDPOINT}/${estimateId}`);
    if (!res.ok) throw new CalculatorError(`Download failed: HTTP ${res.status}`, 'FETCH_ERROR');
    return res.json();
  }
}

function decodeSaveResponse(raw) {
  let outer;
  try { outer = JSON.parse(raw); } catch { throw new CalculatorError('Save API returned invalid JSON', 'PARSE_ERROR'); }
  let inner;
  try { inner = JSON.parse(outer.body); } catch { throw new CalculatorError('Save API returned invalid body', 'PARSE_ERROR'); }
  if (!inner.savedKey) throw new CalculatorError(`No savedKey in response: ${JSON.stringify(inner).substring(0, 200)}`, 'MISSING_KEY');
  return inner;
}

// --- Field parsing ---
function parseInputFields(definition) {
  const fields = [];
  const seen = new Set();
  const visited = new WeakSet();
  const walk = (node, tplId) => {
    if (!node || typeof node !== 'object' || visited.has(node)) return;
    visited.add(node);
    if (node.id && (FIELD_TYPES.has(node.type) || FIELD_SUBTYPES.has(node.subType))) {
      const kind = node.subType || node.type;
      if (['bodyText', 'headerText', 'alert'].includes(kind)) { /* decorative */ }
      else if (node.id.includes('WithoutFreeTier') || node.id.includes('_withoutFree') || node.id.endsWith('_MVP')) { /* duplicate */ }
      else {
        const dedupKey = `${node.id}:${kind}`;
        if (!seen.has(dedupKey)) {
          seen.add(dedupKey);
          const f = { id: node.id, type: kind };
          if (tplId) f.templateId = tplId;
          if (node.label) f.label = node.label;
          if (node.options) f.options = node.options.filter(o => o.id !== undefined || o.label !== undefined).map(o => { const r = {}; if (o.id !== undefined) r.id = o.id; if (o.label) r.label = o.label; return r; });
          if (node.unit) f.unit = node.unit;
          if (kind === 'fileSize') {
            const sizes = node.dropDownSize?.map(s => s.value || s.id) || ['gb'];
            const defSize = node.defaultOption?.size || node.outputSize || 'gb';
            const defFreq = node.defaultOption?.frequency || node.outputFrequency || 'NA';
            f.unitFormat = `{value}|{size}|{frequency} — sizes: [${sizes.join(', ')}], default: "${defSize}|${defFreq}"`;
            f.validSizes = sizes;
            f.defaultUnit = `${defSize}|${defFreq}`;
          }
          if (kind === 'columnFormIPM') {
            f.mappingDefinitionName = node.mappingDefinitionName || null;
            f.row = (node.row || []).map(r => {
              const item = { label: r.label, selectorId: r.selectorId, type: r.type };
              if (r.exportValueAs) item.exportValueAs = r.exportValueAs;
              if (r.isInstanceType) item.isInstanceType = true;
              if (r.mappingValue) item.mappingValue = r.mappingValue;
              return item;
            });
            f.valueShape = COLUMN_FORM_HINT;
          }
          fields.push(f);
        }
      }
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(x => walk(x, tplId));
      else if (typeof v === 'object') walk(v, tplId);
    }
  };
  const templates = Array.isArray(definition.templates) ? definition.templates : null;
  if (templates && templates.length > 0) { for (const tpl of templates) walk(tpl, tpl.id); }
  else walk(definition, null);
  return fields;
}

async function attachSelectorMetadata(definition, fields) {
  const mappingDefs = definition.mappingDefinitions;
  if (!Array.isArray(mappingDefs) || !mappingDefs.length) return fields;
  const needed = new Set();
  for (const f of fields) { if (f.type === 'columnFormIPM' && f.mappingDefinitionName) needed.add(f.mappingDefinitionName); }
  if (!needed.size) return fields;
  const resolved = new Map();
  await Promise.all([...needed].map(async name => {
    const def = mappingDefs.find(d => d.mappingDefinitionName === name);
    const meta = await api.loadFieldMetadata(def);
    if (meta) resolved.set(name, meta);
  }));
  for (const f of fields) {
    if (f.type === 'columnFormIPM' && f.mappingDefinitionName) {
      const meta = resolved.get(f.mappingDefinitionName);
      if (meta) {
        const selectors = new Set(f.row.map(r => r.selectorId).filter(Boolean));
        const vals = {};
        for (const [k, v] of Object.entries(meta.valueAttributes)) { if (selectors.has(k)) vals[k] = v; }
        if (Object.keys(vals).length) f.selectorValues = vals;
      }
    }
  }
  return fields;
}

function renderMarkdown(data) {
  const lines = [`# ${data.name || 'AWS Estimate'}\n`];
  const total = data.totalCost;
  if (total) lines.push(`**Total Monthly Cost:** $${total.monthly?.toFixed(2) || '0.00'}${total.upfront ? ` | **Upfront:** $${total.upfront.toFixed(2)}` : ''}\n`);
  const listServices = (services, indent = '') => {
    for (const [, svc] of Object.entries(services)) {
      const cost = svc.serviceCost?.monthly != null ? ` — $${svc.serviceCost.monthly.toFixed(2)}/mo` : '';
      lines.push(`${indent}- **${svc.serviceName}** (${svc.regionName})${cost}`);
      if (svc.description) lines.push(`${indent}  - Description: ${svc.description}`);
      if (svc.configSummary) lines.push(`${indent}  - Config: ${svc.configSummary}`);
    }
  };
  if (data.services && Object.keys(data.services).length) { lines.push('## Services\n'); listServices(data.services); }
  if (data.groups) {
    for (const [, group] of Object.entries(data.groups)) {
      lines.push(`\n## ${group.name || 'Group'}\n`);
      if (group.totalCost?.monthly != null) lines.push(`**Group Monthly:** $${group.totalCost.monthly.toFixed(2)}\n`);
      if (group.services) listServices(group.services);
    }
  }
  return lines.join('\n');
}

// Singleton instance
const api = new CalculatorAPI();

// Backward-compatible exports using the old names mapped to new ones
// This allows gradual migration in consuming files
module.exports = {
  PARTITIONS,
  resolvePartition: detectPartition,
  loadManifest: (p) => api.getServiceCatalog(p),
  findService: (catalog, name) => api.lookupService(catalog, name),
  searchServices: (catalog, q) => api.queryServices(catalog, q),
  fetchServiceDefinition: (catalog, code, p) => api.getServiceSchema(catalog, code, p),
  extractInputFields: parseInputFields,
  enrichFieldsWithMetadata: attachSelectorMetadata,
  saveEstimate: (payload) => api.persistEstimate(payload),
  fetchEstimate: (id) => api.downloadEstimate(id),
  estimateToMarkdown: renderMarkdown,
  parseDoubleEncodedResponse: decodeSaveResponse,
  // Also export new names for direct use
  CalculatorAPI, CalculatorError, detectPartition, parseInputFields, attachSelectorMetadata, renderMarkdown, decodeSaveResponse,
};
