---
title: Connections per server
description: Why a chat server can hold millions of connections, what actually limits it, and where the limit bites in a proxied architecture.
sidebar:
  order: 4
---

How many WebSockets can one chat server hold, and which layer of the system hits a limit first? This page separates the port limit (which mostly doesn't apply to servers) from the real limits, collects the published numbers, and ends with a capacity estimate you can say in an interview.

## Why a server can hold millions: the port limit is on the *opening* side

From a chat server's side, every connection looks like `(client IP, client port, server IP, 443)`. The server's half never changes; connections are told apart by the **client's** IP and port. Accepting connections uses up no ports (theoretical limit ≈ every client IP × every client port ≈ 280 trillion).

The ephemeral port limit (~16k macOS, ~28k Linux default, ~64k max) hits whoever **opens** connections to **one** destination:
- an **L7 proxy** → a chat server (the proxy is the client there);
- **load-test machines**: Phoenix's 2M-connection demo hit port exhaustion on the *client* machines (8 servers maxed out for 330k connections; 45+ client machines for the final run), not on the server;
- a **traffic generator** on a laptop (see [Load generation limits](/misc/load-generation-limits/)).

## What actually limits connections per server

1. **Open files**: every connection is one; defaults are tiny (Phoenix started at `ulimit -n` = 1024). Just a setting: WhatsApp set `kern.maxfiles=3000000`.
2. **Memory**: kernel socket buffers + app state, roughly **30–50 KB per connection all-in** (Phoenix: 2M in ~64–84 GB; WhatsApp: 2M+ on 100 GB). "An Erlang process is ~300 bytes" is only the app's share.
3. **CPU for activity**: idle connections are cheap, traffic isn't. WhatsApp's 2.8M-connection server handled 571k packets/s. Heartbeats add up: 2M connections pinged every 30s ≈ 67k pings/s.
4. **Blast radius** (a business limit): a crash disconnects everyone on that server, so companies often hold *fewer* than the technical maximum.

## Published numbers

| Company | Published | Per server |
|---|---|---|
| **WhatsApp** (2012) | **2M+ TCP connections per server**, peak 2.8M (571k packets/s). 24 logical CPUs, 100 GB RAM, FreeBSD tuned: `kern.ipc.maxsockets=2400000`, `kern.maxfiles=3000000`, `kern.maxfilesperproc=2700000`. | **Published** |
| **Discord** (2020) | 12M+ concurrent users, 26M+ WebSocket events/s, cluster of 400–500 Elixir machines | **Not published.** 12M ÷ ~450 ≈ 27k is only a rough floor (those machines run all chat services). Blog claims of ~1M per gateway server have no primary source. |
| **Slack** | 5M+ simultaneous WebSocket sessions at peak; Flannel served 4M simultaneous connections | **Not published** (a secondary site's ~65k-per-server claim has no primary source) |
| **Meta (Messenger)** | Two tiers of edge proxies holding MQTT connections | **Not published** |
| *Phoenix benchmark (2015)* | 2M WebSockets on one 40-core, 128 GB server; reproduced at 2.3M on 20 cores / 64 GB | *Benchmark, not production* |

Both well-documented single-server results ran on the Erlang VM (BEAM), whose lightweight processes suit huge connection counts. Go can reach hundreds of thousands to low millions per machine with care about per-connection memory (goroutine stacks, buffers).

## Where the company hits the limit, layer by layer

| Layer | Holds per user | Port limit? | What limits it |
|---|---|---|---|
| **L4** (NLB, Maglev, Katran) | Nothing (forwards packets) or a small table entry | No | Packets per second; almost never connection count |
| **L7 proxy** | **2 sockets** (client side + upstream) | **Yes, upstream**: per proxy IP → chat server pair | Open files, memory (TLS state makes connections heavier), the per-pair port limit |
| **Chat server** | 1 socket + app state | No (inbound only) | Open files, memory, CPU, blast radius: **the number you size the fleet by** |

**When the proxy's port limit bites:** `users per pair = total users ÷ (proxies × chat servers)`.
- Big fleet, moderate servers: 10M users, 20 proxies, 50 servers → 10k per pair. Fine.
- Few proxies, very dense servers: 2 proxies in front of 2M-user servers → 1M per pair. Far over.

Very dense servers pull against one-to-one L7 proxying, which fits WhatsApp's early direct design (an inference; not stated by WhatsApp). Fixes: more proxy source IPs, more server ports, more proxies, or **multiplexing** many users over a few upstream connections (e.g. HTTP/2; RFC 8441 defines WebSockets over HTTP/2), which removes the port limit. Which internal hops at Slack or Meta multiplex is unconfirmed. Multiplexing designs and how they compare: [Multiplexing](/chat-system/multiplexing/).

## Interview capacity estimate

:::tip[Interview version]
10M concurrent users. Plan **200k per chat server** (below the technical maximum, to limit blast radius) → 50 servers, plus spare capacity to survive losing some (e.g. 65). Proxy tier at ~500k clients per proxy → 20 proxies, holding 20M sockets (2 per user). Port check: 10M ÷ (20 × 65) ≈ 7.7k per pair, under 28k. ✓
:::

## Sources

- [WhatsApp blog: 1 million is so 2011](https://blog.whatsapp.com/1-million-is-so-2011)
- [High Scalability: The WhatsApp Architecture Facebook Bought For $19 Billion](https://highscalability.com/the-whatsapp-architecture-facebook-bought-for-19-billion/)
- [Rick Reed (WhatsApp): Scaling to Millions of Simultaneous Connections (slides)](https://www.slideshare.net/slideshow/scaling-to-millions-of-simultaneous-connections-by-rick-reed-from-whatsapp/52848143)
- [Phoenix blog: The Road to 2 Million Websocket Connections in Phoenix](https://www.phoenixframework.org/blog/the-road-to-2-million-websocket-connections)
- [Elixir blog: Real time communication at scale with Elixir at Discord](https://elixir-lang.org/blog/2020/10/08/real-time-communication-at-scale-with-elixir-at-discord/)
- [Discord: How Discord Scaled Elixir to 5,000,000 Concurrent Users](https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users)
- [Slack: Migrating Millions of Concurrent Websockets to Envoy](https://slack.engineering/migrating-millions-of-concurrent-websockets-to-envoy/)
- [Slack: Flannel, an application-level edge cache](https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/)
- [RFC 8441: Bootstrapping WebSockets with HTTP/2](https://www.rfc-editor.org/rfc/rfc8441)
