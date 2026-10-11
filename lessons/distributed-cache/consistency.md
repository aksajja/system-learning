---
title: Consistency and failover
description: Keeping a cached permission (group membership) correct. One authoritative copy instead of a distributed transaction, leases and fencing for failover, and why async replication is safe with versions.
sidebar:
  order: 4
---

Most cached data can be a little stale. Some can't. This page uses the hardest case from the [design](/distributed-cache/design/), **group membership in a messaging app**, to show how a cache stays out of the way of correctness.

## The requirement

An admin removes Carol from a group at 12:00:00.000. Alice sends a message at 12:00:00.050. Carol must not receive it.

If any server decides delivery from a cached member list that still contains Carol, she gets the message: **a privacy bug, not a performance blip.** Profiles don't have this problem, since a name a minute out of date harms no one. So consistency is decided **per kind of data**, not once for the whole cache.

## "After" needs one place that orders events

"The message after the removal" only means something if one place puts the group's events in order. If the removal is handled by one server and Alice's message by another, each can believe it came first.

So each group gets an **owner server**: partition on group ID (e.g. consistent hashing over a pool of servers), and route all of that group's messages *and* membership changes through its owner. The owner:
- applies `remove Carol`, then `Alice's message`, in sequence;
- holds the current member list in memory, effectively an L1 cache, and decides delivery from it.

A partition of an ordered log (e.g. a Kafka partition per group-ID range) gives the same property: one ordered stream per group.

## Make the removal blocking and durable

`remove` doesn't return to the admin until it's **written to the database or log** and **applied by the owner**. Every message ordered after that point uses the new list. Whatever was acknowledged survives a crash.

## Don't update every cache in one transaction

The tempting next step is "update every cache holding this list in one transaction." Updating many machines atomically needs a distributed transaction, usually **two-phase commit (2PC)**:
1. **Prepare.** A coordinator asks every participant to promise to commit, and each locks the entry.
2. **Commit.** Once all have promised, it tells them to commit.

The problems for a cache:
- **The slowest participant sets the pace.** One slow or unreachable replica blocks every removal.
- **A coordinator crash between the phases** leaves participants holding locks with no outcome. This is 2PC's well-known blocking problem.
- **Cache servers don't support it.** Redis has no transactions across nodes; in Redis Cluster, multi-key commands and `MULTI` only work on keys in one hash slot.
- **Each extra copy makes writes slower and less available.**

### Instead: one authoritative copy, the rest versioned

Only the **owner's in-memory list decides delivery**, so only that copy must be strongly consistent. Every other copy can lag safely:

| Copy | Used for | Consistency it needs | How it's updated |
|---|---|---|---|
| Database / log | Source of truth | Durable | Written *before* `remove` returns |
| **Owner's memory** | **Deciding delivery** | **Strong** (events applied in order) | Synchronously, as part of `remove` |
| Shared cache | Loading a group; the "group info" screen | Fresh enough to load from | Write-through or invalidated after `remove`; stores a **version number** |
| Other servers' L1 | Display only | Eventual | TTL or pushed invalidation |

The version number makes the shared cache safe to load from. A server taking over a group reads the cached list *with its version*, compares it with the latest version in the database (one cheap read), and reloads from the database if it's behind.

The rule: **don't make many copies agree atomically. Make one copy authoritative, and keep the others versioned and invalidated.** It's the same idea as single-leader replication in databases.

## When the owner dies

The owner crashes, and the in-memory lists for its groups go with it. The tempting shortcut is to have other servers carry on with their last cached copy. That **chooses availability over consistency**, and it breaks the guarantee:
- the dead owner may have accepted `remove Carol` without every cache seeing it;
- several servers delivering at once means nobody orders the group's events any more.

The standard failover keeps the ordering:

| Step | What happens | Why |
|---|---|---|
| **Lease** | The owner holds a lease on its groups in a coordination service (etcd, ZooKeeper) and renews it every few seconds | If it stops renewing, everyone learns it's gone |
| **Pause, don't guess** | Until the lease expires (seconds), messages for those groups wait in a queue, or senders retry | A short delay is acceptable for chat; a leaked message isn't |
| **Take over** | The next server (e.g. next on the hash ring) acquires the lease and loads the persisted list: from the database, or from the cache after a version check | It starts from the acknowledged truth |
| **Fence** | Each lease grant comes with an increasing number (a *fencing token*). Writes carry it, and storage rejects older numbers | The "dead" owner might only have paused (a long garbage-collection pause, a network split) and wake up still believing it's the owner. Without fencing, two owners act at once (*split brain*) |

In the interview: **"For membership I choose consistency over availability. If an owner dies, its groups pause for a few seconds until a new owner holds the lease and reloads the persisted list. Fencing tokens stop the old owner if it was only paused."**

## Replicas and lost writes

Reading only from each shard's **primary**, and keeping replicas for failover, means you never read a replica that's behind. The costs:
- Replicas add **no read capacity**. You size shard count by the primaries alone and pay for the replicas' memory just for availability.
- **Failover can still lose writes.** Redis replicates **asynchronously**: the primary acknowledges a write and copies it shortly after. If the primary dies in between, the promoted replica never got it. The `WAIT` command makes a write wait for N replicas to acknowledge it. That narrows the gap, but Redis's documentation says it doesn't make Redis strongly consistent.

That's acceptable *here* because the cache isn't the source of truth. A lost invalidation leaves an entry with an **old version**, the version check catches it, and the reader reloads from the database. The cache can lose writes without correctness being lost.

## An encryption backstop

In end-to-end encrypted group chats (the Signal protocol's group messaging, used by WhatsApp), remaining members replace their group encryption keys when someone leaves. So even a message wrongly delivered to a removed member can't be decrypted by them. See [end-to-end encryption](/misc/e2ee/). It's defence in depth, not a substitute for ordering.

## Sources
- [Redis: WAIT](https://redis.io/docs/latest/commands/wait/) (replication is asynchronous; `WAIT` doesn't make Redis strongly consistent)
- [Redis: Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/) (16,384 slots, full mesh cluster bus, gossip, ~1,000 nodes, `MOVED`, multi-key commands within one slot)
- [etcd: KV API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/) and [etcd API](https://etcd.io/docs/v3.5/learning/api/) (Raft, linearizable reads, revisions, watches, leases)
- [Martin Kleppmann: How to do distributed locking](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) (fencing tokens)
- [WhatsApp Encryption Overview (technical white paper)](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf) ("whenever a group member leaves, all group participants clear their Sender Key and start over")
