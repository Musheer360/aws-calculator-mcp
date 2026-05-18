const { describe, it } = require('node:test');
const assert = require('node:assert');

const { extractInputFields, searchServices, resolvePartition, parseDoubleEncodedResponse, estimateToMarkdown } = require('../lib/aws-client');
const { transformConfig } = require('../lib/ec2');
const EstimateBuilder = require('../lib/estimate-builder');
const { sanitize } = EstimateBuilder;

describe('resolvePartition', () => {
  it('returns aws for standard regions', () => {
    assert.strictEqual(resolvePartition('us-east-1'), 'aws');
    assert.strictEqual(resolvePartition('eu-west-1'), 'aws');
  });
  it('returns aws-iso for iso regions', () => {
    assert.strictEqual(resolvePartition('us-iso-east-1'), 'aws-iso');
  });
  it('returns aws-iso-b for isob regions', () => {
    assert.strictEqual(resolvePartition('us-isob-east-1'), 'aws-iso-b');
  });
  it('returns aws for null/undefined', () => {
    assert.strictEqual(resolvePartition(null), 'aws');
    assert.strictEqual(resolvePartition(undefined), 'aws');
  });
});

describe('searchServices', () => {
  const manifest = new Map([
    ['aWSLambda', { key: 'aWSLambda', name: 'AWS Lambda', isActive: 'true', searchKeywords: ['serverless'] }],
    ['amazonS3', { key: 'amazonS3', name: 'Amazon S3', isActive: 'true', subType: 'subServiceSelector', templates: ['amazonS3Standard'] }],
    ['amazonS3Standard', { key: 'amazonS3Standard', name: 'S3 Standard', isActive: 'true' }],
  ]);

  it('returns empty array for empty query', () => {
    assert.deepStrictEqual(searchServices(manifest, ''), []);
    assert.deepStrictEqual(searchServices(manifest, '  '), []);
  });
  it('finds by name', () => {
    const r = searchServices(manifest, 'Lambda');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, 'aWSLambda');
  });
  it('skips subServiceSelector entries', () => {
    const r = searchServices(manifest, 'S3');
    assert.ok(!r.some(s => s.key === 'amazonS3'));
    assert.ok(r.some(s => s.key === 'amazonS3Standard'));
  });
  it('handles comma-separated multi-search', () => {
    const r = searchServices(manifest, 'Lambda, S3');
    assert.ok('Lambda' in r || 'lambda' in r);
  });
  it('finds by searchKeywords', () => {
    const r = searchServices(manifest, 'serverless');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].key, 'aWSLambda');
  });
});

describe('extractInputFields', () => {
  it('extracts fields from a simple definition', () => {
    const def = { templates: [{ id: 'tpl1', cards: [{ inputSection: { components: [{ id: 'field1', type: 'numericInput', label: 'Count' }] } }] }] };
    const fields = extractInputFields(def);
    assert.strictEqual(fields.length, 1);
    assert.strictEqual(fields[0].id, 'field1');
    assert.strictEqual(fields[0].templateId, 'tpl1');
  });
  it('handles circular references without crashing', () => {
    const obj = { id: 'x', type: 'numericInput' };
    obj.self = obj; // circular
    const def = { templates: [{ id: 't', components: [obj] }] };
    assert.doesNotThrow(() => extractInputFields(def));
  });
  it('deduplicates fields across templates', () => {
    const def = { templates: [
      { id: 't1', cards: [{ inputSection: { components: [{ id: 'f1', type: 'numericInput' }] } }] },
      { id: 't2', cards: [{ inputSection: { components: [{ id: 'f1', type: 'numericInput' }] } }] },
    ] };
    const fields = extractInputFields(def);
    assert.strictEqual(fields.length, 1);
  });
});

describe('EC2 transformConfig', () => {
  it('transforms basic on-demand config', () => {
    const r = transformConfig({ instanceType: 't3.micro', selectedOS: 'linux', pricingStrategy: 'ondemand' });
    assert.strictEqual(r.instanceType.value, 't3.micro');
    assert.strictEqual(r.selectedOS.value, 'linux');
    assert.strictEqual(r.pricingStrategy.value.selectedOption, 'on-demand');
  });
  it('parses shorthand pricing strategy', () => {
    const r = transformConfig({ instanceType: 'm5.large', pricingStrategy: 'computeSavings3yrAllUpfront' });
    assert.strictEqual(r.pricingStrategy.value.selectedOption, 'compute-savings');
    assert.strictEqual(r.pricingStrategy.value.term, '3 Year');
    assert.strictEqual(r.pricingStrategy.value.upfrontPayment, 'All');
  });
  it('infers gp3 storage type from gp3Iops', () => {
    const r = transformConfig({ instanceType: 't3.micro', gp3Iops: '5000' });
    assert.strictEqual(r.storageType.value, 'Storage General Purpose gp3 GB Mo');
    assert.strictEqual(r.gp3Iops.value, '5000');
  });
  it('maps storage type shorthands', () => {
    const r = transformConfig({ instanceType: 't3.micro', storageType: 'io2', storageAmountIo2: '100' });
    assert.strictEqual(r.storageType.value, 'Storage Provisioned IOPS io2 GB month');
  });
  it('sets quantity via workload.data', () => {
    const r = transformConfig({ instanceType: 't3.micro', quantity: '4' });
    assert.strictEqual(r.workload.value.data, '4');
  });
  it('converts reserved to instanceSavings for shared tenancy', () => {
    const r = transformConfig({ instanceType: 't3.micro', pricingStrategy: 'reserved1yrNoUpfront' });
    assert.strictEqual(r.pricingStrategy.value.selectedOption, 'instance-savings');
  });
});

describe('sanitize', () => {
  it('removes < > &', () => {
    assert.strictEqual(sanitize('hello <world> & "foo"'), 'hello world  "foo"');
  });
  it('handles null/undefined', () => {
    assert.strictEqual(sanitize(null), '');
    assert.strictEqual(sanitize(undefined), '');
  });
});

describe('parseDoubleEncodedResponse', () => {
  it('parses valid response', () => {
    const raw = JSON.stringify({ statusCode: 201, body: JSON.stringify({ savedKey: 'abc123' }) });
    const body = parseDoubleEncodedResponse(raw);
    assert.strictEqual(body.savedKey, 'abc123');
  });
  it('throws on invalid JSON', () => {
    assert.throws(() => parseDoubleEncodedResponse('not json'), /invalid JSON/);
  });
  it('throws on missing savedKey', () => {
    const raw = JSON.stringify({ body: JSON.stringify({ error: 'nope' }) });
    assert.throws(() => parseDoubleEncodedResponse(raw), /savedKey/);
  });
});

describe('estimateToMarkdown', () => {
  it('renders basic estimate', () => {
    const data = { name: 'Test', totalCost: { monthly: 100.5, upfront: 0 }, services: { s1: { serviceName: 'Lambda', regionName: 'US East', serviceCost: { monthly: 100.5 } } } };
    const md = estimateToMarkdown(data);
    assert.ok(md.includes('# Test'));
    assert.ok(md.includes('$100.50'));
    assert.ok(md.includes('**Lambda**'));
  });
});

describe('EstimateBuilder', () => {
  it('creates with UUID and name', () => {
    const eb = new EstimateBuilder('My Est');
    assert.ok(eb.id.match(/^[0-9a-f-]+$/));
    assert.strictEqual(eb.name, 'My Est');
  });
  it('addService stores in services or groups', () => {
    const eb = new EstimateBuilder();
    eb.addService('svc1', { region: 'us-east-1' });
    eb.addService('svc2', { region: 'us-east-1' }, { group: 'G1' });
    assert.ok('svc1' in eb.services);
    assert.ok('svc2' in eb.groups.G1.services);
  });
  it('deduplicates keys using description', () => {
    const eb = new EstimateBuilder();
    eb.addService('svc1', { region: 'us-east-1', description: 'First' });
    eb.addService('svc1', { region: 'us-east-1', description: 'Second' });
    assert.strictEqual(Object.keys(eb.services).length, 2);
  });
  it('_resolveTemplate returns template for null def', () => {
    const eb = new EstimateBuilder();
    assert.strictEqual(eb._resolveTemplate(null, {}), 'template');
  });
  it('_checkPartitionConsistency throws on mixed partitions', () => {
    const eb = new EstimateBuilder();
    eb.addService('s1', { region: 'us-east-1' });
    eb.addService('s2', { region: 'us-iso-east-1' });
    assert.throws(() => eb._checkPartitionConsistency(), /Mixed partitions/);
  });
});
