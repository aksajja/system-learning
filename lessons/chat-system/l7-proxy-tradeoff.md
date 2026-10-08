---
title: L7 proxy in the WebSocket path vs direct
description: Whether chat WebSockets should pass through an L7 edge proxy fleet or connect straight to chat servers, and what real systems do.
sidebar:
  order: 3
---

Once a client knows which chat server to use, how should its WebSocket get there? Through a fleet of L7 proxies, or straight to the server behind a plain L4 load balancer? This page weighs both and looks at what large chat services actually do.

**Option A, L7 proxy in the path** (the design in this repo): client → L4 → L7 proxy fleet → chosen chat server. The proxy terminates TLS, checks the ticket and routes by server ID, then copies bytes.

**Option B, direct**: the lookup API is the gate (auth, rate limits, issues short-lived tickets); clients connect through an **L4 pass-through** load balancer straight to the chosen chat server, which verifies the ticket itself. Fully direct with *nothing* in front is not a serious production option: it loses DDoS protection.

## What an L7 proxy in the path costs

| Cost | Why | How bad |
|---|---|---|
| Port limit per proxy–server pair | One proxy→server connection per user, from one proxy IP: ~28k on Linux by default, ~64k max | Per pair only: 20 proxies → ~560k users per chat server. Fix with more proxy IPs or server ports. |
| Twice the sockets | Proxy holds the client's connection *and* its own to the server | 1M users → 2M sockets + TLS memory across the proxy fleet |
| Extra hop per message | Every message passes through; TLS decrypted at the proxy | Sub-millisecond in a data center, but CPU on every message |
| More things that can drop users | A dying or redeploying proxy disconnects everyone through it | Solved at scale with hot restart / connection handoff (Slack, Meta) |

It doesn't cap the *total* number of WebSockets (add proxies), but makes each one more expensive. Where the port limit actually bites is worked through in [Connections per server](/chat-system/connections-per-server/#where-the-company-hits-the-limit-layer-by-layer).

## What Option B really loses (item by item)

| Edge service | How Option B covers it | What's really lost |
|---|---|---|
| **TLS termination** | Each chat server does TLS. The expensive part is the handshake (once per long-lived connection); per-message encryption is cheap (AES instructions in the CPU). One auto-renewed wildcard certificate. Many companies re-encrypt inside their network anyway. | Handshake CPU on receiving servers during reconnect storms (TLS session resumption helps); private key on many machines; handshakes travel the full distance to the data center instead of ending at a nearby edge |
| **Rate limiting** | The lookup API stays behind a normal L7 load balancer, so its limits are intact. No ticket, no connection. Message limits live in the chat server in *both* options. | Clients without tickets still cost a TCP accept + TLS handshake before rejection (really a DDoS issue) |
| **Auth at the door** | Lookup checks the auth DB once, issues a signed ticket `{user, server, expires}`. Chat servers verify the signature locally (microseconds). Sign with a private key, give servers only the public key, so a compromised server can't forge tickets. Mid-session bans must be *pushed* (e.g. Redis) in both options. | Nothing. Single-use tickets need a Redis "seen it?" check, or accept a very short expiry bound to one server. |
| **DDoS / firewall / blocklists** | The L4 layer provides flood protection (e.g. AWS NLB + Shield, Cloudflare Spectrum) and IP blocks; servers' firewalls allow only the L4. Client IP via preserved source IP or the **PROXY protocol** (the L4 equivalent of `X-Forwarded-For`). | Application-level filtering (WAF, bot detection) on the WebSocket handshake; the lookup API keeps it |
| **Hiding internal layout** | Clients see `chat-7.example.com` on the L4, not real IPs. Targeting one server is possible in *both* options: `server=chat-7` routes an attacker there too. | An L7 proxy could absorb a handshake flood aimed at chat-7; with L4 it reaches chat-7, behind only general flood limits |
| **Central logs / metrics** | Logs are shipped centrally anyway; chat metrics (messages, delivery, presence) can only come from chat servers. L4 gives flow logs. | Convenience: a uniform access log for free |
| **Draining / maintenance** | *Better*: mark chat-7 "draining" in Redis so the lookup stops assigning it, then the server tells its clients "reconnect elsewhere", spread out with jitter. A proxy can only cut connections; it doesn't speak the chat protocol. | Nothing (the reconnect message and client handling are needed anyway) |

Most of Option B's losses come down to **unauthenticated handshakes reaching chat servers**, plus **no nearby edge to end handshakes close to users**.

## What real systems do

- **Slack: DNS → L4 → L7 → services.** Weighted DNS (`wss-primary.slack.com`) → AWS NLB (L4) → Envoy fleet (L7, terminates TLS, handles the upgrade) → separate WebSocket services for messages, presence and apps. Over 5 million simultaneous WebSocket sessions at peak. With HAProxy they kept old proxy processes running *for hours* to drain WebSockets; they moved to Envoy largely for **hot restart**. **Flannel** is an application-aware edge proxy in the WebSocket path: verifies the token, caches workspace data, answers the initial "hello" itself; a routing tier keeps a workspace's users on the same Flannel instance. Clients first make a small HTTP call to the main app (a lookup step).
- **Meta (Messenger): L4 → two tiers of L7 → backends.** Katran (L4) → Edge Proxygen (L7 at points of presence near users; long-lived MQTT connections terminate here) → Origin Proxygen (data center) → MQTT backends. **Socket takeover**: during a deploy, a new proxy instance takes new connections while the old one keeps serving existing ones. **Downstream connection reuse**: a restarting proxy hands its MQTT connections to another healthy proxy, invisibly to users.
- **WhatsApp (historically): direct.** Erlang chat servers holding over 2 million connections each (each connection a tiny Erlang process), custom protocol over raw TCP, code deployed without disconnecting users. The main real-world example of Option B: it works when servers are extremely efficient and can upgrade in place.
- **WhatsApp today: through Meta's edge.** Observed 2026-10, from one location: `g.whatsapp.net` → `chat.cdn.whatsapp.net` → an IP whose reverse DNS is `whatsapp-chatd-edge-shv-01-atl3.facebook.com` (owner: Meta Platforms), a WhatsApp chat *edge* host in Meta's Atlanta point of presence. Internals aren't public, but clients no longer connect straight to data-center chat servers: direct-to-server describes WhatsApp in 2012, not now.
- **Discord: lookup + session-specific URL.** Clients ask `GET /gateway` for the WebSocket URL. After connecting, the server returns a **session-specific `resume_gateway_url`**; on a drop, the client reconnects there and missed events are replayed. Routing by an ID in the URL, close to the `server=chat-7` in this design.

:::note[Unconfirmed]
What sits in front of Discord's gateway servers is not publicly documented.
:::

## Takeaways

1. At scale, **L4 in front of an L7 edge proxy fleet is the norm**. The doubled sockets are worth it for: TLS ending near the user (faster connects and reconnects), central security and routing.
2. The big players **engineered away the proxy's main weakness** (hot restart, socket takeover, connection handoff) rather than avoiding proxies.
3. **Lookup and routing by ID** appear alongside proxies (Slack's boot call and workspace affinity, Discord's `/gateway` and resume URL).
4. **Direct is the exception**, viable with extremely efficient, self-upgrading servers (early WhatsApp). Even WhatsApp now connects clients through Meta's edge.
5. **The 2026 picture:** large services converge on an edge tier near users (TLS and connection handling) in front of the core: Slack (Envoy, Flannel, gateways), Meta (Proxygen, WhatsApp chat edge).

## Interview answer

:::tip[Interview version]
"Clients get a placement from a lookup API, then connect through L4 load balancers to a fleet of L7 edge proxies that terminate TLS close to the user, authenticate the ticket, and route to the chosen chat server. The proxy fleet doubles the connection count, but buys faster handshakes, central security, and a single place to control traffic. Proxy restarts mustn't drop users, so the proxies need hot restart or connection handoff. A leaner alternative is direct connections to very efficient servers, like early WhatsApp."
:::

## Sources

- [Slack: Migrating Millions of Concurrent Websockets to Envoy](https://slack.engineering/migrating-millions-of-concurrent-websockets-to-envoy/)
- [Slack: Flannel, an application-level edge cache to make Slack scale](https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/)
- [How Facebook achieves disruption-free updates with zero downtime (APNIC blog)](https://blog.apnic.net/2021/03/29/how-facebook-achieves-disruption-free-updates-with-zero-downtime/)
- [Meta Research: Zero Downtime Release, disruption-free load balancing of a multi-billion user website](https://research.facebook.com/publications/zero-downtime-release-disruption-free-load-balancing-of-a-multi-billion-user-website/)
- [Open-sourcing Katran, a scalable network load balancer (Meta)](https://engineering.fb.com/2018/05/22/open-source/open-sourcing-katran-a-scalable-network-load-balancer/)
- [The WhatsApp Architecture Facebook Bought For $19 Billion (High Scalability)](https://highscalability.com/the-whatsapp-architecture-facebook-bought-for-19-billion/)
- [Discord Gateway documentation](https://docs.discord.com/developers/events/gateway)
- [discord.js RFC: session-specific gateway resume URLs](https://github.com/discordjs/discord.js/issues/8461)
