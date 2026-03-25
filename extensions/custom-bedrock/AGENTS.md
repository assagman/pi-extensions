# Custom Bedrock Extension — Agent Instructions

## Overview

Routes AI requests through a custom Bedrock-compatible gateway that speaks the AWS Bedrock Converse protocol but authenticates via Bearer token instead of AWS SigV4.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry, provider registration, streaming logic |

## Architecture

```
pi → custom-bedrock provider → ConverseStream API → custom gateway
```

1. Extension registers `custom-bedrock` provider with Pi
2. Requests are routed through AWS SDK's `ConverseStreamCommand`
3. SigV4 signing is disabled; Bearer token auth is injected via middleware
4. Streaming responses are converted to Pi's `AssistantMessageEventStream`

## Configuration

Environment variables:
- `CORP_BEDROCK_URL` — Gateway base URL
- `CORP_BEDROCK_TOKEN` — Bearer token for the gateway

## Features

- Full Bedrock Converse protocol support (text, images, tools, thinking)
- Custom header injection via middleware
- Extended thinking / reasoning budget support
- Proper error handling for all Bedrock error types

## Constraints

- Requires `@aws-sdk/client-bedrock-runtime` (heavy dependency)
- Gateway must implement Bedrock Converse protocol
- SigV4 signing is completely bypassed
