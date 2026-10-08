---
title: Chat system FAQ
description: Quiz yourself on the follow-up questions a chat system design raises. Try answering before opening each one.
sidebar:
  order: 7
---

Questions that come up around the [chat system design](/chat-system/design/) but don't fit neatly into one page. **Try answering each one out loud before opening it**: that's the interview skill. Each answer is short and links to the full explanation.

## Architecture

<details>
<summary>Does Redis replace the load balancer, or complement it?</summary>

They solve different problems, so they complement each other.
- **The load balancer is the front door**: it decides which server a new connection lands on, and handles TLS, health checks and rate limits at the edge.
- **Redis pub/sub is the back channel between servers**: when Alice on server `a` messages a room, `a` publishes to Redis and every server with members of that room receives it. Browsers never connect to Redis.

With **one** server you need neither. Both become necessary at two or more servers.

**More:** [Why the design looks like this](/chat-system/design/#why-the-design-looks-like-this)
</details>

<details>
<summary>Is a "where should I connect?" lookup API worth having?</summary>

Yes, it's a standard answer. The client asks an HTTP endpoint which chat server to use and gets back a server ID plus a short-lived signed ticket.
- **Pros:** smart placement (load, region, keeping group members together); reconnecting just means asking again; tickets let chat servers verify users without the auth database.
- **Cons:** an extra round trip before connecting, and load numbers that can be slightly stale.

Real systems have this step: Discord clients call `GET /gateway` and later get a session-specific resume URL; Slack clients make a small HTTP call before opening the WebSocket.

**More:** [Target architecture](/chat-system/design/#target-architecture), [What real systems do](/chat-system/l7-proxy-tradeoff/#what-real-systems-do)
</details>

<details>
<summary>Why power of two choices rather than least connections for chat?</summary>

A chat server's load is its number of open connections, so least-connections-style placement fits. But plain least-connections sends **every** new connection to the emptiest server: a newly added server, or the survivors after a crash, get a pile-up. Several load balancers (or lookup instances) with slightly stale counts make it worse, since they all pick the same server. Picking the better of **two random** servers spreads those waves out and is nearly as good as checking every server.

**More:** [Algorithms in practice](/load-balancer/algorithms/#why-power-of-two-choices-took-over)
</details>

<details>
<summary>Without a load balancer in front of chat servers, what do you lose?</summary>

The edge services: TLS termination near users, rate limiting, authentication at the door, DDoS protection and firewall rules, hiding internal server addresses, central logs, a single place to drain servers. With a lookup API as the gate and an L4 load balancer in front, most of these are covered another way; what's really lost comes down to **unauthenticated handshakes reaching chat servers** and **no edge near users** to end handshakes quickly.

**More:** [What Option B really loses (item by item)](/chat-system/l7-proxy-tradeoff/#what-option-b-really-loses-item-by-item)
</details>

<details>
<summary>Once a WebSocket is established, does the connection switch to an L4 load balancer?</summary>

No. There's no handoff: a TCP connection can't move between machines mid-stream. The same L7 proxy works at L7 during the handshake (reads the URL, headers and ticket, picks the backend), then after `101 Switching Protocols` just copies bytes for that connection, behaving like L4. Separately, at scale an L4 tier sits **in front of** the L7 proxies to spread connections across them.

**More:** [WebSockets through an L7 proxy](/load-balancer/deep-dives/#websockets-through-an-l7-proxy), [Passing WebSockets through a proxy](/chat-system/websockets/#passing-websockets-through-a-proxy)
</details>

<details>
<summary>Do you need to balance load across the load balancers themselves?</summary>

At scale, yes. One machine can't hold millions of connections and would be a single point of failure. DNS (or anycast) picks a region, routers hash each connection to one of several L4 machines (ECMP), the L4 tier spreads connections across a fleet of L7 proxies. For chat this means: keep the routing decision **in the request** (server ID + ticket) so any proxy can route it; per-proxy rate limits leak (N proxies → N× the limit); a dying proxy drops every WebSocket through it.

**More:** [Load balancing the load balancers](/load-balancer/deep-dives/#load-balancing-the-load-balancers)
</details>

<details>
<summary>Which approach do Slack, Meta, WhatsApp and Discord actually use?</summary>

- **Slack:** DNS → AWS NLB (L4) → Envoy (L7) → WebSocket services; Flannel, an application-aware edge, and gateway servers subscribing to channel servers.
- **Meta Messenger:** Katran (L4) → edge Proxygen → origin Proxygen → MQTT backends, with socket takeover so restarts don't drop users.
- **WhatsApp:** famously direct-to-server in 2012 (2M+ connections per Erlang server); today clients connect through a WhatsApp chat **edge** host on Meta's network.
- **Discord:** lookup (`GET /gateway`) plus a session-specific resume URL; what sits in front of the gateway isn't public.

The pattern: large services converge on an edge tier near users in front of the core.

**More:** [What real systems do](/chat-system/l7-proxy-tradeoff/#what-real-systems-do), [Where large services are in 2026](/chat-system/hipaa-and-ai/#where-large-services-are-in-2026)

**Sources:** [Slack: Migrating Millions of Concurrent Websockets to Envoy](https://slack.engineering/migrating-millions-of-concurrent-websockets-to-envoy/), [Slack: Real-time Messaging](https://slack.engineering/real-time-messaging/), [Meta zero downtime release (APNIC)](https://blog.apnic.net/2021/03/29/how-facebook-achieves-disruption-free-updates-with-zero-downtime/), [Discord Gateway docs](https://docs.discord.com/developers/events/gateway)
</details>

## Connections and scale

<details>
<summary>If ports are limited to ~64k, how can WhatsApp hold 2 million connections on one server?</summary>

The port limit applies to the side that **opens** connections, not the side that accepts them. A server keeps one listening port (443); each connection is told apart by the **client's** IP and port: `(client IP, client port, server IP, 443)`. Accepting uses up no ports. What limits a server is open files (a setting), memory (roughly 30–50 KB per connection all-in), CPU for traffic and heartbeats, and blast radius.

**More:** [Why a server can hold millions](/chat-system/connections-per-server/#why-a-server-can-hold-millions-the-port-limit-is-on-the-opening-side)

**Sources:** [WhatsApp: 1 million is so 2011](https://blog.whatsapp.com/1-million-is-so-2011), [Phoenix: The Road to 2 Million Websocket Connections](https://www.phoenixframework.org/blog/the-road-to-2-million-websocket-connections)
</details>

<details>
<summary>Where does a company actually hit its connection limit: the load balancer?</summary>

Mostly not.
- **L4 tier:** forwards packets, holds no sockets; limited by packets per second.
- **L7 proxy tier:** holds 2 sockets per user, and its **upstream** side hits the port limit per proxy–server pair. Users per pair = total ÷ (proxies × servers), so it only bites when very dense servers sit behind few proxies.
- **Chat servers:** the number you plan around ("connections per server"), limited by memory, CPU and blast radius.

**More:** [Where the company hits the limit, layer by layer](/chat-system/connections-per-server/#where-the-company-hits-the-limit-layer-by-layer)
</details>

<details>
<summary>Why does an L7 proxy need 2 sockets per user? Isn't one WebSocket enough?</summary>

A TCP connection runs between exactly two endpoints, and the client's ends **at the proxy**. To reach the chat server, the proxy must open a second connection. It's one upstream **per user** because a WebSocket frame has no "from" field: the connection itself identifies the user.

**More:** [Why plain proxying costs 2 sockets per user](/chat-system/multiplexing/#why-plain-proxying-costs-2-sockets-per-user)
</details>

<details>
<summary>Couldn't the proxy keep one shared WebSocket to each chat server and let the server route locally?</summary>

Yes: that's **multiplexing**. The proxy wraps each frame with a label (`{from: Alice, …}`), keeps a user → client connection map for replies, and reports connects and disconnects. It removes the port limit and most server sockets. The price: a custom, app-aware proxy; slow clients must be buffered or dropped by the proxy; one lost packet delays every user on the shared connection (head-of-line blocking); one broken connection affects everyone through it. HTTP/2 streams (RFC 8441) are the standards-based variant.

**More:** [One shared WebSocket from the proxy](/chat-system/multiplexing/#design-one-shared-websocket-from-the-proxy-to-each-chat-server), [Comparing the architectures](/chat-system/multiplexing/#comparing-the-architectures)

**Sources:** [RFC 8441: Bootstrapping WebSockets with HTTP/2](https://www.rfc-editor.org/rfc/rfc8441)
</details>

<details>
<summary>What's the difference between a proxy and a gateway?</summary>

- **Proxy** (Envoy, Nginx): generic; after the upgrade it copies bytes without understanding them.
- **Gateway** (e.g. Slack's gateway servers): app-specific; understands the chat protocol, keeps per-user state, fans messages out to local users, subscribes to channel servers.

In L4 → L7 → chat server, the L7 is a proxy. Multiplexing with app-specific labels pushes it toward being a gateway.

**More:** [Terms: proxy vs gateway](/chat-system/multiplexing/#terms-proxy-vs-gateway)
</details>

## WebSockets

<details>
<summary>Do WebSockets use keep-alive by default?</summary>

"Keep-alive" means three things. **HTTP keep-alive** (reusing a connection for the next request) doesn't apply: a WebSocket is one long connection. **TCP keepalive** exists but waits 2 hours by default on Linux before probing. **WebSocket ping/pong** is built into the protocol, but someone must *send* pings: in practice the server, every 20–30 seconds.

**More:** [Three kinds of keep-alive](/chat-system/websockets/#three-kinds-of-keep-alive)
</details>

<details>
<summary>Why use a WebSocket library instead of implementing ping/pong yourself?</summary>

The library handles protocol mechanics (handshake, framing, answering pings). Your code owns the policy: how often to ping, how long to wait for a pong, what to do when none comes. Go's standard library has no WebSocket server, and hand-writing frame parsing teaches little about chat systems.

**More:** [Use a library, own the policy](/chat-system/websockets/#use-a-library-own-the-policy)
</details>

<details>
<summary>Does the load balancer need to understand WebSockets?</summary>

It needs to **pass them through**, not understand them. A plain HTTP proxy waits for request/response pairs and breaks once the connection switches protocol. Passthrough means: spot the `Upgrade` header, forward the handshake, then hijack the raw connection and copy bytes both ways. No frames are read.

**More:** [Passing WebSockets through a proxy](/chat-system/websockets/#passing-websockets-through-a-proxy)
</details>

## Security and compliance

<details>
<summary>Are Slack and Messenger end-to-end encrypted?</summary>

- **Slack:** no. Encrypted in transit and at rest, but Slack's servers can read messages (search, compliance exports, integrations need it).
- **Messenger:** personal chats yes, by default since a rollout starting December 2023; group chats were opt-in as of 2024.
- **WhatsApp:** yes, everything by default. **Discord:** calls yes (DAVE protocol), text no.

**More:** [Who's end-to-end encrypted](/misc/e2ee/#whos-end-to-end-encrypted)
</details>

<details>
<summary>If L7 proxies terminate TLS, can the service still be end-to-end encrypted?</summary>

Yes. TLS protects each **hop**; end-to-end encryption protects the **message itself**, applied by the sender's app with keys only the recipient's devices hold. A proxy opening TLS finds routing metadata (`to`, `conversation`) and a sealed body it can't read. Meta's edge proxies terminate connections, yet Messenger personal chats are end-to-end encrypted. Conversely, connecting directly to a chat server doesn't make anything end-to-end: the server decrypts TLS and reads.

**More:** [TLS vs end-to-end](/misc/e2ee/#tls-vs-end-to-end-two-separate-layers)
</details>

<details>
<summary>Is there one public/private key pair per chat?</summary>

No. Keys are layered: an identity key pair and prekeys per **device** (public halves in a key directory); a shared secret per **pair of devices** agreed with Diffie-Hellman (X3DH), even if the recipient is offline; a **new key per message** (Double Ratchet) for forward secrecy; **sender keys** for groups.

**More:** [How the keys work](/misc/e2ee/#how-the-keys-work-signal-protocol-used-by-whatsapp-and-messenger)

**Sources:** [Signal: X3DH](https://signal.org/docs/specifications/x3dh/), [Signal: Double Ratchet](https://signal.org/docs/specifications/doubleratchet/)
</details>

<details>
<summary>Which architecture suits a HIPAA-compliant messaging system?</summary>

HIPAA doesn't prescribe a topology: every component that handles PHI is in scope and needs a BAA, encryption in transit and at rest, access control and audit logs. A managed L7 load balancer under a BAA that **re-encrypts** to the chat servers is a good default; direct connections through L4 decrypt PHI in fewer places. Usually not end-to-end encrypted, because records must be retained and produced. Keep PHI out of push notifications and logs.

**More:** [HIPAA: what shapes the architecture](/chat-system/hipaa-and-ai/#hipaa-what-shapes-the-architecture)
</details>

<details>
<summary>Should AI conversations be a separate system from peer conversations?</summary>

Share the platform, separate the service. AI traffic is different (streamed responses over seconds, model rate limits and cost, outages that mustn't affect peer messaging), but a fully separate system would duplicate identity, storage, retention and audit. The pattern: an AI service that joins conversations as a **bot participant** via the same pub/sub, so AI-only chats and AI inside peer chats share one audited store.

**More:** [AI conversations vs peer conversations](/chat-system/hipaa-and-ai/#ai-conversations-vs-peer-conversations)
</details>
