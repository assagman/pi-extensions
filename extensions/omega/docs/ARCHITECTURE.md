# Omega Architecture

## Module Structure

```
src/
├── index.ts     # Extension entry — command, step collection UI, events
├── loop.ts      # Step execution loop + AgentEndAwaiter
└── types.ts     # OmegaState, factory
```

## Execution Model

```
for rep in 1..totalRepetitions:
  for step in steps:
    sendUserMessage(stepPrompt)
    await agentEnd
    compact(minimalInstructions)
```

## Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `AgentEndAwaiter` | loop.ts | Race-free completion detection via agent_end event |
| `compactAndSettle` | loop.ts | Compact + wait for session reload |
| `stepPrompt` | loop.ts | Wraps step text with loop position context |
| Step collection UI | index.ts | Editor (one step per line) + repetition selector |
| Context filter | index.ts | Strips stale omega messages from LLM context |
| State persistence | index.ts | appendEntry for resume support |

## Why AgentEndAwaiter?

`waitForIdle()` has a race condition: if called immediately after `sendUserMessage()`,
the agent may not have entered "processing" state yet, so `waitForIdle` returns instantly.

`AgentEndAwaiter` solves this by creating a promise BEFORE the message is sent.
The promise resolves only when `pi.on("agent_end")` fires — guaranteed correct timing.
