# Distributed Cache

Classic interview question: "Design a distributed cache" (Memcached/Redis-style). Design it on paper first, interview-style, then build the deep-dive parts in Go.

These are working notes.

## Lessons

Reader-facing pages (shown on the site under "Distributed cache"):
- `lessons/distributed-cache/design.md`: the interview design so far: scope, requirements split by consistency, estimates, architecture, decisions.
- `lessons/distributed-cache/cache-levels.md`: client → CDN → proxy → L1 → L2 → database; hit rates multiply; staleness adds up.
- `lessons/distributed-cache/consistency.md`: one authoritative owner, why not 2PC, leases and fencing, async replication and versions.
- `lessons/distributed-cache/partitioning.md`: consistent hashing, virtual nodes and cascades, power of two vs keyed data, ring changes, hot keys.
- `lessons/distributed-cache/routing.md`: client library vs proxy vs Redis Cluster; etcd as control plane; gossip.
- `lessons/distributed-cache/faq.md`: quiz-style follow-up questions.

Generic estimation method: `lessons/interview-skills/estimates.md`.

Still to write after the build: eviction and expiry, stampedes, a lab page and a cheat sheet.

## Part 1: Interview design (on paper, in this README)

Run as a mock interview: the candidate drives, the interviewer pushes with follow-ups. Answers get written up under "Notes" as we go.
- [x] **Requirements**: get / set / delete, TTL per key. Non-functional: very low latency, high availability (over strong consistency?), scales horizontally. Scale assumptions (QPS, size of hot data, value sizes).
- [x] **Estimates**: nodes needed by memory and by QPS; network bandwidth.
- [ ] **API**: get/set/delete with TTL, batch get.
- [x] **Where routing lives**: client library, proxy (Twemproxy, mcrouter), or the cache nodes themselves.
- [ ] **Caching patterns**: cache-aside, read-through, write-through, write-behind; how writes invalidate.
- [ ] **High-level design**: clients → routing → cache nodes, database behind.
- [x] **Data model per node**: hash map + eviction structure, expiry.
- [ ] **Deep dives**: partitioning (mod N vs consistent hashing, virtual nodes), eviction (LRU/LFU), TTL expiry (lazy vs active), replication and failover, hot keys, cache stampede, stale data races, multiple regions.

## Part 2: Build the deep dives (Go)

The build is arranged so we *discover* why each piece is needed.

- [ ] 1. **One node**: HTTP key-value server, `map` + `sync.RWMutex`. Get and set with curl.
- [ ] 2. **Eviction and TTL**: memory cap with LRU (`container/list` + map, built ourselves), lazy + periodic expiry. Fill past the cap and watch old keys go.
- [ ] 3. **Cache-aside in front of a slow DB**: fake DB with ~50 ms latency; measure hit rate and latency with `../traffic-generator`.
- [ ] 4. **Three nodes, `hash(key) % N`**: client-side routing. Add a fourth node: most keys move, and the DB takes a miss storm.
- [ ] 5. **Consistent hashing ring** with virtual nodes: add/remove a node and only ~1/N of keys move; compare key balance with and without virtual nodes.
- [ ] 6. **Stampede and hot keys**: a popular key expires and many requests hit the DB at once. Fix with request coalescing (our own singleflight) and TTL jitter; optionally a small local cache for hot keys.
- [ ] 7. **Node failure and replication**: kill a node; then also write to the next node on the ring and fail reads over. Consistency trade-off.
- [ ] 8. *(Optional)* **Invalidation race**: delete-on-write vs update-on-write; reproduce the stale-set race; fix with leases or versions.
- [ ] 9. **Interview cheat sheet**: the short version plus follow-up answers.

Related: the rate limiter and chat system both use Redis as a shared store; this experiment is what's inside one. Load comes from `../traffic-generator`.

Ports: fake DB **8100**, cache nodes **8101–8104** (check with `lsof -i :<port>` first).

## Notes

### Mock interview, warm-up (2026-10-08)

The first round drifted into the chat system's user → server map (notes in `../chat-system/README.md`). What carries over to the cache:

- **Scope it first.** "Cache" can mean a small, hot metadata map (fits on one box, really cluster membership: etcd/ZooKeeper) or a large data cache (too big for one node). The interview question is the second. Media (MB-sized blobs) is out: object storage + CDN, not RAM.
- **Capacity of one instance = budget ÷ cost per request, for each resource; the lowest wins.** For a ~100 B Redis `GET`:
  - CPU: ~5–10 µs per request, mostly `read`/`write` syscalls and protocol parsing, so ~100k–200k ops/s on one thread. The hash lookup itself is under 1 µs.
  - Network: ~300 B per request + reply, so 100k/s ≈ 0.24 Gbit/s, nowhere near a 10 Gbit/s link.
  - `epoll` lets one thread *watch* many sockets but doesn't make each syscall cheaper. Fixes: pipelining/batching (`MGET`, ~1M ops/s), more cores (Redis 6 I/O threads, Memcached threads), more instances, or a local cache in the client.
- **Little's law:** in flight = throughput × latency. One blocking connection at 0.5 ms round trip maxes out at 2k req/s.
- **Get QPS from actions, not from concurrent users:** users × actions per day ÷ 86,400 × peak factor. Concurrent users ≠ requests per second.
- **Count reads and writes separately.** Replicas add read capacity only; writes need more shards.
- **Plan at ~60% of one instance's capacity** to leave room for spikes (reconnect storms, a hot key).
- **Prefer "on event" over "on a timer"** when the common answer is "nothing changed" (polling, per-key TTL refresh).

### Mock interview, round 2: profile and group membership cache (2026-10-09)

Scenario: messaging app, 2B users, 500M groups; the database can't take the read load.

**Cache levels.** Client → CDN → edge proxy → in-process L1 → distributed L2 → the database's own caches. Each level sees only the previous level's misses (hit rates multiply). Closer means more copies and harder invalidation. Worst-case staleness = the sum of TTLs along the path.

**Requirements and consistency, split by data:**
- *Profiles:* cached on the phone, so server reads are rare (refresh on change, new device, new chat). Eventual consistency is fine.
- *Group membership (and block lists):* checked server-side on every group message. Staleness is a privacy bug: a removed member must not get the next message. Needs strong consistency.

**Estimates:**
- Memberships: 500M groups × ~40 average members ≈ 20B. One key per membership ≈ 2 TB; **one set per group** (8 B user IDs) ≈ 500M × ~420 B ≈ 210 GB. The data model is a 10× memory lever.
- Size the cache for the *working set* (active groups), not everything.
- Membership checks ≈ 1M/s peak, but they're served from the group owner server's memory; the shared cache mostly serves loads and takeovers. Memory decides: a handful of shards, each with a replica.
- Server count = max(memory ÷ RAM per node, ops ÷ ~60% of ops per node).

**Ordering and the source of truth:**
- "After the removal" only means something if **one place orders a group's events**: a group owner server, chosen by partitioning on group ID.
- Remove blocks until durable (DB/log) and applied by the owner. Caches are updated after, by write-through or invalidation, and carry a **version**.
- Don't update all caches in one distributed transaction: 2PC blocks on the slowest or a dead participant (or a crashed coordinator), and Redis has no cross-node transactions. Make one copy authoritative and let the others lag, versioned.
- Owner failover: a lease in etcd/ZooKeeper; the group's messages *pause* until the lease expires (consistency over availability); the next owner loads from DB, or from the cache after a version check; **fencing tokens** stop a paused old owner (GC pause, network split).
- Reads from primaries only; replicas are for failover. Redis replication is async (`WAIT` narrows but doesn't close the gap), so failover can lose cache writes. That's safe because the version check catches it.

**Partitioning:**
- Consistent hashing with virtual nodes. Power of two choices needs *freedom of choice*; a keyed read has none (the key lives on one server). The variant that works: two hash-determined candidates (`h1`, `h2`), storing the key on both or reading both. Worth it only for hot keys.
- Virtual nodes fix the **domino effect**: without them, a dead node's whole range goes to one successor, which overloads and dies in turn. With them, the load spreads across all survivors. The remaining cascade risk is DB load from the misses (fix: replicas, request coalescing, limiting DB load).
- Adding a shard: ~1/N of keys move, taken evenly from all shards (`hash % N`: ~80% for 4 → 5). Moved keys start as misses. Virtual node positions can be chosen to unload a busy shard; then the ring with explicit positions lives in the registry.
- Rings briefly differ during changes: misses, stale reads, and **stale data resurfacing** if a key moves back to its old shard. Fix with versions, TTLs, or clearing the range on ownership change.
- Hot keys: virtual nodes don't help (one key = one point on the ring). L1, hot-key copies or key splitting do. Start with L1; add copies only when measured.

**Hot-key splitting (salting):**
- Read-hot: every suffix (`group:42#0..3`) holds a full copy; readers pick one at random. Write-hot (counters): each suffix holds a part; readers sum.
- Track which keys are split in a small **hot-key table in the registry** (`{"group:42": 4}`), watched by clients like the ring. Fill it by sampling (count-min sketch / top-K) or manually. Or use a **rule** with nothing to track ("groups over 500 members split 4 ways").
- Don't store the split count in the base key: reading it is the hot read again.
- While views differ: reads pick from their own view; writes and invalidations hit the **union** of old and new copies. Every write costs N, so only for read-heavy keys.

**etcd (control plane vs data plane):**
- etcd/ZooKeeper/Consul holds small metadata everyone must agree on: ring and shard list, hot-key table, owner leases, fencing epochs. Raft consensus, watches, leases, increasing revisions.
- Never on the request path: clients keep the ring in memory and update it from watches. Not for big or busy data (~1.5 MiB request cap, GB-scale store).
- etcd stores and notifies; separate processes decide (detector, autoscaler, operator).

**Gossip:** not n! and not a full mesh. Each node contacts a few random peers per round; news reaches everyone in ~log(n) rounds; per-node cost stays flat (Cassandra, Consul/SWIM). Redis Cluster *does* keep a full mesh on its cluster bus (n(n−1)/2 connections), and its docs put the design limit around 1,000 nodes. Not a concern at tens of shards.

**Where the ring lives (decided: client library + etcd):**
- *Client library:* 1 hop; every client watches etcd; routing changes mean redeploying every service; clients × shards connections.
- *Proxy tier* (Twemproxy, mcrouter): 2 hops; only proxies update; central rollout; connection pooling; a new tier to scale and keep alive.
- *Nodes + redirects* (Redis Cluster): 1 hop (2 after a change); no external store; Redis's 16,384 fixed slots, so no hand-placed virtual nodes; multi-key commands only within one slot.
- Our pick: client library with the ring from etcd. One codebase, already running etcd, one hop on the owner-load path. Switch to a proxy tier if many teams and languages start using the cache.

**Still open in Part 1:** API, caching patterns in full, eviction and TTL policy, high-level diagram.

## What we learned
