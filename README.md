# aws-calculator-mcp

MCP server for creating [AWS Pricing Calculator](https://calculator.aws) estimates programmatically and getting shareable links — no browser automation needed.

Built for AI agents like [Kiro CLI](https://kiro.dev), Claude Desktop, Cursor, or any MCP-compatible client.

## What it does

Creates AWS Pricing Calculator estimates via a single API call and returns a shareable `calculator.aws` link that anyone can open — no AWS account required.

```
You: "Create an estimate with CloudFront, Lambda, and S3 in Mumbai"
  ↓
Agent calls create_estimate → POST to calculator.aws API
  ↓
Returns: https://calculator.aws/#/estimate?id=abc123...
```

One HTTP call. No browser. No auth. ~2 seconds.

## Tools

| Tool | Description |
|------|-------------|
| `search_services` | Search 158+ AWS services by keyword → returns `serviceCode` |
| `get_service_schema` | Get input fields for any service (including subServices) |
| `create_estimate` | Create estimate with services → returns shareable link |
| `load_estimate` | Load existing estimate from URL → returns full data |

## Setup

### Install

```bash
git clone https://github.com/Musheer360/aws-calculator-mcp.git
cd aws-calculator-mcp
npm install
```

### Configure with Kiro CLI

Add to `~/.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "aws-calculator": {
      "command": "node",
      "args": ["/path/to/aws-calculator-mcp/index.js"]
    }
  }
}
```

Or via CLI:

```bash
kiro-cli mcp add --name aws-calculator --command node --args /path/to/aws-calculator-mcp/index.js
```

### Configure with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "aws-calculator": {
      "command": "node",
      "args": ["/path/to/aws-calculator-mcp/index.js"]
    }
  }
}
```

## Usage Examples

### Create a simple estimate

```
Create an AWS pricing estimate called "My App" with:
- Amazon CloudFront in us-east-1, $200/month
- AWS Lambda in us-east-1, $15/month  
- Amazon S3 in us-east-1, $23/month
```

The agent will call `create_estimate` and return a shareable link.

### Load and inspect an existing estimate

```
Load this estimate: https://calculator.aws/#/estimate?id=abc123...
```

### Get service configuration fields

```
What input fields does Amazon EC2 have in the pricing calculator?
```

The agent will call `get_service_schema` with `serviceCode: "eC2Next"` and return all configurable fields.

## How it works

The server calls calculator.aws's internal REST APIs (no authentication required):

| Operation | Endpoint |
|-----------|----------|
| Save estimate | `POST https://dnd5zrqcec4or.cloudfront.net/Prod/v2/saveAs` |
| Load estimate | `GET https://d3knqfixx3sbls.cloudfront.net/{id}` |
| Service definitions | `GET https://d1qsjq9pzbk1k6.cloudfront.net/data/{serviceCode}/en_US.json` |
| Service manifest | `GET https://d1qsjq9pzbk1k6.cloudfront.net/manifest/en_US.json` |

For each service in your estimate, the server:
1. Fetches the service definition to get the correct version, schema, and default values
2. For services with subServices (like S3), fetches each subService's definition too
3. Builds properly structured `calculationComponents` from defaults merged with user-provided values
4. Resolves option labels to API values automatically (e.g., "S3 Standard" → `s3Standard`)
5. Includes proper unit information for frequency/fileSize fields
6. Assembles the full estimate JSON and POSTs it to the save API
7. Returns the shareable `calculator.aws` link

## Limitations

- **Internal APIs**: These are undocumented calculator.aws endpoints. They could change without notice.
- **No cost calculation**: The server stores whatever costs you provide. It doesn't compute prices from configuration — the AI agent needs to know the prices.
- **Estimate expiry**: Calculator.aws estimates expire after 1 year.
- **Service drill-down**: Estimate totals always display correctly. Individual service configuration views may show "Required inputs" for services with complex schemas unless you provide explicit `calculationComponents`. Use `get_service_schema` to see available fields and their option values.

## License

MIT
