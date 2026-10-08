---
title: Load balancer deep dives
description: Talk-only depth for when the interviewer pushes on scale, plus the background behind the cheat sheet answers.
sidebar:
  order: 2
---

The [cheat sheet](/load-balancer/cheat-sheet/) is what you say first. This page is for when the interviewer keeps pushing: how real systems scale load balancing itself, what changes with several L7 proxies, and the details behind failures and port limits.

## Scaling up: real-world follow-ups

### Load balancing the load balancers
One machine can't hold millions of connections and would be a single point of failure, so real systems stack layers:

```text
client
  │  DNS / GeoDNS: picks a region or data center (several IPs per name)
  ▼
routers         ECMP: hash each connection's (src IP, src port, dst IP, dst port)
  │                   to pick one of several L4 machines
  ▼
L4 tier         e.g. Google Maglev, Facebook Katran, AWS NLB: fast packet forwarding;
  │             consistent hashing so every packet of a connection reaches the same L7 proxy
  ▼
L7 tier         Envoy / Nginx: TLS, rate limits, auth checks, routing
  ▼
servers
```

- Routers and DNS balance the balancers by **hashing** each connection's four identifying values, so no machine has to remember anything.
- **Consistent hashing** keeps existing connections in place when an L4 machine is added or removed.
- DNS details (GeoDNS, TTLs, two providers, anycast): [DNS](/misc/dns/).

:::tip[Interview version]
"DNS or anycast in front, an L4 tier spreading connections across a fleet of L7 proxies."
:::

### WebSockets through an L7 proxy
L7 to decide, then L4-style forwarding. There's no handoff to another load balancer: a TCP connection can't move between machines mid-stream. During the handshake the proxy works at L7: it reads the URL, headers and ticket, and picks the backend. After `101 Switching Protocols` the same proxy just copies bytes for that connection. Why a plain HTTP proxy breaks WebSockets, and how passthrough works: [WebSocket passthrough](/chat-system/websockets/#passing-websockets-through-a-proxy).

### What several L7 proxies mean for a design
- **Keep routing decisions in the request** (e.g. `server=chat-7` plus a signed ticket), so any proxy can route correctly with no shared state between proxies.
- **Per-proxy rate limits leak**: N proxies counting separately allow N × the limit. Shared counters (Redis) fix it; it's the same problem as with multiple servers.
- **A dying proxy drops every long-lived connection passing through it**, causing a reconnect storm just like a dying server. Proxies need draining before deploys too, or better: hot restart (Envoy) or handing connections to another proxy (Meta's socket takeover / downstream connection reuse).

### Real systems
Slack (DNS → AWS NLB → Envoy → WebSocket services) and Meta Messenger (Katran → edge Proxygen → origin Proxygen → MQTT backends) both proxy long-lived connections at L7 behind an L4 tier. Details, the direct-connection alternative and sources: [L7 proxy vs direct connections](/chat-system/l7-proxy-tradeoff/).

## Background

### Lab setup vs production
- Real backends are identical copies (replicas) of one program, as in the [lab](/load-balancer/lab/).
- In production they run on separate machines or containers and differ by **IP**, all on the same port. The lab runs them on one machine, so they differ by **port**. To a load balancer a backend is just `host:port`, so the lessons are unaffected.
- In production an orchestrator (Kubernetes, ECS, a cloud auto-scaling group) starts and restarts the copies; in the lab you do it by hand.

### Discovering backends
The load balancer finding out which backends exist *right now*, instead of reading a fixed list. It's needed because backends come and go (scaling, crashes, deploys).
- **DNS**: one name resolves to all current backend IPs. Simple, but slow to update because answers are cached.
- **Service registry** (Consul, etcd): backends register on startup and keep checking in; those that stop are dropped.
- **Orchestrator**: e.g. Kubernetes already knows where every copy runs and keeps the list current.

**Discovery** answers *which backends exist?* **Health checks** answer *which of them work right now?* Real systems use both.

### The failure window
A backend that crashes keeps receiving traffic until the load balancer notices.
- Example: health checks every 5s, with 2 failures needed to mark a backend down, so a crashed backend gets traffic for up to ~10s. At 1,000 req/s across 4 backends, that's ~250 req/s to the dead one, or **~2,500 failed requests**.
- Health checks, not DNS, are the first line of defence against crashes. Slow discovery matters more for adding capacity.

How real systems shrink it:
1. **Passive health checks**: watch real traffic and mark a backend down as soon as requests to it fail.
2. **Retries on another backend**: safe if the request never reached the server; risky if it died mid-request (e.g. charging a card twice).
3. **Short connect timeouts**: so requests to a vanished machine don't hang for a minute or more.
4. **Graceful shutdown (draining)**: planned removals announce themselves, finish in-flight requests, then exit, so they cause zero errors.

### Ways a request can fail
The OS kernel, not the server program, answers TCP connections. So *what* died decides what the client sees.

| What happened | Connected? | Client sees (Go error) | How fast | Safe to retry? |
|---|---|---|---|---|
| Process crashed, machine up | No | Connection refused (`connect: connection refused`) | Instant | Yes |
| Machine or network gone | No | Connect timeout (`i/o timeout`) | Slow: ~75s macOS / ~2min Linux by default | Yes |
| Process alive but stuck | Yes | Read timeout | Slow (the timeout) | Risky |
| Process died mid-request | Yes | Connection reset (`connection reset by peer` / `EOF`) | Fast | Risky |

"Failing to connect" covers the first two: the server never received the request. A "stuck" server passes a simple "can I connect?" health check, so good health checks make a real request.

### Port limits
- Connections the load balancer **opens** to backends use ephemeral ports: ~16k on macOS (49152–65535), ~28k on Linux by default.
- The limit is **per destination**: per (load balancer IP, backend IP, backend port). 10 backends means ~10× the connections.
- Facing clients, the load balancer is a server: all clients arrive on one port, so there's no port limit there (only memory and open-file limits).
- **TIME_WAIT**: whichever side closes a connection holds its port for 30s (macOS) or 60s (Linux) afterwards. Check with `netstat -an -p tcp | grep TIME_WAIT`.
- So without connection reuse, exhaustion comes from the **rate** of new connections: ~28k ports ÷ 60s ≈ 470 new connections/s per backend on Linux.
- Fixes: reuse connections (keep-alive pools, the main one), more load balancer IPs, a wider port range / `tcp_tw_reuse`.

### WebSockets
- Long-lived connections: churn and TIME_WAIT mostly stop mattering, but the **concurrent** limit starts to.
- A WebSocket can't be shared, so an HTTP-level load balancer holds one dedicated backend connection per connected user. ~28k ports per (load balancer IP, backend) caps users per backend. Fixes: more load balancer IPs, more backends or backend ports, or a layer 4 load balancer that opens no connections of its own.
- Connections stick to one backend for life: a newly added backend gets no existing users until people reconnect.
- Least-connections fits naturally: open connections = users on that server.
- Deploys can't wait for connections to finish, so they get cut. Every client then reconnects at once (**reconnect storm**); clients need random reconnect delays.
- Load balancers close idle connections (often ~60s), so chat clients and servers send periodic pings.
- The backend's own limit is open files: on macOS it is capped by `kern.maxfilesperproc` (92,160 per process on one Mac checked). Each connection also costs memory.
- Users on different backends can't reach each other directly, so backends need pub/sub (e.g. Redis) between them. That's the core of the [chat system design](/chat-system/design/).
