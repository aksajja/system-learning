---
title: Multiplexing
description: Sharing the proxy-to-chat-server connection across many users, and how five chat architectures compare.
sidebar:
  order: 5
---

A plain L7 proxy opens one upstream connection per user, which doubles sockets and runs into port limits with dense servers. Multiplexing shares a few upstream connections across many users. This page explains why one-per-user is the default, two ways to share, Slack's gateway design, and a side-by-side comparison of five architectures.

## Terms: proxy vs gateway

- **Proxy** (Envoy, Nginx): after the WebSocket upgrade it copies bytes without understanding them. Generic; works for any app.
- **Gateway** (e.g. Slack's gateway servers): an app-specific server that *understands* the chat protocol, keeps per-user state, and fans messages out. Written by the company itself.

In L4 → L7 → chat server, the L7 is a proxy. Multiplexing pushes it toward being a gateway.

## Why plain proxying costs 2 sockets per user

A TCP connection runs between exactly two endpoints, and a WebSocket lives inside one. The client's connection **ends at the proxy**, so the proxy must open a **second, separate** connection to the chat server. Per user: 1 socket on the client, **2 on the proxy**, 1 on the chat server.

It's one upstream connection **per user** because in plain WebSockets **the connection is the user's identity**: a frame has no "from: Alice" field. The server knows frames on connection #812 are Alice's because that connection was authenticated at the handshake. Merging users onto one connection would leave the server unable to tell frames apart (and frames could interleave). One-per-user also lets the proxy stay generic: after the upgrade it just copies bytes.

## Design: one shared WebSocket from the proxy to each chat server

```text
Alice ═ws═▶ ┐
Bob   ═ws═▶ ├─ L7 proxy ══ one shared WebSocket ══▶ chat server
Carol ═ws═▶ ┘    wraps each frame:                   unwraps, routes locally
                 {from: Alice, data: …}               by the label
```

Socket count: the proxy holds 1 per user (client side) + a few shared; the chat server holds a few in total. No port limit.

What the proxy must now do (no longer byte-copying):
1. **Read each client's frames** and re-send them inside a labelled envelope.
2. **Reverse it for replies**: `{to: Alice, data: …}` arrives on the shared connection, and the proxy keeps a **user → client connection map** to deliver it.
3. **Report connects and disconnects** as messages: the server can no longer see users' connections open or close.
4. **Handle slow clients itself.** With byte copying, TCP flow control slows the whole path for a slow reader. On a shared connection the proxy can't slow the shared stream for Alice without stalling Bob and Carol, so it must **buffer, drop, or disconnect** her when her buffer fills.

Generic proxies don't offer an app-specific envelope; you'd write this proxy yourself.

**Standards-based variant: HTTP/2 (RFC 8441).** Each WebSocket becomes a numbered **stream** inside a shared HTTP/2 connection; the stream number is the label, so a generic proxy *can* multiplex without understanding messages. The chat server must support WebSockets over HTTP/2; HTTP/2's per-stream flow control handles slow clients.

:::caution
Proxy support for WebSockets over HTTP/2 to the upstream varies: verify before relying on it.
:::

**Fan-out caveat:** if the server sends a message to 5,000 users behind one proxy, that's still 5,000 labelled sends on the shared connection, *unless* the protocol allows "deliver to this list of users", which moves fan-out into the proxy (fully gateway-like).

## Design: gateway tier + channel servers (Slack)

Slack's real-time messaging splits the work into tiers:
- **Gateway servers** hold users' WebSockets, know each user and their channels.
- **Channel servers** hold channel state and recent history; channels are assigned to channel servers by **consistent hashing** (a peak host serves ~16 million channels).
- When a user connects, their gateway **subscribes to the channel servers** holding that user's channels. Messages between tiers are **labelled with channel and user IDs** over shared connections.

Big win, **fan-in**: if 5,000 users on one gateway are in `#general`, the gateway subscribes **once** and delivers to its 5,000 local users itself.

The "chat servers + Redis pub/sub" design in this repo is a simple version of this: chat servers act as gateways (hold WebSockets, deliver locally), Redis plays the channel-server role (routes labelled messages), and each chat server shares a few Redis connections rather than one per user.

## Comparing the architectures

- **A. L7 proxy, one upstream per user** (the design in this repo): L4 → Envoy/Nginx copying bytes → chat server
- **B. Direct**: lookup API as the gate → L4 pass-through → chat server (no L7 on the WebSocket path)
- **C. L7 proxy, shared upstream, custom envelope**: the design above
- **D. L7 proxy, HTTP/2 multiplexing** (RFC 8441)
- **E. Gateway tier + channel servers** (Slack)

A and B are compared in detail in [L7 proxy in the WebSocket path vs direct](/chat-system/l7-proxy-tradeoff/).

| | A. Proxy, 1:1 | B. Direct | C. Proxy, shared (custom) | D. Proxy, HTTP/2 | E. Gateway + channels |
|---|---|---|---|---|---|
| **Sockets per user** | Client 1, proxy 2, server 1 | Client 1, server 1 | Client 1, proxy 1, server ≈ 0 | Client 1, proxy 1, server ≈ 0 | Client 1, gateway 1, channel server ≈ 0 |
| **Port limit (opening side)** | Yes, proxy → server per pair | None | None | None | None |
| **Edge software** | Generic (Envoy/Nginx) | None in L7 | **Custom** proxy | Generic, if it supports RFC 8441 upstream | **Custom** gateway (app code) |
| **TLS ends near the user** | Yes (edge proxies) | No: at the chat server | Yes | Yes | Yes (gateways at the edge) |
| **Edge services** (auth, rate limits, WAF) | At the proxy | At the lookup API + chat server; DDoS via L4 | At the proxy | At the proxy | At the gateway, app-aware |
| **Slow clients** | TCP flow control, naturally | TCP, naturally | Proxy must buffer/drop/disconnect | HTTP/2 per-stream flow control | Gateway must buffer/drop/disconnect |
| **Head-of-line blocking** | None between users | None | **All users on a shared connection** | Same (fixed by HTTP/3/QUIC) | Shared links between tiers (contained by design) |
| **One connection failing affects** | 1 user | 1 user | Everyone through that proxy–server pair | Same | Subscriptions on that link; gateway resubscribes |
| **Fan-out to many users** | Server sends one copy per user | Same | Same, unless list-delivery added | Same | **Fan-in: one copy per gateway**, gateway delivers locally |
| **Server can see a user disconnect** | Yes (connection closes) | Yes | Only via proxy messages | Yes (stream closes) | Gateway sees it directly |
| **Build effort** | Lowest | Low (+ ticket checks in servers) | High | Medium (if supported) | Highest |
| **Real-world** | Common default; Slack's Envoy layer proxies to WebSocket services | Early WhatsApp | Rare as a custom proxy (it becomes E) | Standardised, support varies | Slack (gateway + channel servers) |

## When to choose which

- **A**: default at small to moderate scale; simplest; port limit only bites with very dense servers behind few proxies.
- **B**: extremely efficient, very dense servers that upgrade in place (early WhatsApp); accept weaker edge services.
- **C**: rarely worth it as a "proxy": once you write that much custom code, go to E.
- **D**: when the port limit or server socket count bites and your proxy and servers support WebSockets over HTTP/2.
- **E**: large scale with big groups/channels: fan-in makes delivery efficient. The usual end state of a mature chat system.

:::tip[Interview version]
"Simple L7 proxying costs two sockets per user and hits port limits with dense servers. You can multiplex users over shared upstream connections, with HTTP/2 streams or labelled messages, but then slow clients, head-of-line blocking and shared failures become the proxy's problem. At scale this becomes a gateway tier: gateways hold connections and subscribe to channel servers, so a message to a big channel crosses to each gateway once (fan-in), as Slack does."
:::

## Sources

- [Slack Engineering: Real-time Messaging](https://slack.engineering/real-time-messaging/)
- [InfoQ: Real-time messaging at Slack](https://www.infoq.com/news/2023/04/real-time-messaging-slack/)
- [RFC 8441: Bootstrapping WebSockets with HTTP/2](https://www.rfc-editor.org/rfc/rfc8441)
