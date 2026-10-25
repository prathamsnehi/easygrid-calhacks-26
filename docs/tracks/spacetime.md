# Cal Hacks 13.0 — SpacetimeDB Track Agent Brief

## Purpose

We are competing in the **Best Use of Spacetime** track. This file supplies **track-specific priorities**, not SpacetimeDB documentation. You already have access to SpacetimeDB skills and should use those for APIs, syntax, setup, deployment, and version-specific implementation details.

## What the judges are looking for

The workshop states:

> **“We're judging what Spacetime made possible.”** — Slide 31

It also says teams can **build anything: a web app, a game, an agent**. There is no more detailed official scoring rubric in the workshop.

**Our north star:** Make it obvious that SpacetimeDB enabled a distinctive, working part of the product—not merely that we used it as a database.

## Architectural priorities

Use these to guide implementation decisions **when relevant to our actual product**:

1. **Real-time by design.** Make important shared state reactive through subscriptions. A core interaction should visibly propagate between connected clients without manual refresh or polling.
2. **Server-authoritative logic.** Put consequential state transitions and validation in transactional reducers. The workshop stresses that a reducer commits all its changes or none.
3. **Persistent shared state.** Let SpacetimeDB own the application's relevant durable state. Avoid adding separate infrastructure for capabilities it already provides without a concrete reason.
4. **Security and isolation.** Keep sensitive data private, use caller-aware access rules, and enforce mutation permissions on the server. If users have private state, demonstrate that isolation.
5. **Use the platform's distinctive capabilities naturally.** Consider scheduled operations, external-API procedures, or an AI worker subscribing as a client **only if they strengthen the product**. Do not add features solely to showcase APIs.
6. **Keep the implementation reliable.** Validate critical reducers, failed transactions, reconnect behavior, and schema updates. The workshop repeatedly emphasizes moving fast without breaking existing state.

These are **our strategic priorities inferred from the workshop**, not individually published judging criteria.

## What to show judges

Build a short demo around the app's real value:

- **The experience:** Show the key feature working end to end.
- **The Spacetime moment:** Trigger an action that clearly demonstrates synchronized live state, a meaningful transaction, or another distinctive capability.
- **The proof:** If useful, show two clients, a rejected invalid mutation, persisted state after reconnecting, or a relevant scheduled/agent-driven event.
- **The explanation:** In one or two sentences, answer: **“What did SpacetimeDB make possible here, and why did it matter?”**

Prefer a polished, reliable demonstration of **one strong use case** over superficial use of many platform features.

## Boundaries for the coding agent

- **Do not** treat this brief as API documentation; consult the installed SpacetimeDB skills and current project dependencies.
- **Do not** invent a more specific official judging rubric or promise points for using particular features.
- **Do not** reshape the user's product idea just to check every platform feature box.
- **Do not** introduce unnecessary backend services or duplicate sources of truth.
- **Do not** include Scrabblebot tournament mechanics, promo codes, or unrelated event details in the project.

## Final self-check

Before considering the infrastructure complete, be able to answer:

1. What is our product's most compelling **SpacetimeDB-enabled behavior**?
2. Can a judge **see it working** in under a minute?
3. Is the critical state **server-authoritative, persistent, and appropriately permissioned**?
4. Have we tested the failure cases most likely to break the demo?
5. Can we accurately explain why SpacetimeDB matters to this implementation?

**Source:** Clockwork Labs, *Move fast and don't break things*, Cal Hacks 13.0 workshop (October 20, 2026), especially slides 3–5, 16–21, 27, 29, and 31.
