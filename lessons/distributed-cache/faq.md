---
title: Distributed cache FAQ
description: Quiz yourself on distributed cache follow-up questions. Try answering before opening each one.
sidebar:
  order: 7
---

**Try answering each one out loud before opening it.** Each answer is short and links to the full explanation.

## Scope and sizing

<details>
<summary>Should media attachments go in the distributed cache?</summary>

No. Multi-megabyte values waste RAM, and on Redis they hold up the single command thread while being copied. Media goes in object storage behind a CDN. The in-memory cache is for small values read often: profiles, membership lists, sessions.

**More:** [Scope it first](/distributed-cache/design/#scope-it-first)
</details>

<details>
<summary>200M entries of ~100 bytes fit on one Redis server. Is one server (plus a standby) enough?</summary>

Only if the request rate also fits. Memory is one limit and operations per second is the other. One Redis instance does roughly 100k–200k simple operations per second without pipelining, so a million lookups per second needs batching, more instances, or a local cache in front.

**More:** [How much can one server take?](/interview-skills/estimates/#how-much-can-one-server-take)
</details>

<details>
<summary>How can the same membership data need 2 TB or 210 GB?</summary>

It depends on the data model. One key per membership pays the per-key overhead 20 billion times. One set per group, holding 8-byte user IDs, pays it 500 million times. And the cache only needs the working set: the groups active right now.

**More:** [Estimates](/distributed-cache/design/#estimates)
</details>

## Consistency

<details>
<summary>Why not update every cache holding a member list in one transaction?</summary>

That needs two-phase commit across all copies. The slowest or an unreachable copy blocks every update, a coordinator crash leaves locks held, and cache servers don't support it anyway. Instead, make one copy authoritative (the group's owner server decides delivery) and let the other copies lag, carrying a version number.

**More:** [Don't update every cache in one transaction](/distributed-cache/consistency/#dont-update-every-cache-in-one-transaction)
</details>

<details>
<summary>A group's owner server crashes. Why not keep delivering with the last cached member list?</summary>

That chooses availability over consistency. The dead owner may have accepted a removal that some caches never saw, and several servers delivering at once loses the ordering. Instead, pause the group's messages until a new owner holds the lease and reloads the persisted list. That takes a few seconds.

**More:** [When the owner dies](/distributed-cache/consistency/#when-the-owner-dies)
</details>

<details>
<summary>What is a fencing token for?</summary>

It protects against an owner that only *seemed* dead: a long garbage-collection pause or a network split. Each new lease comes with a larger number. Writes carry it, and storage rejects writes with an older one, so the paused old owner can't act alongside the new one.

**More:** [When the owner dies](/distributed-cache/consistency/#when-the-owner-dies)
</details>

<details>
<summary>Reads only go to primaries. Can a failover still serve stale data?</summary>

Yes. Redis replicates asynchronously, so a write the primary acknowledged may not have reached the replica that gets promoted. `WAIT` narrows the gap but doesn't close it. That's safe when entries carry versions and anything correctness-critical is checked against the source of truth.

**More:** [Replicas and lost writes](/distributed-cache/consistency/#replicas-and-lost-writes)
</details>

## Partitioning and hot keys

<details>
<summary>Power of two choices works well for load balancing. Why not use it to pick a cache shard?</summary>

A cache read has to reach the one shard that holds the key, so there's nothing to choose between. Power of two needs any server to be able to answer. The variant that works uses two *hash-determined* locations for the same key, and it's worth it only for hot keys.

**More:** [Keyed data has no freedom of choice](/distributed-cache/partitioning/#keyed-data-has-no-freedom-of-choice)
</details>

<details>
<summary>How do virtual nodes prevent a cascading failure?</summary>

Without them, a dead node's whole range passes to its one successor, which can overload and fail in turn. With many virtual nodes per shard, the dead shard's small arcs pass to many different successors, so the load spreads across all survivors.

**More:** [Virtual nodes](/distributed-cache/partitioning/#virtual-nodes-even-spread-and-no-cascade)
</details>

<details>
<summary>Can placing virtual nodes cleverly fix a hot key?</summary>

No. One key hashes to one point, so it always lives on one shard, with that shard's capacity as its ceiling. Only copies split one key's load: an L1 in the caller, two hash-determined copies, or key splitting (`key#0..N`).

**More:** [Hot keys](/distributed-cache/partitioning/#hot-keys)
</details>

<details>
<summary>With key splitting, how do clients know a key has been split?</summary>

From a small hot-key table stored with the ring and watched by clients, or from a rule such as "groups over 500 members split 4 ways." Not from the base key itself, because reading it would be the hot read again. During a change, writes must reach the union of old and new copies.

**More:** [Keeping track of which keys are split](/distributed-cache/partitioning/#keeping-track-of-which-keys-are-split)
</details>

## Routing

<details>
<summary>Client library, proxy, or Redis Cluster: what's the main trade-off?</summary>

Where the routing logic lives, and so what a change costs. A library gives one hop, but every service must be redeployed to change it. A proxy rolls out centrally and pools connections, but adds a hop and a tier to run. Redis Cluster needs no extra parts, but you take its fixed slots and its rules for multi-key commands.

**More:** [Where routing lives](/distributed-cache/routing/)
</details>

<details>
<summary>Does gossip need a connection between every pair of nodes?</summary>

No. Each node contacts a few random peers per round, and news reaches everyone in about log(n) rounds at a fixed cost per node. Redis Cluster does keep a full mesh, so its overhead grows with n², and it's designed for up to about 1,000 nodes.

**More:** [How gossip scales](/distributed-cache/routing/#how-gossip-scales)
</details>

<details>
<summary>Should the cache client read the ring from etcd on every request?</summary>

No. etcd is the control plane. Clients load the ring once, keep it in memory, and update it when a watch fires. A cache request never touches etcd.

**More:** [Control plane and data plane](/distributed-cache/routing/#control-plane-and-data-plane)
</details>
