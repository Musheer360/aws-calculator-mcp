# aws-calculator-mcp

MCP server that creates AWS Pricing Calculator estimates and returns **actual AWS-calculated costs** — not approximations.

Works with any MCP client: [Kiro](https://kiro.dev), Claude Desktop, Cursor, VS Code, Windsurf, or anything that speaks [MCP](https://modelcontextprotocol.io).

## What makes this different

| Feature | This MCP | Others |
|---------|----------|--------|
| **Real costs** | Opens calculator.aws in headless Chrome, gets actual per-service pricing | Approximate/local calculations |
| **Per-service breakdown** | Navigates into each group, scrapes individual service costs | Group totals only |
| **Update in place** | `update_service` modifies one field without recreating the estimate | Delete and rebuild |
| **Sub-service resolution** | `elasticLoadBalancing` + `applicationLoadBalancer` auto-resolves | Manual lookup required |
| **Typo detection** | Invalid field IDs return suggestions: `"storagAmount" → did you mean "storageAmount"?` | Silent failures |
| **Full reports** | CSV/Markdown with MRR, ARR, per-service costs + all configured attributes | Just a URL |

## One-Click Install

Just add this to your MCP client config. No cloning, no setup, no build step:

```json
{
  "mcpServers": {
    "aws-calculator": {
      "command": "npx",
      "args": ["-y", "aws-calculator-mcp@latest"]
    }
  }
}
```

That's it. `npx` downloads and runs it automatically.

> If the npm package isn't published yet, use the GitHub URL directly:
> ```json
> "args": ["-y", "github:Musheer360/aws-calculator-mcp"]
> ```

### Where to put this config

| Client | Config file |
|--------|------------|
| **Kiro CLI** | `~/.kiro/settings/mcp.json` |
| **Claude Desktop (macOS)** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Claude Desktop (Windows)** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Cursor** | `.cursor/mcp.json` in your project |
| **VS Code** | `.vscode/mcp.json` in your project |

### Alternative: Clone and run locally

```bash
git clone https://github.com/Musheer360/aws-calculator-mcp.git
cd aws-calculator-mcp
npm install
```

Then point your config to the absolute path:

```json
{
  "mcpServers": {
    "aws-calculator": {
      "command": "node",
      "args": ["/absolute/path/to/aws-calculator-mcp/mcp-server.js"]
    }
  }
}
```

### Verify it works

```bash
npx aws-calculator-mcp <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

You should see a JSON response with `serverInfo`.

### Chrome (optional)

`refresh_estimate` and `generate_report` need Chrome. Three options:

1. **System Chrome** — if Chrome/Chromium is installed, it's auto-detected.
2. **Bundled** — run `npx puppeteer browsers install chrome` to download Chromium.
3. **Skip it** — the other 10 tools work fine without Chrome.

No AWS credentials needed. No API keys. No account required.

## Tools (12)

### Core Workflow

```
search_services → get_service_fields → create_estimate → add_service → export_estimate → refresh_estimate
```

| Tool | What it does |
|------|-------------|
| `search_services` | Find services by keyword. Comma-separated multi-search. |
| `get_service_fields` | Get field IDs, types, valid options for any service. |
| `create_estimate` | Create an empty estimate. Returns an ID. |
| `add_service` | Add configured services to an estimate. Validates all field IDs. |
| `update_service` | Modify a service's config in-place. No rebuild needed. |
| `export_estimate` | Push to calculator.aws. Returns a shareable URL. |
| `refresh_estimate` | **Headless Chrome** — opens the URL, clicks "Update estimate", returns real costs. |
| `generate_report` | Full breakdown: navigates into each group, gets per-service costs, merges with config, outputs CSV or Markdown. |

### Import & Management

| Tool | What it does |
|------|-------------|
| `import_estimate` | Download any estimate by URL or ID. JSON or Markdown output. |
| `list_estimates` | List all in-memory estimates. |
| `delete_estimate` | Remove an estimate from memory. |
| `get_server_info` | Version, capabilities, partition support. |

## Example

**Prompt:**
> Create an estimate for a production web app in us-west-2: 2x c5.xlarge EC2 with Savings Plan, Lambda at 20M requests, S3 500GB, CloudFront 1TB.

**What happens:**

```
search_services("Lambda, S3, CloudFront")     → service keys
get_service_fields("aWSLambda, amazonS3...")   → field IDs + valid values
create_estimate("Production Stack")            → estimate_id
add_service(estimate_id, [...4 services...])   → ✓ added, 4 total
export_estimate(estimate_id)                   → https://calculator.aws/#/estimate?id=...
refresh_estimate(url)                          → $333.92/mo (actual AWS-calculated)
generate_report(url, "markdown")               → full breakdown with per-service costs
```

**Output:**

```
| Service | Monthly | Annual |
|---------|---------|--------|
| Amazon EC2 (2x c5.xlarge, Savings Plan) | $148.20 | $1,778.40 |
| AWS Lambda (20M req, 256MB, 500ms) | $78.18 | $938.16 |
| Amazon S3 Standard (500GB) | $14.03 | $168.36 |
| Amazon CloudFront (1TB) | $93.51 | $1,122.12 |
| **Total** | **$333.92** | **$4,007.04** |
```

The link is editable — anyone can open it and modify the configuration on calculator.aws.

## EC2 Shorthand

EC2 uses a special config format (don't call `get_service_fields` for it):

```json
{
  "service": "ec2Enhancement",
  "config": {
    "region": "us-west-2",
    "instanceType": "c5.xlarge",
    "selectedOS": "linux",
    "tenancy": "shared",
    "pricingStrategy": "computeSavings1yrNoUpfront",
    "quantity": "2",
    "storageType": "gp3",
    "storageAmount": {"value": "50", "unit": "gb|NA"}
  }
}
```

Pricing strategies: `ondemand`, `computeSavings1yrNoUpfront`, `computeSavings3yrAllUpfront`, `instanceSavings1yrPartialUpfront`, etc.

## Sub-Services

Services like ELB, VPC, and Backup have sub-services. Use them directly:

```json
{"service": "applicationLoadBalancer"}
{"service": "networkAddressTranslationNatGatewayVpc"}
{"service": "ebsBackup"}
```

Or pass the parent with `instance` — it auto-resolves:

```json
{"service": "elasticLoadBalancing", "instance": "applicationLoadBalancer"}
```

## Iterating on Costs

Need to hit a specific budget? Don't rebuild — update in place:

```
add_service(...)           → build the estimate
export + refresh           → see actual costs ($575)
update_service(rds, {"storageAmount": {"value": "200", "unit": "gb|NA"}})
export + refresh           → $589.86 ✓
```

## Partitions

Supports all AWS partitions:

| Partition | Regions |
|-----------|---------|
| `aws` (default) | All commercial regions |
| `aws-iso` | us-iso-east-1, us-iso-west-1 |
| `aws-iso-b` | us-isob-east-1 |

## Requirements

- **Node.js** ≥ 18 — check with `node --version`
- **npm** — comes with Node.js
- **Chrome/Chromium** (optional) — only for `refresh_estimate` and `generate_report`. Run `npm install puppeteer` to auto-download, or use system Chrome.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| MCP fails to load | Check `node --version` is ≥ 18. Use absolute path if running locally. |
| "Cannot find module" | Run `npm install` in the project directory. |
| "No Chrome/Chromium found" | Run `npx puppeteer browsers install chrome` or install Chrome on your system. |
| First call is slow | Normal — fetches the AWS service catalog (~2s). Cached after that. |
| `refresh_estimate` takes 20s+ | Normal — opens a real browser, waits for page render. |

## Architecture

```
mcp-server.js              → 12 MCP tools, validation, routing
lib/aws-client.js          → CalculatorAPI class: catalog, schemas, persist, download
lib/estimate-builder.js    → Estimate class: incremental building, serialization, export
lib/ec2.js                 → EC2 config transformation (agent-friendly → calculator format)
lib/browser.js             → Headless Chrome: refresh costs, navigate groups, scrape tables
```

## License

MIT
