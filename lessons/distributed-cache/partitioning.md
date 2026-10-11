---
title: Partitioning and hot keys
description: How a client finds the shard that holds a key. Hash mod N vs consistent hashing, virtual nodes and cascading failures, why power of two choices doesn't fit keyed reads, ring changes, and splitting hot keys.
sidebar:
  order: 5
---

Once the data is too big or too busy for one node, it's split across **shards**. Every client must then answer one question for each request: **which shard holds this key?**

## Keyed data has no freedom of choice

For [load balancing](/load-balancer/algorithms/), *power of two choices* (pick two servers at random, use the less busy one) is the modern favourite. It works when **any** server can handle the request: placing a new chat connection, sending an HTTP request to a stateless backend.

A cache read is different. `group:42` lives on **one** shard, and only that shard can answer. Picking at random almost always picks a shard that doesn't have the key. So keyed data needs a **deterministic function from key to shard** that every client computes the same way: a hash.

The test is not stateless vs stateful. It's **"does this request have to reach one specific server?"**

## `hash(key) % N`, and why it breaks

The obvious function is `shard = hash(key) % N`. It spreads keys evenly, but changing N moves almost everything: going from 4 to 5 shards changes the shard for about **80%** of keys. In a cache, a moved key is a **miss**, so adding capacity suddenly sends most reads to the database.

## Consistent hashing

Place the shards on a circle of hash values (a *ring*). To find a key's shard, hash the key onto the ring and walk clockwise to the first shard. Adding a shard takes over only the arc just before it, so only about **1/N of keys move**.

A lookup is a binary search over the sorted shard positions, done in the client's memory.

### Virtual nodes: even spread, and no cascade

With one position per shard, arcs come out uneven, and there's a worse problem: a **cascading failure**.

```text
ring without virtual nodes:  A → B → C → D → (back to A)
B dies → all of B's keys go to C → C takes 2× load → C dies → D takes 3× load → …
```

**Virtual nodes** give each shard many positions (say 100–200), hashed from names like `B#0 … B#199`. Then:
- arcs average out, so each shard holds about the same number of keys;
- when B dies, each of its small arcs passes to a **different** successor, so B's load spreads across **all** surviving shards instead of hitting one.

When a shard is added, its virtual nodes land all around the ring, and it takes about 1/N of keys **evenly from every existing shard**.

Positions don't have to be random. You can choose them to take load off a busy shard (Cassandra can allocate positions to balance load). Then clients can't compute the ring from the shard list alone, so **the ring itself, with explicit positions, must be stored** where clients read it ([where routing lives](/distributed-cache/routing/)).

### When clients briefly disagree about the ring

A ring change reaches clients at slightly different times. For a moment, two clients may look for the same key on different shards:
- **Misses:** the new owner doesn't have the key yet. Brief and harmless.
- **Stale reads:** a client with the old ring reads the old shard's copy, which may have missed an invalidation sent to the new owner.
- **Stale data resurfacing:** a key moves from A to new shard E. Later E is removed and the key moves back to A, where the old copy is still sitting. It missed every invalidation sent while E owned the key.

Fixes: **version numbers** on entries (a reader that needs freshness checks the version against the source of truth), **TTLs** so old copies don't live long, or **clearing a key range** on a shard when it loses ownership.

### What remains of the cascade risk

Virtual nodes stop the cascade *between cache shards*. The remaining risk is **behind the cache**: a dead shard's keys all miss at once, and the database gets that shard's share of traffic. The mitigations:
- a replica takes over, so the keys aren't lost;
- **request coalescing**: many concurrent misses on one key become one database read;
- limiting how fast misses can reach the database. Facebook's memcache uses **leases**, which both prevent stale sets and stop a herd of misses on one key.

## Hot keys

Consistent hashing spreads **keys**, not **load**. One key hashes to one point on the ring, so a viral key always lands on one shard, however the virtual nodes are placed. Arranging virtual nodes can give a hot key a shard to itself, but its traffic is still capped at **one shard's capacity**. To split one key's load:

| Technique | How | Cost |
|---|---|---|
| **L1 in the caller** | Each app server keeps the hot key in memory for a few seconds | Staleness up to the TTL; copies on many servers |
| **Two hash-determined copies** | Store the key at `h1(key)` and `h2(key)`; read from the less loaded one. This *is* power of two choices, made deterministic | 2× memory and 2× invalidations for those keys |
| **Key splitting ("salting")** | Store copies as `key#0 … key#N-1`; readers pick one at random | Every write or invalidation goes to N copies |

A related idea, **consistent hashing with bounded loads** (Google), caps each server at a little above the average load and passes overflow keys along the ring.

Start with L1, and add the others only when measurements show a hot shard. Each one costs extra writes.

### Keeping track of which keys are split

Readers must know that `group:42` is split into 4. Options:
- **A hot-key table** stored with the ring (`{"group:42": 4}`), which clients watch the same way they watch the ring. It's filled by sampling request counts (e.g. a count-min sketch or a top-K counter on cache nodes or clients), or by hand for known events. Redis can report hot keys itself (`redis-cli --hotkeys`) when it uses an LFU eviction policy.
- **A rule, so there's nothing to track:** e.g. "groups over 500 members are always split 4 ways." Any client that knows the group's size can work it out.
- **Not** a split count stored in the base key. Every reader would read the base key first, and that's the hot read again.

While clients' views differ: **reads** pick a copy from their own view; **writes and invalidations** must reach the **union** of old and new copies.

*Read-hot vs write-hot:* for a read-hot key, every split copy holds the full value. For a write-hot counter (likes, views), each split holds **part** of the count: writers add to a random part, and readers sum all parts.

## Sources
- [Karger et al.: Consistent Hashing and Random Trees (STOC 1997)](https://dl.acm.org/doi/10.1145/258533.258660), the original consistent hashing paper
- [Cassandra: cassandra.yaml](https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/cass_yaml_file.html) (`allocate_tokens_for_keyspace`: choosing token positions to balance load)
- [Google Research: Consistent Hashing with Bounded Loads](https://research.google/blog/consistent-hashing-with-bounded-loads/)
- [Nishtala et al.: Scaling Memcache at Facebook (NSDI 2013)](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala) (leases against stale sets and thundering herds; mcrouter)
- [Redis CLI](https://redis.io/docs/latest/develop/tools/cli/) (`--hotkeys` needs an LFU `maxmemory-policy`)
