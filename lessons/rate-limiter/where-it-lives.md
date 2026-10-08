---
title: Where rate limiting lives
description: Which layer can enforce which limit, why chat messages can't be limited at the load balancer, what to key limits on behind proxies, and why counters must be shared.
sidebar:
  order: 1
---

"Design a rate limiter" is a classic interview question. Before choosing an algorithm, decide **where** the limiter sits and **what** it can see, because that decides which limits are even possible. This page covers placement; algorithms (fixed window, sliding window, token bucket) come with the lab.

## Where it can live

| Placement | Good for | Weakness |
|---|---|---|
| **Client** (SDK backs off) | Being polite, fewer wasted requests | Advisory only: clients can ignore it |
| **Each server** (middleware) | Simple; limits that need app knowledge (user ID, plan, per-endpoint cost) | Each server counts alone: N servers allow N × the limit unless counters are shared |
| **Edge: API gateway / load balancer** | One place for all servers; rejects abuse before it reaches them | Sees only what its layer can read; several edge instances must share counters too |
| **Shared store** (e.g. Redis) behind any of the above | One consistent count across servers and edges | An extra network hop per check; must decide what happens if it's down (fail open vs closed) |

Real systems combine them: coarse limits at the edge, precise per-user limits in the app, counters in a shared store.

## What each layer can see

A limiter can only count what passes through it **in a form it can read**:
- An **L7 load balancer** reads HTTP requests: it can limit requests per client, per path, per API key.
- An **L4 load balancer** sees connections, not requests: it can limit new connections per IP, nothing finer.
- **After a WebSocket upgrade**, even an L7 load balancer only copies bytes. It can no longer see individual messages.

### Example: a chat system needs two places
- **At the load balancer:** new connections per IP, handshakes per second, calls to the "where should I connect?" lookup API.
- **In the chat server:** messages per user (e.g. 10 per second), because only the server that reads the frames can count them.

The same token-bucket code works in both; only the key and the limit differ. Without a load balancer on the WebSocket path, the connection-level limits move to the **lookup API**, which issues short-lived tickets: no ticket, no connection. See [the chat design](/chat-system/design/#target-architecture).

## What to key the limit on
- **User ID or API key** after authentication: the most precise.
- **IP address** before authentication (login, signup, lookup). Behind a proxy, the server's TCP peer is the proxy, so the IP comes from `X-Forwarded-For`, which is client-controlled text: trust only entries added by your own proxies, counting from the right. Keying on the first entry lets an attacker present a new "IP" on every request. See [Client IP behind proxies](/load-balancer/client-ip/).
- Many users can share one IP (offices, mobile carriers), so IP limits should be looser than per-user limits.

## Counters must be shared
Every instance that counts on its own multiplies the limit:
- **N servers**, each with in-memory counters → N × the limit.
- **N load balancers**, the same → N × the limit. Large systems run fleets of L7 proxies, so this is the normal case at the edge, not an edge case.

The fix is a shared counter, typically in Redis, updated **atomically**: a read-then-write from two servers races and lets extra requests through. Atomic increments (`INCR` with an expiry) or a small Lua script run inside Redis avoid that.

## Telling the client
Reject with **`429 Too Many Requests`** (RFC 6585), with a **`Retry-After`** header saying when to try again. Many APIs also send remaining-quota headers (often `X-RateLimit-Remaining` and similar); the IETF is standardising `RateLimit` headers for this.

:::tip[Interview version]
"Coarse limits at the edge (requests and new connections per IP or API key), precise per-user limits in the service, counters shared in Redis with atomic updates so N servers or N load balancers don't allow N times the limit. Behind proxies, key on `X-Forwarded-For` only as far as our own proxies vouch for it. Reject with 429 and `Retry-After`. For WebSockets, message limits must live in the server that reads the messages."
:::

## Sources
- [RFC 6585: Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585) (429 Too Many Requests)
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110) (`Retry-After`)
- [IETF draft: RateLimit header fields for HTTP](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [MDN: X-Forwarded-For](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/X-Forwarded-For)
