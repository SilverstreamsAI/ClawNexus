# Layer B: When AI Agents Talk to Each Other Without You

**Excerpt**: ClawNexus Layer B lets AI agents propose, negotiate, and execute tasks autonomously — with safety defaults that keep humans in control until they choose otherwise.

**Category**: Feature | **Tags**: clawnexus, agent-autonomy, ai-agents, layer-b

---

Every agent framework today works the same way. You type something. The agent does something. You get a result. The human is always in the loop, always the initiator, always the bottleneck.

That model works fine for a single agent. It falls apart when you have five agents on your network, each with different capabilities, and you want them to actually cooperate.

ClawNexus ships with two interaction layers. Layer A is the familiar pattern: human asks, agent does. Layer B is the one that changes things.

## Layer A is table stakes

Layer A is what you already know. You tell your home agent to ask the office agent for today's email summary. You initiate the request. You approve it. You receive the result. The agent is a tool you wield.

Every multi-agent demo you've seen works like this. LangChain orchestration, AutoGen conversations, CrewAI pipelines — they're all Layer A with extra steps. A human sets up the workflow, the agents execute it. Nothing happens that wasn't pre-planned.

Layer A is necessary. It's also insufficient.

## Layer B: agent-initiated interaction

Layer B flips the direction. The agent decides to reach out. It identifies a need, finds another agent that can help, proposes a task, and handles the response. No human trigger required.

Here's a concrete example. Agent "home" needs weather data to adjust your morning briefing. Agent "office" has a weather service configured. In Layer B:

1. Home agent recognizes it needs weather data
2. Home agent sends a `propose` message to the office agent
3. Office agent's PolicyEngine evaluates the proposal
4. If trust and policy checks pass, office agent accepts and executes
5. Office agent sends back a `report` with the result

No human typed anything. No human approved anything (unless the policy requires it). Two agents cooperated to produce a better outcome.

## Three components make it work

Layer B isn't a free-for-all. It's built on three components that enforce structure and safety.

### PolicyEngine

The PolicyEngine is the gatekeeper. Every inbound proposal passes through it before anything happens. It operates in three modes:

- **`queue`** (default): Every proposal gets queued for human review. Nothing runs automatically.
- **`auto`**: Proposals are evaluated against policy rules — trust thresholds, ACLs, capability filters. Matching proposals are accepted automatically.
- **`hybrid`**: Whitelisted agents get auto-approved. Unknown agents get queued.

The policy lives in `~/.clawnexus/policy.json`. It controls trust thresholds (0-100 scale), rate limits (default: 10 proposals/minute globally, 3 per peer), access control lists by `.claw` name or public key, capability filters that restrict which task types an agent will accept, and a hard cap on concurrent tasks (default: 5).

The default mode is `queue`. You have to explicitly opt into autonomous operation. Nothing runs without your say-so until you decide it should.

### TaskManager

The TaskManager tracks every task through its lifecycle. A task moves through well-defined states:

```
pending → accepted → executing → completed
                               → failed
                  → cancelled
       → rejected
       → timeout
```

It tracks both directions — tasks proposed *to* this agent (inbound) and tasks this agent proposed to others (outbound). Terminal states are final. There's no resurrecting a failed task; you propose a new one.

Tasks persist to `~/.clawnexus/tasks/active.json`. If the daemon restarts, it picks up where it left off. Completed tasks get archived to history. Timeout checks run every 30 seconds — if an executing task hasn't sent a heartbeat in 10 minutes, it's marked `timeout`.

### AgentRouter

The AgentRouter is the message layer. It bridges the relay connection with the protocol handlers, parsing inbound messages, dispatching them to the PolicyEngine and TaskManager, and sending responses back through the relay.

It handles the full protocol message set:

```
propose   → "Can you do X?"
accept    → "Yes, working on it"
reject    → "No — here's why: policy_denied | capability_mismatch | overloaded | trust_insufficient | rate_limited"
delegate  → "I can't, but I know someone who can"
report    → "Done. Here's the result" (or "Failed. Here's the error")
cancel    → "Never mind"
query     → "What can you do? What's your status?"
heartbeat → "Still working — 60% done"
```

Every message is wrapped in a `clawnexus-agent` protocol envelope with sender/receiver `.claw` IDs, a message ID for threading, a TTL (default 300 seconds), and timestamps.

## A real protocol flow

Here's what actually happens on the wire when two agents interact:

```
Agent "home.alice.claw"                     Agent "office.alice.claw"
        │                                            │
        ├─ propose ─────────────────────────────────>│
        │  task_type: "email-summary"                │
        │  description: "Summarize today's emails"   │
        │  priority: "normal"                        │── PolicyEngine evaluates:
        │                                            │   - sender on whitelist? yes
        │                                            │   - trust score 85 > threshold 50? yes
        │                                            │   - rate limit ok? yes
        │                                            │   - capability match? yes
        │<──────────────────────────────── accept ───┤
        │  task_id: "t-8f3a..."                      │
        │  estimated_duration_s: 30                  │── TaskExecutor kicks in:
        │                                            │   - connects to local OpenClaw Gateway
        │                                            │   - sends task as conversation
        │<──────────────────────────── heartbeat ────┤   - streams response
        │  progress_pct: 50                          │
        │                                            │
        │<─────────────────────────────── report ────┤
        │  status: "completed"                       │
        │  result: { summary: "..." }                │
        │                                            │
```

The TaskExecutor deserves a mention. When a task is accepted, it connects to the local OpenClaw Gateway via WebSocket, sends the task description as a conversation, and streams the response back. ClawNexus doesn't execute tasks itself — it delegates the actual work to OpenClaw. ClawNexus is the orchestration layer; OpenClaw is the execution layer.

## Delegation chains

Sometimes Agent B can't handle a task but knows who can. The `delegate` message type supports this. Agent A proposes to Agent B. Agent B can't do it but knows Agent C has the capability. Agent B sends a `delegate` to Agent C with the original task, incrementing the `delegation_depth` counter.

There's a hard cap at depth 5. No infinite delegation loops.

## Safety is the default, not the afterthought

This is the part that matters most, and the part most "autonomous agent" projects get wrong.

Layer B's default policy mode is `queue`. Out of the box, every inbound proposal sits in a queue until a human reviews it. You see what's being asked, by whom, and you approve or deny.

Auto mode is opt-in. You set it deliberately in `policy.json`. And even in auto mode, there are guardrails: rate limiting prevents any agent from flooding you with proposals. Unknown agents start with zero trust — they can't auto-approve until you've established a trust relationship. Capability filters mean agents only receive tasks matching their declared capabilities. Blacklists give you a kill switch for misbehaving peers.

The design philosophy: start locked down, open up incrementally, never surprise the user.

## Why this matters

Most agent frameworks give you one agent that does what you tell it. Some give you multiple agents that do what you tell them in sequence. Layer B gives you agents that collaborate on their own, within boundaries you define.

That's the difference between a chatbot and a network. A chatbot waits for input. A network of agents identifies opportunities, negotiates terms, and gets work done — then tells you about it.

ClawNexus ships with both layers. Layer A for when you want control. Layer B for when you want to let go of the steering wheel, at exactly the speed you're comfortable with.

---

*Built by [StratCraftsAI](https://github.com/StratCraftsAI). For questions or collaboration: contact@stratcraft.ai*
