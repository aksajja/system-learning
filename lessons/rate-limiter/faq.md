---
title: Rate limiter FAQ
description: Quiz yourself on rate limiter placement questions. Try answering before opening each one.
sidebar:
  order: 2
---

**Try answering each one out loud before opening it.** Each answer links to the full explanation.

<details>
<summary>Why can't the load balancer rate-limit chat messages?</summary>

After the WebSocket upgrade, the load balancer only copies bytes for that connection: it never parses frames, so it can't count messages. It *can* limit what it still sees: new connections per IP, handshakes per second, calls to the lookup API. Message limits must live in the chat server, the one component that reads them.

**More:** [What each layer can see](/rate-limiter/where-it-lives/#what-each-layer-can-see)
</details>

<details>
<summary>Without a load balancer on the WebSocket path, what happens to rate limiting?</summary>

The **lookup API** becomes the gate. It's ordinary HTTP behind a normal L7 load balancer, so it keeps its rate limits, and it issues short-lived tickets: no ticket, no chat connection. Message limits stay in the chat server either way. What's left uncovered: clients without tickets still cost the chat server a TCP accept and a TLS handshake before rejection, which an L4 DDoS layer has to absorb.

**More:** [What Option B really loses](/chat-system/l7-proxy-tradeoff/#what-option-b-really-loses-item-by-item)
</details>

<details>
<summary>Why does running several load balancers break a per-client limit?</summary>

Each one counts on its own, so N load balancers allow N × the limit, exactly like N servers with in-memory counters. Large systems run fleets of L7 proxies, so this is normal at the edge. Fix: shared counters (e.g. Redis) updated atomically.

**More:** [Counters must be shared](/rate-limiter/where-it-lives/#counters-must-be-shared)
</details>

<details>
<summary>Behind a proxy, what should a per-IP limit key on?</summary>

The client IP from `X-Forwarded-For`, but only as far as your own proxies vouch for it: count from the right, skipping proxies you control. The leftmost entry is whatever the client sent, so keying on it lets an attacker look like a new IP on every request. Prefer user ID or API key once the user is authenticated.

**More:** [What to key the limit on](/rate-limiter/where-it-lives/#what-to-key-the-limit-on), [Client IP behind proxies](/load-balancer/client-ip/)
</details>

<details>
<summary>What should a client get back when it's limited?</summary>

`429 Too Many Requests` with a `Retry-After` header. Remaining-quota headers (`X-RateLimit-Remaining` and similar) are a common convention; the IETF is standardising `RateLimit` headers.

**More:** [Telling the client](/rate-limiter/where-it-lives/#telling-the-client)
</details>

<details>
<summary>Is Go, Python or Rust better for building a rate limiter?</summary>

Go for learning: a rate limiter is "many requests at once update shared counters", and Go has real parallelism plus a race detector that exposes mistakes. Python's GIL makes races rarer and harder to see. Rust refuses to compile racy code, which is educational if learning Rust is itself the goal. The distributed version's core logic runs inside Redis (a Lua script), whatever language calls it.

**More:** [Choosing a language for systems work](/misc/language-choice/)
</details>
