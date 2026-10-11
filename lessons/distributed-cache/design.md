---
title: Designing a distributed cache
description: The interview question worked through on a concrete case (profiles and group membership for a messaging app), from scoping to partitioning, with the decisions and why.
sidebar:
  order: 1
---

"Design a distributed cache" (something like Memcached or Redis) is a classic interview question. Asked in the abstract it's hard to get traction, so this page works through a concrete case: the cache behind a messaging app's **user profiles** and **group membership lists**. Each section links to a page with the full reasoning.

## What an interviewer expects you to cover

- **Scope:** which data, why it needs a cache, what's out of scope.
- **Requirements**, split by data: how stale may each kind be?
- **Estimates:** memory *and* operations per second, from user actions.
- **High-level design:** clients, cache shards, database, and the small control plane that holds the cluster's configuration.
- **Deep dives:** consistency and failover, partitioning, hot keys, where routing lives. Eviction, expiry and stampedes come up too.

## Scope it first

"Cache" covers very different workloads. Saying which one you're designing is the first good move:

| Workload | Shape | What it really is |
|---|---|---|
| Small, hot metadata (which servers exist, who owns what) | MB to a few GB, rarely changes, everyone needs a copy | Cluster membership: a coordination service like etcd, not a cache |
| **Large data cache** (profiles, membership lists, sessions) | Too big for one node, small values, read-heavy | **The interview question** |
| Media (photos, video, attachments) | MB-sized blobs | Object storage + CDN, not RAM |

## The scenario

A messaging app with **2 billion users** and **500 million groups**. The database can't take the read load. What reads it?

- **Profiles** (name, photo URL, status, privacy settings). Phones cache their contacts' profiles, so the server sees reads only on refresh: a profile changed, a new device, a new chat. The rate is low.
- **Group membership.** The server checks it on **every group message**, so a removed member can't keep posting or receiving. This is the read-heavy part.
- **Block lists:** checked on 1:1 messages. Small per user, with the same needs as membership.

## Requirements: consistency depends on the data

| Data | Stale for a minute? | Consistency needed |
|---|---|---|
| Profiles | Harmless | **Eventual.** Cache everywhere, long TTLs |
| Membership, block lists | **A privacy bug:** a removed member gets the next message | **Strong** at the point where delivery is decided |

Splitting the requirements by data, rather than declaring one consistency level for the whole cache, is what interviewers look for.

## Estimates

Method: [Back-of-the-envelope estimates](/interview-skills/estimates/).

- **Memory.** 500M groups × ~40 members on average ≈ 20B memberships.
  - One key per membership at ~100 B ≈ **2 TB**.
  - **One set per group** holding 8-byte user IDs: 500M × ~420 B ≈ **210 GB**.
  - The data model is a 10× lever. The cache only needs the **working set**, the active groups, which is smaller still.
- **Operations.** Membership checks are ~1/3 of ~3M messages/s at peak ≈ **1M/s**. But they're served from the memory of the server that owns each group (below), so the shared cache mostly serves *loads*: a group's first message, or a takeover after a crash.
- **Servers** = the larger of (memory ÷ RAM per node) and (ops/s ÷ ~60% of one node's capacity). Here memory decides: a handful of shards, each with a replica.

## High-level design

```text
                      control plane: etcd
          ring (shard list) · hot-key table · owner leases · fencing epochs
                │ watch                                  │ lease
                ▼                                        ▼
chat servers ──▶ group owner server (one per group, by hash of group ID)
                 · orders the group's messages and membership changes
                 · keeps the member list in memory (L1)
                │ on load / takeover: GET group:42 (+ version)
                ▼
      cache shards (primaries; replicas for failover only)
      one set per group: group:42 → {user IDs}, version
                │ miss
                ▼
             database (source of truth)
```

## Key decisions

- **One authoritative copy decides delivery.** Each group has an owner server that applies its events in order. Caches elsewhere may lag, because they carry a version and aren't used to decide who receives a message. Not a distributed transaction across caches. [Consistency and failover](/distributed-cache/consistency/)
- **Failover pauses rather than guesses.** A crashed owner's groups wait a few seconds for a new owner to take the lease. Fencing tokens stop the old one if it was only paused. [Consistency and failover](/distributed-cache/consistency/#when-the-owner-dies)
- **Reads go to primaries; replicas are for failover only.** Replication is asynchronous, so failover can lose cache writes. The version check makes that safe. [Consistency and failover](/distributed-cache/consistency/#replicas-and-lost-writes)
- **Consistent hashing with virtual nodes.** A key has one home, so readers find it deterministically, and a dead shard's load spreads over all survivors. [Partitioning and hot keys](/distributed-cache/partitioning/)
- **Hot keys:** the owner's in-memory copy first; extra copies of a hot key only if measurements show a hot shard. [Partitioning and hot keys](/distributed-cache/partitioning/#hot-keys)
- **The ring lives in a client library and is fed from etcd.** One hop per request, and no new tier, because the cache's only clients are our own services. Move to a proxy tier if many teams and languages adopt it. [Where routing lives](/distributed-cache/routing/)
- **Levels:** phones cache profiles, a CDN serves photos, owners keep an L1, and the shared cache is L2. [Cache levels](/distributed-cache/cache-levels/)

## Still to come

Eviction (LRU vs LFU), TTL expiry, cache stampedes, and the read and write patterns (cache-aside, write-through, write-behind) get their own pages when the lab reaches them.

## Sources
- [TechCrunch: WhatsApp is now delivering roughly 100 billion messages a day](https://techcrunch.com/2020/10/29/whatsapp-is-now-delivering-roughly-100-billion-messages-a-day/) (2020)
- [Redis: Memory optimization](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/) (sets of integers use up to 10× less memory)
