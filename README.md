# aws-calculator-mcp

MCP server for creating [AWS Pricing Calculator](https://calculator.aws) estimates programmatically and getting shareable links — no browser automation needed.

Built for AI agents like [Kiro CLI](https://kiro.dev), Claude Desktop, Cursor, or any MCP-compatible client.

## What it does

Creates AWS Pricing Calculator estimates via a single API call and returns a shareable, **editable** `calculator.aws` link that anyone can open — no AWS account required.

The MCP fetches real-time AWS pricing data and calculates costs automatically using the same pricing formulas as the official AWS calculator — no manual price lookups needed.

```
You: "Create an estimate with Lambda (10M requests, 200ms, 512MB) and S3 (100GB) in us-east-1"
  ↓
Agent calls configure_service → fetches pricing, calculates costs
Agent calls create_estimate → POST to calculator.aws API
  ↓
Returns: https://calculator.aws/#/estimate?id=abc123...
  Monthly: $14.19 (Lambda: $11.80 + S3: $2.39)
```

One HTTP call. No browser. No auth. Real-time pricing. ~2 seconds.

## Tools

| Tool | Description |
|------|-------------|
| `search_services` | Search 400+ AWS services by keyword → returns `serviceCode` |
| `get_service_schema` | Get input fields for any service (including subServices) |
| `configure_service` | Configure a service with specific parameters → auto-calculates cost using real-time AWS pricing |
| `create_estimate` | Create estimate with services → returns shareable, editable link (auto-calculates costs) |
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

### Recommended workflow (like the AWS Calculator website)

The recommended workflow mirrors how the AWS Calculator website works — add services one at a time, configure them, get the calculated price, then create the estimate:

```
1. "Search for Lambda" → search_services
2. "Configure Lambda with 10M requests, 200ms duration, 512MB memory" → configure_service
   → Returns: $11.80/month with calculationComponents
3. "Also add S3 Standard with 100GB storage" → configure_service
   → Returns: $2.39/month with calculationComponents
4. "Create the estimate" → create_estimate
   → Returns shareable link with auto-calculated costs
```

### Create an estimate with auto-calculated costs

```
Create an AWS pricing estimate called "My App" with:
- AWS Lambda in us-east-1: 10M requests/month, 200ms duration, 512MB memory
- S3 Standard in us-east-1: 100GB storage, 10K PUT requests, 100K GET requests
```

The agent will call `configure_service` for each service to get the calculated costs, then `create_estimate` to save and get a shareable link. **Costs are calculated automatically using real-time AWS pricing data.**

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
| Pricing data | `GET https://calculator.aws/pricing/2.0/meteredUnitMaps/{service}/USD/current/{service}.json` |

### Pricing calculation engine

For each service, the server:
1. Fetches the service definition to get the schema, pricing formulas, and default values
2. Fetches real-time pricing data from the AWS pricing API
3. Builds `calculationComponents` from defaults merged with user-provided values
4. Resolves pricing components (metered unit lookups, tiered pricing, single price points)
5. Executes the `mathsSection` formulas — the same calculation logic used by the AWS Calculator frontend
6. Returns the calculated monthly and upfront costs

The calculation engine supports:
- **Basic math**: multiplication, addition, subtraction, division
- **Tiered pricing**: automatic tier boundary calculations (e.g., S3 storage tiers)
- **Free tier deductions**: proper free tier handling (e.g., Lambda free 1M requests + 400K GB-seconds)
- **Unit conversions**: MB↔GB↔TB for storage, per-second↔per-month for frequencies
- **Conditional pricing**: `displayIf` conditions for feature-specific pricing (e.g., Lambda ARM vs x86)
- **Savings plans / pricing strategies**: EC2 pricing model selection (Instance Savings Plans, Compute Savings Plans, Reserved, On-Demand)

### Editability

Estimates are fully editable when opened in the browser. The server includes:
- `templateId`: tells the calculator which configuration form to show (e.g., "lambdaWithFreeTier", "CDN", "quickEstimate")
- `calculationComponents`: all input field values that populate the edit form
- `version`: matching service definition version to prevent stale data warnings

Services with multiple templates (e.g., Lambda "Include Free Tier" vs "Without Free Tier", CloudFront "Flat Rate" vs "Pay as you go") default to the first template. Use the `templateId` parameter in `create_estimate` to select a specific template.

## Limitations

- **Internal APIs**: These are undocumented calculator.aws endpoints. They could change without notice.
- **Pricing accuracy**: The calculation engine handles most common pricing patterns (basic math, tiered pricing, single price points). Some complex service-specific pricing models may not calculate perfectly — in those cases, costs default to $0 and can be manually specified.
- **Estimate expiry**: Calculator.aws estimates expire after 1 year.

## License

MIT
