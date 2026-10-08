---
title: DNS
description: How a name becomes an IP address, and how DNS acts as the top layer of load balancing, with a live look at how clients reach Slack.
sidebar:
  order: 1
---

DNS is the internet's phone book: it turns a **name** (`wss-primary.slack.com`) into an **IP address** (`3.14.34.68`) that a connection can be opened to.

:::tip[Interview version]
DNS usually gets one line at the top of the diagram ("DNS resolves to the nearest region's load balancers") and maybe one follow-up. These points cover nearly all of it:
- **GeoDNS** sends users to the nearest region.
- **TTL trade-off**: a short TTL makes failover fast but costs more queries; some resolvers cache longer anyway, so DNS failover is never instant.
- **Multiple A records** spread users across load balancer nodes (round-robin DNS).
- **DNS can be a single point of failure**: use two independent providers or networks (the 2016 Dyn outage).
- **Anycast** as the alternative: one IP, served from the nearest of many sites.
:::

## Concepts

### 1. Names form a tree, read right to left

```text
.                           the root (the invisible dot at the end)
└── com                     top-level domain (TLD)
    └── slack.com           Slack's domain
        └── wss-primary.slack.com
```

Each level can **delegate** (hand off) the part below it to different servers. The `.com` operators don't know Slack's IPs, only *who to ask* about `slack.com`. A part of the tree one set of servers is responsible for is a **zone**.

### 2. Two kinds of DNS servers

| | Resolver | Authoritative nameserver |
|---|---|---|
| Role | Does the legwork for clients and **caches** results | **Owns** the answers for one zone |
| Who runs it | Your ISP, your router, Google (`8.8.8.8`), Cloudflare (`1.1.1.1`), your company | The domain owner, or a DNS provider on their behalf |
| Who talks to it | Your device | Only resolvers |

Clients never contact a company's nameservers directly; they ask a resolver.

### 3. The lookup walk

A resolver that has nothing cached walks down the tree:

```text
① root server:  "who handles .com?"                 → the .com servers
② .com server:  "who handles slack.com?"            → AWS Route 53
③ Route 53:     "who handles wss-primary.slack.com?" → NS1 + slackdns.com
④ NS1:          "what's wss-primary.slack.com?"      → 8 IP addresses, cache for 10s
```

Each step took 6–35 ms in a trace from one location. The resolver caches what it learns, so later lookups skip most of the walk.

### 4. Record types

Each record reads: **name, TTL, type, value**.

| Type | Meaning | Example |
|---|---|---|
| **A** | Name → IPv4 address | `wss-primary.slack.com A 3.14.34.68` |
| **AAAA** | Name → IPv6 address | (like `::1`) |
| **NS** | "These nameservers are authoritative for this name": how delegation works | `slack.com NS ns-166.awsdns-20.com` |
| **CNAME** | Alias: "this name is really that name" | Common for pointing at cloud load balancers |
| **PTR** | Reverse: IP → name | `3.14.34.68` → `ec2-3-14-34-68.us-east-2.compute.amazonaws.com` |

### 5. TTL and caching

**TTL** (time to live) is how many seconds a resolver may reuse an answer. From the same trace:
- The root's records: 512,975s (~6 days). They almost never change.
- `slack.com`'s nameservers: 172,800s (2 days).
- `wss-primary`'s IPs: **10s**.

| Long TTL | Short TTL |
|---|---|
| Fewer queries, faster lookups | Many more queries |
| Changes take hours or days to reach everyone | Changes reach everyone within seconds |

:::caution
Some resolvers and apps ignore TTLs and cache longer, so changes are never perfectly instant.
:::

### 6. Multiple A records: round-robin DNS

One name can return several IPs, shuffled per answer. Clients usually take the first, so shuffling spreads users across them; if one doesn't answer, most clients try the next. Slack returned 8 IPs, a different set of 8 on a later lookup: a larger pool, rotated.

### 7. Smart DNS: the answer depends on who asks

- **Weighted routing**: return set A 90% of the time, set B 10%. Slack used this to move traffic from HAProxy to Envoy gradually.
- **GeoDNS**: answer with the *service's* servers near the asker (not other nameservers). Catch: it sees the **resolver's** location, not the user's (someone in Tokyo using `8.8.8.8` is judged by Google's resolver location). **EDNS Client Subnet** passes part of the user's address along to fix this. "Near" can mean geography (country/continent), **measured latency** (e.g. Route 53 latency-based routing: nearest on a map isn't always fastest), or **policy** (e.g. EU users stay in EU regions for data residency), combined with health checks and weights.
- **Health-checked failover**: stop returning IPs whose servers fail health checks.

This makes DNS the top layer of load balancing: it picks **which region and which load balancer nodes** before any connection exists.

### 8. Managed DNS providers, and redundancy

Few companies run their own authoritative servers; they use providers like **AWS Route 53, NS1 or Cloudflare**, which run large, global nameserver networks. DNS is itself a single point of failure: in 2016 an attack on the provider **Dyn** took Twitter, GitHub and Spotify offline because each relied on Dyn alone. Hence two independent providers for important names.

### 9. Three different "which server?" choices

They're easy to blur together; only the third is DNS logic based on location.

| Choice | Decided by | Based on |
|---|---|---|
| **Which nameserver** a resolver asks (of the several listed) | The resolver | Measured response time (prefers the fastest, occasionally retries others), falls back on timeouts. Redundancy, not geography. |
| **Which physical machine** answers for that nameserver's IP | Internet routing (anycast) | Network distance: the nearest site announcing the IP |
| **Which IPs the answer contains** | The authoritative server (GeoDNS, weights, health) | Where the query came from, traffic weights, health checks |

Analogy: several support numbers you can call (pick whichever answers fastest) → each number reaches your nearest call centre (anycast) → the agent tells you which branch to visit based on where you live (GeoDNS).

### 10. Anycast

**Unicast**: one IP = one location. **Anycast**: many machines in many cities **announce the same IP**, and internet routing sends each user to the nearest. Used by root servers, `1.1.1.1` (it answered in 6 ms in the same trace) and DNS providers. Also an option for load balancers: one address, served from many sites.

### 11. Reverse DNS

**PTR records** map an IP back to a name. Cloud providers name their IPs by region (`...us-east-2.compute.amazonaws.com`), which makes reverse lookups a handy detective tool.

## Case study: how clients reach Slack's WebSocket servers

:::note[Snapshot]
Live lookups on 2026-10-04, from one location. GeoDNS may answer differently elsewhere, and the records may have changed since.
:::

- `slack.com` is on **AWS Route 53**.
- `wss-primary.slack.com` is **delegated to two sets of nameservers**: NS1's shared network (`dns1.p07.nsone.net` …) and Slack-branded ones (`ns01.slackdns.com` …) hosted on **NetActuate**, an anycast hosting company. Querying with `+nsid` shows the `slackdns.com` servers identify as `ns1dns-…`, so **both are run by NS1**: two separate networks from one vendor. That protects against one network failing, not against NS1 itself failing.
- Anycast in action: the same nameserver name is answered by the nearest site. From the observer's network, NSID showed `ord03` (Chicago O'Hare) for NS1 and `iad99` (Washington Dulles) for `slackdns.com`; sites are usually named by airport codes.
- `wss-primary` returns **8 IPs with a 10-second TTL**: AWS machines in **us-east-2 (Ohio)**, consistent with the AWS NLB (L4) nodes in Slack's architecture. The order changes per lookup.
- `wss-backup.slack.com` returns an IP in **us-west-2 (Oregon)**, TTL 40s: a second region.
- **GeoDNS confirmed.** Asking NS1 with `+subnet=` to simulate users elsewhere gives each location its nearest AWS region:

  | Simulated location | `wss-primary` → region | `wss-backup` → region |
  |---|---|---|
  | Germany | Frankfurt (`eu-central-1`) | London (`eu-west-2`) |
  | Japan | Tokyo (`ap-northeast-1`) | Singapore (`ap-southeast-1`) |
  | Australia | Sydney (`ap-southeast-2`) | |
  | California | Oregon (`us-west-2`) | |
  | Observer's network | Ohio (`us-east-2`) | Oregon (`us-west-2`) |

  So the Ohio/Oregon answers above only describe the observer's location; the backup is a nearby *second* region, chosen per location too.
- GeoDNS returns the **service's** IPs (Slack's load balancers in the nearest region), not another nameserver's. The DNS lookup ends there; GeoDNS decides where the real connection goes.

```text
DNS (NS1 + slackdns, 10s TTL, weighted)  → picks the region, spreads across NLB nodes
  → AWS NLB (L4)                           → spreads connections across Envoy proxies
    → Envoy (L7)                           → TLS, upgrade, routes to WebSocket services
```

For the full Slack architecture behind this, see [L7 proxy in the WebSocket path](/chat-system/l7-proxy-tradeoff/).

## Commands to explore with

```sh
dig slack.com                        # full answer with TTLs
dig +short wss-primary.slack.com     # just the IPs
dig NS slack.com                     # who's authoritative
dig +trace @1.1.1.1 slack.com        # the whole walk from the root
dig -x 3.14.34.68                    # reverse lookup (PTR)
dig +nsid +norec @dns1.p07.nsone.net wss-primary.slack.com   # which anycast site answered
dig +short +subnet=85.214.132.0/24 @dns1.p07.nsone.net wss-primary.slack.com   # GeoDNS: answer as if asked from Germany
```

- Run `dig wss-primary.slack.com` twice a few seconds apart: the TTL **counts down**, because the second answer comes from the resolver's cache.
- Plain `dig +trace` can fail on some home networks (the router's resolver won't answer the root query); `@1.1.1.1` fixes it.

## Sources

- [Slack: Migrating Millions of Concurrent Websockets to Envoy](https://slack.engineering/migrating-millions-of-concurrent-websockets-to-envoy/) (NS1 weighted routing during the HAProxy → Envoy migration)
