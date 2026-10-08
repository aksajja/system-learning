---
title: Load balancer cheat sheet
description: About two minutes of talk when the load balancer box comes up in an interview, plus answers to the usual follow-up questions.
sidebar:
  order: 1
---

In a system design interview the load balancer is usually just a box on the diagram. You won't be asked to build one, but you will be asked what it does and what happens when things go wrong. This page is the short version to say out loud, then answers to the follow-up questions interviewers tend to ask.

For more depth, see [Deep dives](/load-balancer/deep-dives/). To see the mechanics running, do the [lab](/load-balancer/lab/). Quiz yourself with the [FAQ](/load-balancer/faq/).

## The two-minute version

### What it does
It spreads requests across identical, **stateless** servers (any server can take any request), so you can add capacity and survive server failures. It's also where **TLS** (HTTPS) usually ends.

### Layer 4 vs layer 7
- **L4** (TCP): forwards connections without reading them. Very fast, protocol-agnostic, and opens no connections of its own in pass-through modes. Can't route by URL or header.
- **L7** (HTTP): reads each request. Can route by path, header or cookie, add `X-Forwarded-For`, retry, and terminate TLS. Costs more CPU, and holds its own connections to backends.

### Algorithms
- **Round-robin** (usually weighted): the default almost everywhere. Good for similar, short requests.
- **Least connections**: for uneven request times or long-lived connections (WebSockets). **Power of two choices** (pick 2 servers at random, take the less busy one) is the modern version, and avoids several load balancers piling onto the same server.
- **Hashing** (client IP, user ID, URL): the same key always goes to the same server, for sticky sessions and caches. Use **consistent hashing** so adding a server moves only a fraction of keys.

What real products default to, and why power of two choices took over: [Algorithms in practice](/load-balancer/algorithms/).

## Follow-up questions

### "What happens when a server dies?"
- Health checks (active probes, plus passive checks that watch real traffic) take it out of rotation. Until then there's a **failure window**: e.g. 5s checks × 2 failures ≈ 10s of traffic to a dead server.
- Shrink it with passive checks, retries on another server (only for safe/idempotent requests, or when the connection never opened), and short connect timeouts.
- Planned removals (deploys, scale-down) use **draining**: stop new traffic, finish in-flight requests, then exit, so there are zero errors.

More: [the failure window](/load-balancer/deep-dives/#the-failure-window) and [ways a request can fail](/load-balancer/deep-dives/#ways-a-request-can-fail).

### "Isn't the load balancer a single point of failure?"
Run several. Put DNS (several IPs), a floating IP with failover (active-passive), or anycast in front. Cloud load balancers (AWS ALB/NLB) do this for you. At very large scale the load balancers are themselves load-balanced: see [load balancing the load balancers](/load-balancer/deep-dives/#load-balancing-the-load-balancers).

### "How do servers know the client's IP?"
The L7 load balancer adds `X-Forwarded-For` (at L4: the PROXY protocol). It's client-controlled text, so trust only entries added by your own proxies, counting from the right. This matters for rate limiting. More: [Client IP behind proxies](/load-balancer/client-ip/).

### "What about WebSockets / long-lived connections?"
- Each connection sticks to one server for its lifetime; least-connections fits. A newly added server gets no existing users until people reconnect.
- Deploys cut connections, causing a **reconnect storm**; clients need random reconnect delays (jitter).
- Idle timeouts close quiet connections, so send pings.
- An L7 load balancer holds one backend connection per user, so per-backend port limits (~28k on Linux) can matter at scale. Users per proxy–server pair = total ÷ (proxies × servers), so it bites when very dense servers sit behind few proxies. Servers themselves have no port limit (they only accept connections); their limits are memory, CPU and blast radius. Details: [Connections per server](/chat-system/connections-per-server/).

## Also worth knowing

### Connection reuse
The load balancer should keep pooled keep-alive connections to backends. Opening a new one per request wastes time and can exhaust ephemeral ports (TIME_WAIT). Older Nginx versions (before 1.29.7) don't reuse them unless configured: see [Nginx: what it does and doesn't do for you](/load-balancer/algorithms/#nginx-what-it-does-and-doesnt-do-for-you). "Keep-alive" means three different things; see [the three kinds of keep-alive](/chat-system/websockets/#three-kinds-of-keep-alive).

### Discovery
How the load balancer learns which servers exist: static config, DNS, a service registry (Consul, etcd), or the orchestrator (Kubernetes). See [discovering backends](/load-balancer/deep-dives/#discovering-backends).

### Real products
Nginx, HAProxy and Envoy (L7, self-run); AWS ALB (L7) and NLB (L4); Kubernetes Services.
