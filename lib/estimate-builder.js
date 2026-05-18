// AWS Pricing Calculator MCP — Estimate builder.
'use strict';

const crypto = require('crypto');
const { PARTITIONS, resolvePartition, loadManifest, findService, fetchServiceDefinition, saveEstimate, extractInputFields } = require('./aws-client');
const ec2 = require('./ec2');

const REGIONS = {
  'us-east-1': 'US East (N. Virginia)', 'us-east-2': 'US East (Ohio)', 'us-west-1': 'US West (N. California)', 'us-west-2': 'US West (Oregon)',
  'af-south-1': 'Africa (Cape Town)', 'ap-east-1': 'Asia Pacific (Hong Kong)', 'ap-south-1': 'Asia Pacific (Mumbai)', 'ap-south-2': 'Asia Pacific (Hyderabad)',
  'ap-southeast-1': 'Asia Pacific (Singapore)', 'ap-southeast-2': 'Asia Pacific (Sydney)', 'ap-southeast-3': 'Asia Pacific (Jakarta)', 'ap-southeast-4': 'Asia Pacific (Melbourne)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)', 'ap-northeast-2': 'Asia Pacific (Seoul)', 'ap-northeast-3': 'Asia Pacific (Osaka)',
  'ca-central-1': 'Canada (Central)', 'ca-west-1': 'Canada West (Calgary)',
  'eu-central-1': 'Europe (Frankfurt)', 'eu-central-2': 'Europe (Zurich)', 'eu-west-1': 'Europe (Ireland)', 'eu-west-2': 'Europe (London)', 'eu-west-3': 'Europe (Paris)',
  'eu-south-1': 'Europe (Milan)', 'eu-south-2': 'Europe (Spain)', 'eu-north-1': 'Europe (Stockholm)',
  'il-central-1': 'Israel (Tel Aviv)', 'me-south-1': 'Middle East (Bahrain)', 'me-central-1': 'Middle East (UAE)', 'sa-east-1': 'South America (Sao Paulo)',
  'us-iso-east-1': 'US ISO East', 'us-iso-west-1': 'US ISO West', 'us-isob-east-1': 'US ISOB East (Ohio)',
};

function escapeXml(str) { return (str || '').replace(/[<>&]/g, ''); }

function packFields(config) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (k === 'region' || k === 'description' || v == null) continue;
    out[k] = typeof v === 'object' ? v : { value: String(v) };
  }
  return out;
}

function summarizeConfig(config) {
  return Object.entries(config)
    .filter(([k, v]) => k !== 'region' && k !== 'description' && v != null)
    .map(([k, v]) => `${k} (${v && typeof v === 'object' ? v.value : v})`)
    .join(', ');
}

class Estimate {
  constructor(name = 'My Estimate', partition = null) {
    this.id = crypto.randomUUID();
    this.name = name;
    this.partition = partition;
    this.services = {};
    this.groups = {};
    this._keys = new Set();
  }

  addService(compositeKey, config, { group } = {}) {
    if (this._keys.has(compositeKey) && config?.description) {
      compositeKey = `${compositeKey}:${config.description.replace(/\s+/g, '')}`;
    }
    this._keys.add(compositeKey);
    const bucket = group ? (this.groups[group] ??= { services: {} }).services : this.services;
    bucket[compositeKey] = config;
  }

  _detectPartition() {
    if (this.partition) return this.partition;
    const configs = [...Object.values(this.services), ...Object.values(this.groups).flatMap(g => Object.values(g.services))];
    for (const c of configs) { if (c.region) { const p = resolvePartition(c.region); if (p !== 'aws') return p; } }
    return 'aws';
  }

  _checkPartitionConsistency() {
    const configs = [...Object.values(this.services), ...Object.values(this.groups).flatMap(g => Object.values(g.services))];
    const parts = new Set();
    for (const c of configs) { if (c.region) parts.add(resolvePartition(c.region)); }
    if (parts.size > 1) throw new Error(`Mixed partitions not supported. Found: ${[...parts].join(', ')}`);
  }

  async serialize() {
    const partition = this._detectPartition();
    this._checkPartitionConsistency();
    const catalog = await loadManifest(partition);

    // Map sub-services to their parent selectors
    const parentMap = new Map();
    for (const [, svc] of catalog) {
      if (svc.subType === 'subServiceSelector' && Array.isArray(svc.templates)) {
        for (const child of svc.templates) parentMap.set(child, svc);
      }
    }

    const buildBlock = async (serviceMap) => {
      const block = {};
      const entries = Object.entries(serviceMap);
      // Pre-fetch schemas in parallel
      const uniqueKeys = new Set();
      for (const [ck] of entries) {
        const svcKey = ck.split(':')[0];
        const svc = findService(catalog, svcKey);
        if (!svc) continue;
        if (svc.subType === 'subService' && parentMap.has(svcKey)) {
          uniqueKeys.add(parentMap.get(svcKey).key);
          uniqueKeys.add(svc.key);
        } else {
          uniqueKeys.add(this._isCompute(svc) ? 'ec2Enhancement' : svc.key);
        }
      }
      await Promise.all([...uniqueKeys].map(k => fetchServiceDefinition(catalog, k, partition).catch(() => null)));

      for (const [ck, config] of entries) {
        const svcKey = ck.split(':')[0];
        const svc = findService(catalog, svcKey);
        if (!svc) continue;

        if (svc.subType === 'subService' && parentMap.has(svcKey)) {
          const parent = parentMap.get(svcKey);
          const parentDef = await fetchServiceDefinition(catalog, parent.key, partition);
          const childDef = await fetchServiceDefinition(catalog, svc.key, partition);
          const region = config.region || 'us-east-1';
          block[`${parent.key}-${crypto.randomUUID()}`] = {
            serviceCode: parentDef?.serviceCode || parent.key, region, estimateFor: parentDef?.templateId || 'template', description: null,
            subServices: [{ calculationComponents: packFields(config), serviceCode: childDef?.serviceCode || svc.key, region, estimateFor: this._resolveTemplate(childDef, config), version: childDef?.version || '0.0.1', description: escapeXml(config.description) || null }],
            serviceName: parent.name, regionName: REGIONS[region] || region, version: parentDef?.version || '0.0.1', configSummary: summarizeConfig(config),
          };
          continue;
        }
        block[`${this._serviceId(svc)}-${crypto.randomUUID()}`] = await this._serializeService(catalog, svc, config, partition);
      }
      return block;
    };

    const groups = {};
    for (const [name, data] of Object.entries(this.groups)) {
      const safe = escapeXml(name);
      groups[`${safe}-${crypto.randomUUID()}`] = { name: safe, services: await buildBlock(data.services), groups: {} };
    }

    const payload = {
      name: this.name, services: await buildBlock(this.services), groups,
      groupSubtotal: {}, support: {},
      metaData: { locale: 'en_US', currency: 'USD', createdOn: new Date().toISOString(), source: 'calculator-platform' },
    };
    if (partition !== 'aws') {
      payload.settings = { subTotalModifier: { type: 'VOLUME_DISCOUNT', value: 0, valuePercentage: 0, label: 'Discount' }, monthlyTimeFrame: 12, timeFrame: { length: 12, unit: 'month' }, awsPartition: PARTITIONS[partition].awsPartition };
    }
    return payload;
  }

  async export() {
    const payload = await this.serialize();
    const result = await saveEstimate(payload);
    const partition = this._detectPartition();
    return { estimateId: result.estimateId, shareableUrl: this._buildUrl(result.estimateId, partition) };
  }

  _buildUrl(key, partition) {
    const contract = PARTITIONS[partition]?.contract;
    return contract ? `https://calculator.aws/#/estimate?ctrct=${contract}&volume_discount=0&id=${key}` : `https://calculator.aws/#/estimate?id=${key}`;
  }

  _isCompute(svc) { return svc.key.toLowerCase() === 'ec2enhancement'; }
  _serviceId(svc) { return this._isCompute(svc) ? 'ec2Enhancement' : svc.key; }

  _resolveTemplate(def, config) {
    if (!def) return 'template';
    const templates = def.templates;
    if (!Array.isArray(templates) || !templates.length) return 'template';
    if (templates.length === 1) return templates[0].id;
    const configKeys = Object.keys(config).filter(k => k !== 'region' && k !== 'description');
    if (!configKeys.length) return templates[0].id;
    const fields = extractInputFields(def);
    const fieldMap = new Map();
    for (const f of fields) { if (f.templateId) fieldMap.set(f.id, f.templateId); }
    const scores = new Map();
    for (const id of configKeys) { const tpl = fieldMap.get(id); if (tpl) scores.set(tpl, (scores.get(tpl) || 0) + 1); }
    if (!scores.size) return templates[0].id;
    let best = templates[0].id, bestScore = -1;
    for (const tpl of templates) { const s = scores.get(tpl.id) || 0; if (s > bestScore) { bestScore = s; best = tpl.id; } }
    return best;
  }

  async _serializeService(catalog, svc, config, partition) {
    const region = config.region || 'us-east-1';
    const defKey = this._serviceId(svc);
    let version = '0.0.1', serviceCode = defKey, estimateFor = 'template';
    try {
      const def = await fetchServiceDefinition(catalog, defKey, partition);
      if (def) { version = def.version || version; serviceCode = def.serviceCode || serviceCode; estimateFor = this._resolveTemplate(def, config); }
    } catch (err) { console.error(`Schema fetch failed for ${defKey}: ${err.message}`); }
    return {
      serviceCode, region, estimateFor, description: escapeXml(config.description),
      serviceName: svc.name, regionName: REGIONS[region] || region, version,
      calculationComponents: this._isCompute(svc) ? ec2.transformConfig(config) : packFields(config),
      configSummary: summarizeConfig(config),
    };
  }
}

module.exports = Estimate;
module.exports.sanitize = escapeXml;
