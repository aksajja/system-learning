---
title: Side topics FAQ
description: Quiz yourself on DNS, encryption and load-generation questions. Try answering before opening each one.
sidebar:
  order: 5
---

Questions about the side topics. **Try answering each one out loud before opening it.** Encryption questions that come up in chat design are in the [chat system FAQ](/chat-system/faq/#security-and-compliance).

## DNS

<details>
<summary>Do interviewers ask about DNS?</summary>

Rarely in depth. It usually gets one line at the top of the diagram ("DNS resolves to the nearest region's load balancers") and maybe one follow-up. Five points cover nearly all of it: GeoDNS sends users to the nearest region; the TTL trade-off (fast failover vs query volume); multiple A records spread users across load balancer nodes; DNS can itself be a single point of failure; anycast serves one IP from many sites.

**More:** [DNS](/misc/dns/)
</details>

<details>
<summary>Does Slack run its own DNS servers that clients hit?</summary>

No, on two counts. Clients never contact a company's nameservers directly: they ask a **resolver** (ISP, `8.8.8.8`, `1.1.1.1`), which walks the tree and caches answers. And Slack uses managed DNS: `slack.com` on AWS Route 53, with `wss-primary.slack.com` delegated to NS1, including Slack-branded nameservers that identify as NS1. Answers carry a 10-second TTL so weighted traffic shifts take effect within seconds.

**More:** [Case study: how clients reach Slack's WebSocket servers](/misc/dns/#case-study-how-clients-reach-slacks-websocket-servers)
</details>

<details>
<summary>So there are several nameservers, and one is picked by location?</summary>

Three different choices are easy to blur:
- **Which nameserver** the resolver asks: by measured response time, for redundancy, not geography.
- **Which physical machine** answers for that nameserver's IP: **anycast** routing delivers the query to the nearest site.
- **Which IPs the answer contains**: **GeoDNS**, decided by the authoritative server based on where the query came from.

**More:** [Three different "which server?" choices](/misc/dns/#9-three-different-which-server-choices)
</details>

<details>
<summary>Does GeoDNS return the IP of the closest authoritative server?</summary>

No: it returns the IPs of the **service** you're trying to reach (e.g. Slack's load balancers in your nearest region). The DNS lookup ends there; GeoDNS decides where your real connection goes. "Closest" is usually judged by the **resolver's** address unless the resolver passes part of the user's address along (EDNS Client Subnet), and it can mean geography, measured latency, or policy (such as data residency), combined with health checks.

**More:** [Smart DNS: the answer depends on who asks](/misc/dns/#7-smart-dns-the-answer-depends-on-who-asks)
</details>

<details>
<summary>Why would a company use two DNS providers?</summary>

DNS is itself a single point of failure. In 2016 a large attack on the DNS provider Dyn took Twitter, GitHub, Spotify and others offline because each relied on Dyn alone. Two independent providers (or at least two separate networks) let either answer if the other fails.

**More:** [Managed DNS providers, and redundancy](/misc/dns/#8-managed-dns-providers-and-redundancy)

**Sources:** [Wikipedia: 2016 Dyn cyberattack](https://en.wikipedia.org/wiki/2016_Dyn_cyberattack)
</details>

## Load generation

<details>
<summary>Why does a load generator run out of connections long before the server does?</summary>

The generator **opens** every connection, and each needs an ephemeral source port: ~16k per server address on macOS. The server only **accepts**, so all clients share its one listening port. Phoenix's 2-million-WebSocket demo needed 45+ client machines for this reason. Workarounds: more server ports, more source addresses, higher open-file limits.

**More:** [Load generation limits](/misc/load-generation-limits/)
</details>

## Languages

<details>
<summary>Which language is best for learning how these systems work?</summary>

Go: goroutine-per-connection mirrors how proxies work, and `go run -race` exposes concurrency bugs that Python's GIL tends to hide. Rust is worth it when learning Rust is itself the goal; it's increasingly used for production proxies (Cloudflare's Pingora) because it has no garbage collector and is memory-safe.

**More:** [Choosing a language for systems work](/misc/language-choice/)
</details>
