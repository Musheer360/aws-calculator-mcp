# aws-calculator-mcp

[Model Context Protocol](https://modelcontextprotocol.io) server for [AWS Pricing Calculator](https://calculator.aws). Creates estimates programmatically, exports shareable links, and retrieves calculated costs via headless browser.

Covers all 436 services across 72 regions. No AWS credentials required.

## Install

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

Place this in your MCP client's config file:

| Client | Config location |
|--------|----------------|
| Kiro | `~/.kiro/settings/mcp.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` |

Alternatively, clone and point to the local path:

```bash
git clone https://github.com/Musheer360/aws-calculator-mcp.git
cd aws-calculator-mcp && npm install
```

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

> **Note:** Claude.ai web connectors require a remote HTTP URL. This server uses stdio transport and is not directly compatible with Claude.ai's custom connector feature.

## Tools

| Tool | Description |
|------|-------------|
| `search_services` | Search the service catalog by keyword (comma-separated). |
| `get_service_fields` | Get field IDs, types, labels, and valid options for a service. Suggests corrections for invalid keys. |
| `create_estimate` | Create an empty estimate. |
| `add_service` | Add services with config. Validates field names with typo suggestions. Warns on missing critical fields. |
| `update_service` | Modify a service's config in-place without rebuilding the estimate. |
| `export_estimate` | Save to calculator.aws, returns a shareable URL. |
| `refresh_estimate` | Opens the estimate in headless Chrome, triggers recalculation, returns actual costs. |
| `generate_report` | Navigates into each group for per-service costs, merges with config, outputs CSV or Markdown. |
| `import_estimate` | Download an existing estimate by URL or ID (JSON or Markdown). |
| `list_estimates` | List in-memory estimates. |
| `delete_estimate` | Remove an estimate. |
| `get_server_info` | Server version and capabilities. |

### Typical workflow

```
search_services → get_service_fields → create_estimate → add_service → export_estimate → refresh_estimate
```

## How it works

The MCP does not calculate prices. It packages service configurations into the payload format expected by calculator.aws's save API, then uses headless Chrome to retrieve the costs that calculator.aws computes client-side.

1. Service catalog and field schemas are fetched from AWS's public CDN (same source as calculator.aws).
2. Configurations are serialized and POSTed to the save API — returns an estimate ID and shareable URL.
3. `refresh_estimate` opens the URL in Chrome, clicks "Update estimate", and scrapes the rendered costs.

Accuracy is identical to calculator.aws because it *is* calculator.aws doing the calculation.

## Service coverage

All services available on calculator.aws are supported, including:

- EC2 (On-Demand, Savings Plans, Reserved Instances, dedicated tenancy)
- RDS (all engines, Multi-AZ, Reserved)
- Lambda, S3, CloudFront, DynamoDB, ECS, EKS
- Bedrock (all model providers: Anthropic, Meta, Mistral, Cohere, etc.)
- VPC, ELB, Route 53, CloudWatch, WAF, GuardDuty
- All other services in the calculator catalog

Sub-services (e.g. `applicationLoadBalancer` under `elasticLoadBalancing`) are auto-resolved when using the `instance` parameter.

## EC2 configuration

EC2 uses a shorthand format. Do not call `get_service_fields` for it.

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

Supported pricing strategies: `ondemand`, `computeSavings1yrNoUpfront`, `computeSavings3yrAllUpfront`, `instanceSavings1yrPartialUpfront`, etc.

## Partitions

| Partition | Regions |
|-----------|---------|
| `aws` (default) | All commercial regions |
| `aws-iso` | us-iso-east-1, us-iso-west-1 |
| `aws-iso-b` | us-isob-east-1 |

## Requirements

- Node.js ≥ 18
- Chrome/Chromium (optional — only for `refresh_estimate` and `generate_report`)

To install a bundled Chromium: `npx puppeteer browsers install chrome`

## Troubleshooting

| Issue | Resolution |
|-------|-----------|
| MCP fails to load | Verify Node.js ≥ 18. Use absolute path for local installs. |
| "Cannot find module" | Run `npm install` in the project directory. |
| "No Chrome/Chromium found" | Install Chrome or run `npx puppeteer browsers install chrome`. |
| First call slow (~2s) | Initial catalog fetch from CDN. Cached for subsequent calls. |
| `refresh_estimate` slow (~20s) | Expected — launches a browser and waits for page render. |

## Architecture

```
mcp-server.js              12 MCP tools, input validation, routing
lib/aws-client.js          CalculatorAPI class — catalog, schemas, save, download
lib/estimate-builder.js    Estimate class — incremental building, serialization, export
lib/ec2.js                 EC2 config transformation
lib/browser.js             Headless Chrome — cost retrieval, group navigation
```

## License

MIT
