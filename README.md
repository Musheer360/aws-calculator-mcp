# aws-calculator-mcp

[![npm version](https://img.shields.io/npm/v/aws-calculator-mcp)](https://www.npmjs.com/package/aws-calculator-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

MCP server for [AWS Pricing Calculator](https://calculator.aws). Create cost estimates through natural language, get shareable links, retrieve actual AWS-calculated costs.

- 436 services, 72 regions
- Real pricing via headless Chrome (not approximations)
- Savings Plans, Reserved Instances, all pricing models
- No AWS credentials required

## Install

Add to your MCP client config:

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

| Client | Config file |
|--------|------------|
| Kiro | `~/.kiro/settings/mcp.json` |
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Cursor | `.cursor/mcp.json` |
| VS Code | `.vscode/mcp.json` |

Requires Node.js ≥ 18. Chrome optional (only for cost retrieval).

## What it does

You ask your AI assistant to estimate AWS costs. The MCP handles the rest:

1. Searches the AWS service catalog
2. Looks up valid configuration fields
3. Builds the estimate incrementally
4. Exports to calculator.aws (shareable link)
5. Opens the link in headless Chrome to get actual calculated costs

The pricing is identical to calculator.aws because it *is* calculator.aws doing the math.

## Tools

| Tool | Purpose |
|------|---------|
| `search_services` | Find services by keyword |
| `get_service_fields` | Get valid config fields for a service |
| `create_estimate` | Start a new estimate |
| `add_service` | Add configured services |
| `update_service` | Modify a service in-place |
| `export_estimate` | Get a shareable calculator.aws URL |
| `refresh_estimate` | Get actual costs via headless Chrome |
| `generate_report` | Per-service cost breakdown (CSV/Markdown) |
| `import_estimate` | Download an existing estimate |

## Example

> "Estimate a production stack in us-west-2: 2x c5.xlarge EC2 with Savings Plan, Lambda at 20M requests, S3 500GB, CloudFront 1TB"

→ Returns a calculator.aws link + $333.92/mo breakdown by service.

## How it works

```
Your prompt → Agent configures services → MCP packages payload → calculator.aws saves it
                                                                → Chrome opens it → scrapes real costs
```

No local price calculations. No hardcoded rates. The AWS calculator frontend computes everything.

## Requirements

- **Node.js ≥ 18**
- **Chrome** (optional) — for `refresh_estimate` and `generate_report`. Install with `npx puppeteer browsers install chrome` or use system Chrome.

## License

MIT
