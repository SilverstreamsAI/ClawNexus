# A2A Bridge: Making OpenClaw Instances Speak Google's Agent Protocol

**Excerpt**: ClawNexus automatically bridges OpenClaw instances to Google's A2A protocol, making them discoverable and interoperable with any A2A-compatible agent.

**Category**: Feature | **Tags**: clawnexus, a2a, google, agent-protocol

---

## What is A2A?

Google's Agent-to-Agent (A2A) protocol is an open standard for AI agents to discover and communicate with each other. It defines two things: **Agent Cards** (JSON metadata describing what an agent can do) and a **JSON-RPC interface** for exchanging tasks between agents.

An Agent Card lives at `/.well-known/agent-card.json` and declares the agent's name, capabilities, supported input/output modes, and available skills. When one agent wants to talk to another, it fetches the card, checks compatibility, and sends a JSON-RPC request to the agent's endpoint.

It's a common envelope format for agent communication. Some call it "the HTTP of AI agents" — HTTP tells you how to request a web page, A2A tells you how to request work from an agent. But like HTTP, the protocol alone doesn't solve all the surrounding problems.

## The gap A2A doesn't fill

A2A tells you HOW to talk to an agent. It does not tell you WHERE to find one.

There's no discovery mechanism in the spec. You need to already know the agent's URL to fetch its Agent Card. In practice, this means someone has to manually share URLs, maintain a list, or build a discovery layer on top.

There's also no capability verification. An Agent Card is self-reported metadata. An agent can claim it handles "code review," "data analysis," and "legal compliance" — there's nothing in the protocol to validate those claims. You're trusting the agent's own description.

And there's no trust scoring. If two agents both claim to do the same thing, A2A gives you no basis for choosing between them. No track record, no reputation, no verification.

These aren't flaws in A2A — they're outside its scope. ClawNexus fills these gaps.

## How ClawNexus bridges to A2A

The bridge works through five components that sit between the A2A protocol and OpenClaw's Gateway. Each handles a different part of the translation.

### Agent Card generation

When ClawNexus discovers an OpenClaw instance — via LocalProbe, CDP broadcast, mDNS, or active scan — it automatically generates an A2A-compliant Agent Card for that instance. The card is served at `/.well-known/agent-card.json` on the daemon's HTTP API (port 17890).

The card maps OpenClaw metadata to A2A fields. The instance's alias or auto-generated name becomes the card's `name`. The assistant name becomes the `description`. Capabilities and skills are populated from the instance's configuration. The `provider` field points back to ClawNexus.

No manual configuration. The instance gets discovered, the card gets generated.

### CardFetcher

The CardFetcher works in the other direction. It discovers Agent Cards from remote agents — whether they're other ClawNexus nodes or any A2A-compatible agent — and caches them locally. It listens for new instances appearing in the registry, fetches their cards, and stores the result. Cards are refreshed every five minutes to stay current.

This feeds into ClawNexus's registry. A remote A2A agent's capabilities become queryable alongside locally discovered OpenClaw instances — all entries with names, capabilities, and connection details.

### A2A Handler (JSON-RPC)

The `POST /a2a` endpoint on the daemon accepts standard A2A JSON-RPC requests. It supports `tasks/send` for submitting new tasks and `tasks/get` for checking task status.

When a task comes in, the handler validates the request, checks concurrency limits (default: 5 concurrent tasks), and routes it to the local OpenClaw instance via the Gateway WebSocket connection. The connection is persistent and shared across tasks — each task gets a unique session key for multiplexing.

The handler manages the full task lifecycle: `submitted` when received, `working` when sent to the Gateway, `completed` or `failed` when the Gateway responds. All state transitions follow the A2A task model.

### The adapter layer

The critical piece is translating between A2A's task model and OpenClaw's Gateway protocol. The handler converts inbound A2A text messages into OpenClaw `chat.send` calls with unique session keys. When OpenClaw responds, the handler extracts the assistant's reply, wraps it in an A2A message with `role: "agent"`, and returns it as the task result.

OpenClaw doesn't need to know A2A exists. The adapter handles translation in both directions.

### A2ATaskStore

Inbound tasks are persisted to `~/.clawnexus/a2a-tasks.json`. The store uses FIFO eviction (keeping the most recent 100 tasks), debounced writes to avoid disk thrash, and atomic file replacement to prevent corruption. Tasks can be queried after completion via `tasks/get`.

## The result

Any OpenClaw instance, once discovered by ClawNexus, automatically becomes A2A-compatible. An external A2A agent can:

1. Fetch the instance's Agent Card at `/.well-known/agent-card.json`
2. Send tasks via JSON-RPC to the `/a2a` endpoint
3. Get results back in standard A2A format

The OpenClaw instance requires zero changes. It keeps running as usual, bound to loopback, handling chat sessions. ClawNexus sits in front and speaks A2A on its behalf.

## Quick example

```bash
# Start ClawNexus — it discovers local OpenClaw and generates the Agent Card
clawnexus start

# View the auto-generated Agent Card
curl http://localhost:17890/.well-known/agent-card.json

# An external A2A agent can send a task
curl -X POST http://localhost:17890/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tasks/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"type": "text", "text": "Summarize the latest news"}]
      }
    },
    "id": 1
  }'
```

The response comes back as a standard A2A task object with status, artifacts, and history.

## Where this is heading

A2A defines the envelope format. ClawNexus provides the postal service: discovery, routing, naming, and (eventually) trust.

Think of it as ICANN plus Moody's for AI agents — naming and trust in one system. The `.claw` naming system handles identity. A planned capability verification and trust scoring layer will handle reputation.

Five supplementary protocols are on the roadmap: Service (capability registration), Negotiation (terms and pricing), Authorization (access control), Settlement (payment), and Reputation (track record). They extend A2A rather than replacing it.

The A2A bridge shipping today is the foundation. It makes every OpenClaw instance a first-class participant in the A2A ecosystem, with zero effort from the user.

## Links

- **GitHub**: [github.com/StratCraftsAI/ClawNexus](https://github.com/StratCraftsAI/ClawNexus)
- **npm**: [npmjs.com/package/clawnexus](https://www.npmjs.com/package/clawnexus)
- **A2A Spec**: [google.github.io/A2A](https://google.github.io/A2A)

---

*Built by [StratCraftsAI](https://github.com/StratCraftsAI). For questions or collaboration: contact@stratcraft.ai*
