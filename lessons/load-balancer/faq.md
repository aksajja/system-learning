---
title: Load balancer FAQ
description: Quiz yourself on load balancer follow-up questions. Try answering before opening each one.
sidebar:
  order: 6
---

Questions that come up around load balancers but don't fit neatly into one page. **Try answering each one out loud before opening it.** Each answer is short and links to the full explanation.

## Interview scope

<details>
<summary>Is "design a load balancer" a common interview question?</summary>

Not usually as a whole question; it shows up more for infrastructure, networking or SRE roles. In most system design interviews the load balancer is a box drawn in the first five minutes. What *is* common is follow-up probing on that box: what happens when a server dies, isn't it a single point of failure, how do servers know the client's IP, how do WebSockets get routed. The [cheat sheet](/load-balancer/cheat-sheet/) covers those.
</details>

<details>
<summary>Is a load balancer always necessary?</summary>

No. With one server there's nothing to balance, and a single well-written server can hold tens of thousands of connections. It becomes necessary at two or more servers, for capacity or so one crash doesn't take the service down. Alternatives for spreading clients exist (DNS with several IPs, a "where should I connect?" lookup API), but they're usually combined with a load balancer rather than replacing it.

**More:** [Chat system FAQ: Redis vs load balancer](/chat-system/faq/#architecture)
</details>

## Setup and discovery

<details>
<summary>In production, are backends really the same program on different ports?</summary>

The program part is right: backends are identical copies (replicas). But they run on separate machines or containers and differ by **IP**, all on the same port; an orchestrator (Kubernetes, ECS, an auto-scaling group) starts and restarts them. A lab differs by port because everything runs on one machine. To a load balancer a backend is just `host:port`, so nothing else changes.

**More:** [Lab setup vs production](/load-balancer/deep-dives/#lab-setup-vs-production)
</details>

<details>
<summary>What does "discovering backends" mean?</summary>

The load balancer finding out which backends exist **right now**, instead of reading a fixed list, because backends come and go (scaling, crashes, deploys). Done via DNS (simple but slow to update), a service registry such as Consul or etcd (backends register and keep checking in), or the orchestrator (Kubernetes knows where every copy runs). Discovery answers *which backends exist?*; health checks answer *which of them work right now?*

**More:** [Discovering backends](/load-balancer/deep-dives/#discovering-backends)
</details>

## Failures

<details>
<summary>If health checks run every few seconds, don't lots of requests fail when a server dies?</summary>

Yes, there's a **failure window**. With 5-second checks and 2 failures needed, a dead server gets traffic for ~10s: at 1,000 req/s across 4 servers, ~2,500 failed requests. Real systems shrink it with passive health checks (react to real failing requests), retries on another server (safe when the request never arrived), short connect timeouts, and draining for planned removals.

**More:** [The failure window](/load-balancer/deep-dives/#the-failure-window)
</details>

<details>
<summary>What's the difference between "connection refused", failing to connect, and a crashed process?</summary>

A **crash** is what happened to the server; the others are what the client sees. The OS kernel, not the program, answers TCP connections:
- Process crashed, machine up → the kernel replies "nobody's listening": **connection refused**, instantly.
- Machine or network gone → nothing replies: **connect timeout**, after a long default wait.
- Process alive but stuck → the connection succeeds, the response never comes: **read timeout**.
- Process died mid-request → **connection reset** / `EOF`.

"Failing to connect" covers the first two; the server never got the request, so retrying elsewhere is safe.

**More:** [Ways a request can fail](/load-balancer/deep-dives/#ways-a-request-can-fail)
</details>

## Connections and ports

<details>
<summary>Is there a hard limit on how many connections a load balancer can open?</summary>

On the side where it **opens** connections, yes: ~28k ephemeral ports on Linux by default (~16k on macOS), but **per destination** (per load balancer IP → backend IP:port). Facing clients it's a server, so no port limit there. The bigger trap is **churn**: a closed connection holds its port in TIME_WAIT for 60s on Linux, so without reuse ~470 new connections/s per backend exhausts the ports. Fix: keep-alive pools.

**More:** [Port limits](/load-balancer/deep-dives/#port-limits)
</details>

<details>
<summary>Why does <code>curl --keepalive-time</code> still use a new port every time?</summary>

Because it sets **TCP keepalive** (probes on an idle connection), not **HTTP keep-alive** (reusing a connection for the next request). And separate `curl` commands can't share a connection anyway: it closes when the process exits. `curl -v URL URL` reuses one connection within a single command. A long-running proxy keeps its pool across requests, which is where reuse matters.

**More:** [Three kinds of keep-alive](/chat-system/websockets/#three-kinds-of-keep-alive)
</details>

## Algorithms and products

<details>
<summary>What's the standard way of assigning work to servers?</summary>

Weighted round-robin is the default almost everywhere; least connections (or least outstanding requests) for uneven or long-lived work; **power of two choices** as the modern version when several load balancers run side by side; consistent hashing when the same key must reach the same server.

**More:** [Algorithms in practice](/load-balancer/algorithms/)
</details>

<details>
<summary>Doesn't Nginx abstract all of this away?</summary>

It replaces the *code*, not the *decisions*. You still choose the algorithm, timeouts and health checks, and some defaults catch people out: before 1.29.7, no connection reuse to backends unless configured; no `X-Forwarded-For` unless you add it; free Nginx has only passive health checks.

**More:** [Nginx: what it does and doesn't do for you](/load-balancer/algorithms/#nginx-what-it-does-and-doesnt-do-for-you)
</details>

<details>
<summary>Why can't a backend just trust the <code>X-Forwarded-For</code> header?</summary>

Because headers are text the client sent: `curl -H 'X-Forwarded-For: 1.2.3.4'` arrives as `1.2.3.4, <real IP>`. Only entries added by your own proxies are trustworthy, so count from the right. Taking the first entry lets anyone fake their IP, defeating per-IP rate limits and bans.

**More:** [Client IP behind proxies](/load-balancer/client-ip/)
</details>

## Scale

<details>
<summary>Who load-balances the load balancers?</summary>

Layers: DNS or anycast picks a region; routers hash each connection's four identifying values to one of several L4 machines (ECMP); the L4 tier (e.g. Maglev, Katran, AWS NLB) uses consistent hashing to keep every packet of a connection on the same L7 proxy. No machine has to remember anything.

**More:** [Load balancing the load balancers](/load-balancer/deep-dives/#load-balancing-the-load-balancers)

**Sources:** [Google: Maglev](https://research.google/pubs/maglev-a-fast-and-reliable-software-network-load-balancer/), [Meta: Open-sourcing Katran](https://engineering.fb.com/2018/05/22/open-source/open-sourcing-katran-a-scalable-network-load-balancer/)
</details>

## Building one

<details>
<summary>Round-robin output looked perfectly even with a plain counter. Why use an atomic?</summary>

Because the race was there, just invisible. Handlers run concurrently in separate goroutines, and `next++` is three steps (read, add, write) that can interleave. Go's memory model gives a program with a data race no guaranteed behaviour. In the lab, 300 parallel requests still split 100/100/100, yet `go run -race` reported `WARNING: DATA RACE`. Races hide in testing and fail rarely under real load; the race detector finds them.

**More:** [Lab step 3](/load-balancer/lab/#step-3-round-robin)

**Sources:** [Go: Data Race Detector](https://go.dev/doc/articles/race_detector), [The Go Memory Model](https://go.dev/ref/mem)
</details>

<details>
<summary>Should a load balancer be written in Go, Python or Rust?</summary>

For learning, Go: goroutine-per-connection mirrors how proxies work, and the race detector exposes concurrency bugs. In production, Rust is increasingly used for high-traffic proxies (Cloudflare replaced Nginx with its Rust-based Pingora) because it has no garbage collector and is memory-safe; Go powers Traefik and Caddy; Nginx and HAProxy are C, Envoy is C++.

**More:** [Choosing a language for systems work](/misc/language-choice/)
</details>
