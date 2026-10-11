---
title: Cache levels
description: The layers a request can be answered at, from the user's device to the database, and three rules for reasoning about them (hit rates multiply, closer means harder to invalidate, staleness adds up).
sidebar:
  order: 3
---

"Levels" of cache means the layers a request can be answered at, on its way from the user to the database. Each layer catches some requests, so fewer reach the next one. The names L1/L2 are borrowed from **CPU caches** (L1, L2, L3, then RAM). The idea is the same: small and fast close to whoever uses the data, big and slower further away.

```text
phone/browser ─▶ CDN edge ─▶ edge proxy ─▶ app server memory ─▶ distributed cache ─▶ database
   (client)       (edge)      (gateway)      (local, "L1")       (shared, "L2")      (its own caches)
```

| Level | Example | Read latency | Size | Shared by | Main problem |
|---|---|---|---|---|---|
| **Client** | App's local database, browser HTTP cache | ~0 (no network) | MB–GB per device | One user | You can't reach in and clear it |
| **CDN / edge** | Cloudflare, CloudFront | ~10–30 ms from the user, vs 100+ ms to a distant origin | Huge, disk-backed | Everyone near that site | Only for public content, or content that's the same for many users |
| **Edge proxy / gateway** | Nginx or Varnish response cache | ~1 ms within the site | GB | All users through that proxy | Must know which responses are safe to share |
| **In-process (L1)** | A map inside each app server | ~100 ns | MB to a few GB | One server | Every server has its own copy, and copies disagree |
| **Distributed (L2)** | Redis, Memcached | ~0.5 ms (one network round trip) | TB across many nodes | All app servers | Network hop, partitioning, node failures |
| **Database's own** | Buffer pool, OS page cache | ~1 ms from memory, more from disk | Server RAM | Automatic | Not under your control |

Latencies are orders of magnitude, not measurements.

## Three rules

**1. Each level only sees what the level before it missed, so hit rates multiply.**

```text
L1 hit rate 80%   → 20% of reads go to the distributed cache
L2 hit rate 95%   → 20% × 5% = 1% reach the database
```

This is why a small L1 is so effective against a **hot key**. Each app server answers it from its own memory, so the one cache node holding it isn't swamped.

**2. The closer to the user, the more copies, and the harder it is to invalidate.**
- Database: one copy.
- Distributed cache: one per key, plus replicas.
- L1: one per app server, possibly hundreds.
- Devices: one per device, possibly millions.

Each level stays stale until its TTL runs out or an invalidation reaches it. So the near levels get **short TTLs** (L1: seconds), and only data that may be stale goes far out.

**3. Staleness adds up along the path.** An L1 entry with a 10 s TTL, filled from a distributed-cache entry that was already 60 s old, can show data 70 s old. To answer "how stale can it get?", add up the TTLs along the path.

## Worked example: a messaging app

| Data | Where it's cached | Why |
|---|---|---|
| Contacts' profiles | **On the phone**, refreshed when a profile changes | Rarely changes; the phone needs it on every screen |
| Profile photos | **CDN**, long TTL, new URL when the photo changes | Large and rarely changes; a new URL avoids invalidating the CDN |
| Group membership | **Owner server's memory (L1)**, plus the shared cache (L2) for loading | Checked on every message; must not be stale, so one authoritative copy decides ([consistency](/distributed-cache/consistency/)) |
| Everything | **Database** | Source of truth |

## What interviewers ask about levels

- **"Why not just make Redis bigger?"** Every request still pays a network round trip, and a hot key still lands on one node. L1 copies avoid both.
- **"A user changes their name. How long until everyone sees it?"** The sum of the TTLs along the path, or however quickly your invalidations reach each level.
- **"Which data would you keep out of the far levels?"** Anything where staleness is a correctness or privacy bug, such as permissions and membership. Keep it out of long-TTL levels, or invalidate it on every change.
