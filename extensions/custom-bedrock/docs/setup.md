# custom-bedrock setup

## Config locations

The extension reads the first config file it finds in this order:

1. `.pi/custom-bedrock/models.json` (project-local)
2. `~/.pi/agent/custom-bedrock/models.json` (user-global)

If no config file exists, the extension registers no providers.

## Value types

`baseUrl`, `apiKey`, and header values support three forms:

### Literal string

```json
"baseUrl": "https://gateway.example.com/bedrock"
```

### Environment variable

```json
"apiKey": { "env": "BEDROCK_PROD_TOKEN" }
```

### Shell command

```json
"apiKey": { "command": "op read op://AI/bedrock-prod/token" }
```

## Minimal config

```json
{
  "profiles": {
    "prod": {
      "baseUrl": { "env": "BEDROCK_PROD_URL" },
      "apiKey": { "env": "BEDROCK_PROD_TOKEN" }
    }
  }
}
```

This automatically exposes the built-in latest Claude models:

- `global.anthropic.claude-opus-4-6-v1`
- `global.anthropic.claude-sonnet-4-6`

## Profile behavior

Each profile becomes its own Pi provider:

- `custom-bedrock-prod`
- `custom-bedrock-staging`
- etc.

Model display names are suffixed with the profile name, e.g.:

- `Claude Sonnet 4.6 [prod]`
- `Claude Opus 4.6 [staging]`

## Status command

Use:

```text
/custom-bedrock-status
```

This shows:
- active config path
- profile load status
- registered providers
- config errors
