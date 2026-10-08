---
title: Chat system design
description: The classic "design a chat system" interview question, the target architecture, and why each piece is there.
sidebar:
  order: 1
---

"Design a chat system" (WhatsApp / Messenger / Slack) is a classic interview question. This page covers what an interviewer expects you to cover, the target architecture, and the reasoning behind each piece. The deep dives get their own pages (see [Go deeper](#go-deeper)).

## What an interviewer expects you to cover

- **Requirements**: 1:1 and group chat, online presence, delivery/read receipts, offline delivery, message history. Non-functional: low latency, messages never lost, ordering within a conversation. Scale assumptions (users, messages/day).
- **Estimates**: concurrent connections, messages per second, storage per year.
- **Connection protocol**: WebSockets vs long polling vs server-sent events (see [WebSockets](/chat-system/websockets/)).
- **High-level design**: load balancer / gateway at the edge; stateless API servers (login, lookup, history); stateful chat servers holding WebSockets; Redis for pub/sub and connection counts; message store; push notifications for offline users.
- **Data model**: messages partitioned by conversation; message IDs that sort by time (e.g. Snowflake-style).
- **Deep dives**: server placement (lookup API + power of two choices), routing a message to a user on another chat server, group fan-out, presence via heartbeats, rate limiting (connections vs messages), offline delivery, ordering, deploys and reconnect storms.

## Target architecture

```text
1. client ──HTTP──▶ LB ──▶ lookup API   "where should I connect?"
                           power of two choices over connection counts in Redis
   ◀── { server: "chat-7", token: <short-lived signed ticket> }

2. client ──WebSocket──▶ LB ──▶ chat-7  connects with server=chat-7 + token
           TLS, connection rate limits, ticket check, logs happen at the LB

3. chat servers ◀──▶ Redis pub/sub      messages between users on different servers
```

- **The lookup API decides** where a user goes. **The load balancer enforces and routes**: it sends the connection to the chosen server by its ID, not by round-robin.
- **Signed ticket**: the chat server checks the signature and expiry, so it doesn't need the auth database.
- **Rate limiting happens in two places.** Once a WebSocket is open, the load balancer only passes bytes, so it can't see messages:
  - Load balancer: new connections per IP, handshakes per second, calls to the lookup API.
  - Chat server: messages per user (e.g. 10/s).

## Why the design looks like this

- **Why power of two choices for chat**: a chat server's load is its number of open connections. Plain least-connections sends every new connection to the emptiest server, so a newly added server, or the survivors after a crash, get a pile-up. Picking the better of two random servers spreads those waves out.
- **Why a lookup API**: smart placement (load, region, keeping group members together), reconnecting just means asking again. Costs: an extra round trip before connecting, and load numbers that can be slightly stale.
- **Why keep the load balancer anyway**: TLS termination near users, rate limiting, auth at the door, DDoS protection and firewall rules, hiding internal server addresses, central logs. Full trade-off and real-world examples in [L7 proxy in the WebSocket path vs direct](/chat-system/l7-proxy-tradeoff/).
- **The load balancer and Redis complement each other.** The load balancer is the front door; Redis is the back channel between servers. Browsers never connect to Redis.
- **Neither is needed with one server.** Both become necessary at two or more servers.
- **Alternatives:** NATS, Kafka or direct server-to-server messaging instead of Redis pub/sub.
- WebSocket-specific load balancer points (stickiness, reconnect storms, idle timeouts, port limits): see the [load balancer cheat sheet](/load-balancer/cheat-sheet/).
- **End-to-end encryption** doesn't change this architecture: TLS-terminating proxies and chat servers route by metadata (`to`, `conversation`) and pass a sealed body. It adds a key directory and per-device fan-out. Details, keys and which services use it: [End-to-end encryption](/misc/e2ee/).
- **Applying this design to a HIPAA-compliant system, and adding AI conversations**: [HIPAA and AI conversations](/chat-system/hipaa-and-ai/).

## Real-world follow-ups

- At scale there's a fleet of L7 proxies (behind an L4 tier). Because the chosen server ID and ticket travel in the request, any proxy can route a connection; proxies share no state.
- A WebSocket lives *on* the proxy it passed through, so **a dying proxy drops all of its connections**: a reconnect storm just like a dying chat server. Proxies need draining before deploys too, or hot restart / connection handoff (see [L7 proxy in the WebSocket path vs direct](/chat-system/l7-proxy-tradeoff/)).
- More load balancer follow-ups at scale: [load balancer deep dives](/load-balancer/deep-dives/).

## Go deeper

- [WebSockets](/chat-system/websockets/): the handshake and frames, the three kinds of keep-alive, who sends pings, and passing WebSockets through a proxy.
- [L7 proxy in the WebSocket path vs direct](/chat-system/l7-proxy-tradeoff/): what an edge proxy costs, what going direct loses, and what Slack, Meta, WhatsApp and Discord do.
- [Connections per server](/chat-system/connections-per-server/): why a server can hold millions, what really limits it, and a capacity estimate.
- [Multiplexing](/chat-system/multiplexing/): sharing the proxy → chat server connection, and five architectures compared.
- [HIPAA and AI conversations](/chat-system/hipaa-and-ai/): applying the design to healthcare messaging, and where an AI assistant fits.
- [FAQ](/chat-system/faq/): quiz-style answers to the follow-up questions this design raises.
