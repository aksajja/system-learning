---
title: Where routing lives
description: Who holds the ring. A client library fed from etcd, a proxy tier, or the cache nodes themselves (Redis Cluster). What each costs, how gossip scales, and how to choose.
sidebar:
  order: 6
---

[Partitioning](/distributed-cache/partitioning/) decides *how* a key maps to a shard. This page is about *where* that mapping is computed and stored, and how it changes when shards come and go.

## Control plane and data plane

Two kinds of information, with very different needs:
- **Configuration:** the shard list and ring, a [hot-key table](/distributed-cache/partitioning/#keeping-track-of-which-keys-are-split), owner leases. It's small, changes rarely, and everyone must agree on it. This is the **control plane**.
- **Requests:** `GET group:42`, millions per second. This is the **data plane**. It uses its own in-memory copy of the configuration and never asks the control plane per request.

### etcd as the configuration store

A coordination service (etcd, ZooKeeper, Consul) is the usual home for the control plane:
- **Consensus (Raft in etcd):** a write commits only when a majority of its nodes have it, so every reader sees the same latest value.
- **Watches:** clients subscribe to a key or prefix and get pushed changes, with no polling.
- **Leases:** a key tied to a lease disappears if its holder stops renewing. That's liveness detection, used for [owner failover](/distributed-cache/consistency/#when-the-owner-dies).
- **Increasing revisions** on every change, usable as fencing tokens.

What it's **not** for: anything on the request path, or big or busy data. etcd is built for small values and modest write rates, with a default request limit of 1.5 MiB and a default storage quota of 2 GiB (8 GiB suggested as a maximum). And it **stores and notifies; it doesn't decide**. A separate process (an operator, autoscaler or hot-key detector) decides and writes the result. Kubernetes is built on the same split, with etcd as its store.

## The three options

### A: The client library holds the ring

```text
app server [library: hash(group:42) → shard C] ──▶ shard C
```

- **Per request:** one hop. The shard is computed in memory.
- **Adding a shard:** the ring in etcd changes; every client's watch fires and updates it. Briefly, some clients have the old ring.
- **Costs:**
  - The routing logic lives in **every client**. A bug fix or feature means redeploying every service that uses the cache, and every language needs a library that hashes identically.
  - Every client connects to every shard: 2,000 app servers × 20 shards = 40,000 connections.

Memcached works this way: the servers know nothing about each other, and clients hash over a configured server list.

### B: A proxy tier holds the ring

```text
app server ──▶ proxy [hash(group:42) → shard C] ──▶ shard C
```

- **Per request:** two hops, adding a fraction of a millisecond.
- **Adding a shard:** only the proxies need the new ring.
- **Gains:**
  - Routing changes roll out **in one place**.
  - **Pooled connections:** many clients share each proxy's connections to the shards. This was a main reason Twitter built Twemproxy.
  - Clients are simple and language-independent.
  - One place for extras: copies of hot keys, failover rules, metrics. Facebook's mcrouter does many of these.
- **Costs:** an extra hop on every request, and **a new tier to run and scale**. If all proxies fail, the cache is unreachable.

### C: The nodes hold the map (Redis Cluster)

```text
app server [cached slot map] ──▶ shard C
                                 (wrong shard? "MOVED → shard D": update map, retry)
```

- **Per request:** one hop. Cluster-aware clients cache the map they learned from the nodes.
- **Adding a shard:** the cluster moves slots between nodes, and nodes spread the new layout by **gossip**. A client that asks the wrong node gets a `MOVED` redirect, updates its map, and retries. No external store.
- **Costs:**
  - Keys map to **16,384 fixed hash slots** (CRC16 of the key), not to your own ring, so there are no hand-placed virtual nodes.
  - **Multi-key commands** (`MGET`, transactions) only work when all keys share a slot. *Hash tags* such as `{group:42}:members` force that.
  - Clients still need to understand redirects.

## Side by side

| | A: client library | B: proxy | C: nodes (Redis Cluster) |
|---|---|---|---|
| Hops per request | 1 | 2 | 1 (2 just after a change) |
| Who updates on a ring change | Every client (via etcd) | Proxies only | Nodes; clients learn from redirects |
| Rolling out a routing change | Redeploy every service | Redeploy proxies | Upgrade Redis |
| Connections | Clients × shards | Clients × proxies + proxies × shards | Clients × shards |
| Extra parts to run | etcd | Proxy tier | None |
| Control over placement | Full | Full | Redis's slots only |

**How to choose:**
- **Few services, latency matters, a coordination service already runs:** **A**.
- **Many services or languages, a huge client fleet, routing changes rolled out centrally:** **B**.
- **A sharded cache quickly, and Redis's rules are acceptable:** **C**.

In the interview, give the choice *and* the condition that would change it: **"A client library with the ring from etcd: one hop, no new tier, since our only clients are our own services. If many teams in different languages adopted the cache, I'd move routing into a proxy tier."**

## How gossip scales

A common belief is that gossip needs every node to talk to every other node, so it can't scale. It doesn't. In a gossip protocol, each node contacts **a few random peers** per round and swaps what it knows: which nodes exist and are alive, with version numbers. News spreads like a rumour and reaches everyone in **about log(n) rounds**, while each node's cost per round stays the same however large the cluster gets.

| Nodes | Full mesh connections, n(n−1)/2 | Gossip messages per round (3 peers each) |
|---|---|---|
| 10 | 45 | 30 |
| 100 | 4,950 | 300 |
| 1,000 | ~500,000 | 3,000 |

Membership protocols such as SWIM, which Consul's gossip is based on, work this way.

**Redis Cluster is the exception that proves the point.** Each node keeps a TCP connection to **every** other node on its cluster bus, so its overhead grows with n², and its documentation puts the design limit around **1,000 nodes**. That's quadratic, not catastrophic, and far beyond a cache of tens of shards.

## Sources
- [etcd: System limits](https://etcd.io/docs/v3.5/dev-guide/limit/) (1.5 MiB requests; 2 GiB default quota, 8 GiB suggested maximum)
- [etcd: KV API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/) and [etcd API](https://etcd.io/docs/v3.5/learning/api/) (Raft, linearizable reads, revisions, watches, leases)
- [Kubernetes: Cluster Architecture](https://kubernetes.io/docs/concepts/architecture/) (etcd as the backing store for all cluster data)
- [Memcached: Performance](https://docs.memcached.org/serverguide/performance/) (one event loop per worker thread; clients pick the server by hashing)
- [Twemproxy (GitHub)](https://github.com/twitter/twemproxy) ("built primarily to reduce the number of connections to the caching servers")
- [mcrouter (GitHub)](https://github.com/facebook/mcrouter) and [mcrouter: Pools](https://github.com/facebook/mcrouter/wiki/Pools) (connection pooling, replicated pools, consistent hashing)
- [Nishtala et al.: Scaling Memcache at Facebook (NSDI 2013)](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala) (leases against stale sets and thundering herds; mcrouter)
- [Redis: Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/) (16,384 slots, full mesh cluster bus, gossip, ~1,000 nodes, `MOVED`, multi-key commands within one slot)
- [Consul: Gossip](https://developer.hashicorp.com/consul/docs/concept/gossip) (membership and failure detection by gossip, based on SWIM)
- [Das, Gupta, Motivala: SWIM (DSN 2002)](https://courses.grainger.illinois.edu/cs425/fa2022/dsn02-SWIM.pdf) (constant load per member; spread time grows logarithmically)
