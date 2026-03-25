# Custom Bedrock Extension — Agent Instructions

## Overview

Registers one Pi provider per configured custom Bedrock profile. Each profile points at its own Bedrock-compatible gateway endpoint, auth source, headers, and optional model overrides.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry, session startup hook, status command |
| `src/config.ts` | Config discovery, parsing, validation, value resolution |
| `src/registration.ts` | Provider registration / reload helpers |
| `src/stream.ts` | Bedrock Converse streaming implementation |
| `src/*.test.ts` | Unit tests for config + registration logic |
| `docs/setup.md` | User setup documentation |
| `models.example.json` | Example config file |

## Architecture

```text
config file -> resolved profiles -> custom-bedrock-<profile> providers -> streamCustomBedrock()
```

1. On `session_start`, the extension loads config from project or user scope
2. Each valid profile becomes its own provider (for example `custom-bedrock-prod`)
3. Requests are routed through AWS SDK `ConverseStreamCommand`
4. SigV4 signing is bypassed and auth headers are injected manually
5. `/custom-bedrock-status` shows current load/registration state

## Config locations

Checked in this order:
- `.pi/custom-bedrock/models.json`
- `~/.pi/agent/custom-bedrock/models.json`

## Value types

For `baseUrl`, `apiKey`, and header values:
- literal string
- `{ "env": "VAR_NAME" }`
- `{ "command": "shell command" }`

## Model behavior

- Built-in defaults: latest global Claude 4.6 profiles
- `defaults.models` can override the shared model set
- `profiles.<name>.models` replaces the defaults for that profile
- Display names get a profile suffix like `[prod]`

## Constraints

- Requires `@aws-sdk/client-bedrock-runtime`
- Gateway must implement Bedrock Converse streaming semantics
- Config errors should skip only the broken profile, not all profiles
