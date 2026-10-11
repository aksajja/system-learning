---
title: Back-of-the-envelope estimates
description: How to estimate the load a system gets, what one server can take, and how many servers that means. Includes the usual mistakes and a table of numbers worth knowing.
sidebar:
  order: 1
---

Every design interview has an estimates step. It needs two numbers: **how much load the system gets**, and **how much one server can take**. The servers you need follow from those. The arithmetic is simple. The skill is choosing the right quantities and saying your assumptions out loud.

## How much load will you get?

### Requests come from actions, not from users

**Concurrent users are not requests per second.** 200M connected users doesn't mean 200M requests a second, because an idle user may send nothing. Work from what users *do*:

```text
QPS = users × actions per user per day ÷ 86,400 s × peak factor
```

Example: messages for a WhatsApp-sized app, at about 100 billion messages a day:

```text
100B ÷ 86,400 ≈ 1.2M messages/s on average
× 2–3 for the daily peak     ≈ 3M messages/s
× recipients per message     → one delivery per recipient
```

The interviewer will push on assumptions ("why 2–3 recipients?"), not on arithmetic. State each one as you go, e.g. "most messages are 1:1, groups add maybe 3×."

### Habits that catch the usual mistakes

- **Follow each action to where it lands.** Heartbeats from 200M phones every 10 s are 20M/s, but each stops at the server holding that phone's connection. Count only what reaches the component you're sizing.
- **Count reads and writes separately.** They scale differently. Replicas add *read* capacity only. A write goes to the primary and is then copied to every replica, so only splitting the data across more primaries (sharding) adds write capacity.
- **Look for hidden writes.** A TTL that each entry's owner must keep refreshing is a write per entry per refresh interval, and that can cost more than all the reads. Prefer acting **on an event** to acting **on a timer**, whenever the usual answer is "nothing changed."
- **Count both ends of a lifecycle.** At steady state, every connect is eventually matched by a disconnect, and every create by a delete or an expiry. The average lifetime sets both rates.
- **Memory is a separate limit.** Size the data (entries × bytes each) independently of the request rate. Check whether you only need to hold the **working set**, the data in active use.

## How much can one server take?

A server has a few resources, and every request spends some of each. For each resource:

**requests per second = budget ÷ cost per request**

The **lowest** result is the server's capacity, and that resource is the bottleneck.

| Resource | Budget (one server) | Cost per request |
|---|---|---|
| CPU | 1 s of CPU per core, per second | µs of CPU per request |
| Network bandwidth | e.g. 10 Gbit/s ≈ 1.25 GB/s | bytes in + bytes out |
| Packets | very roughly 1M packets/s per core through the kernel | packets in + out |
| Memory | GB of RAM | bytes held (a limit on data, not on rate) |
| Disk | operations per second, MB/s | disk reads and writes per request |

### Worked example: a Redis `GET` of a ~100-byte value

**CPU.** Redis runs commands on one thread, so the budget is one core.
- The hash table lookup itself takes well under a microsecond.
- Most of the cost per request comes from the work around it: a `read()` system call to take the request off the socket, parsing the protocol, and a `write()` system call to send the reply. Each system call crosses into the kernel.
- Altogether that's roughly **5–10 µs per request**:

```text
1 s ÷ 5–10 µs ≈ 100k–200k requests/s
```

**Network.** Key, value, protocol framing and TCP/IP headers come to roughly 300 bytes per request and reply:

```text
100k req/s × 300 B = 30 MB/s ≈ 0.24 Gbit/s   (a 10 Gbit/s link is barely used)
```

**Result: the CPU is the bottleneck, at about 100k–200k operations per second.** Bandwidth only matters for large values.

### "The I/O is overloaded" is usually the wrong diagnosis

In the example the wire is mostly idle. What runs out is **CPU spent on system calls for each request**. I/O multiplexing (`epoll` on Linux) lets one thread *watch* thousands of sockets. It doesn't make each `read` or `write` cheaper. So the fixes are:

1. **Batch:** many requests per system call. Examples are Redis pipelining, or one `MGET` of 200 keys instead of 200 `GET`s.
2. **Use more cores:** Redis 6's I/O threads do socket reads and writes on other cores. Memcached is multi-threaded throughout.
3. **Add servers:** replicas for reads, shards for everything.
4. **Avoid the request:** a local cache in the caller ([cache levels](/distributed-cache/cache-levels/)).

## How many servers?

```text
servers = max( data size ÷ usable RAM per node,
               ops/s     ÷ (≈60% of one node's capacity) )
```

- **Plan at ~60%** of one server's capacity. Peaks have spikes on top: a crashed server's users reconnecting at once, one key going viral.
- **Then add replicas**, e.g. ×2 for one replica per shard.
- **Name the levers.** Example: 7M lookups/s at ~60k per instance is ~120 instances. Batching (~600k per instance) brings it to ~12. An 80% local cache hit rate leaves 1.4M/s, which is ~3 instances. The answer in the room is that chain of reasoning, not the final number.

## Little's law: concurrency, throughput and latency

```text
requests in flight = throughput × latency
```

A client that sends one request and waits for the reply, at a 0.5 ms round trip, can do only **2,000 requests/s** per connection. Reaching 100k/s takes about 50 connections in parallel, or pipelining. The same law sizes thread pools and connection pools, and explains [why load generators run out of connections](/misc/load-generation-limits/).

## Numbers worth knowing

Orders of magnitude, enough for estimates:

| Operation | Rough cost |
|---|---|
| Main memory reference | ~100 ns |
| System call | ~0.1–1 µs |
| Simple Redis/Memcached operation, unpipelined | ~5–10 µs of server CPU |
| Round trip inside one datacenter | ~0.5 ms |
| Round trip per 100 km of fibre | ~1 ms (light in fibre ≈ 200,000 km/s) |
| Round trip across an ocean | ~150–300 ms |
| 10 Gbit/s link | ~1.25 GB/s |
| Small key–value pair in Redis, all overhead included | ~85 B |
| Seconds in a day | 86,400 (≈ 10⁵) |

## Sources
- [Redis: Redis benchmark](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/) (~180k ops/s unpipelined vs ~1.5–1.8M pipelined in its examples; commands run on one thread)
- [Redis: Redis pipelining](https://redis.io/docs/latest/develop/using-commands/pipelining/) (the cost is `read()`/`write()` syscalls, not only round trips; up to ~10× throughput)
- [redis.conf: THREADED I/O section](https://raw.githubusercontent.com/redis/redis/unstable/redis.conf) (I/O threads do socket reads, writes and parsing)
- [Memcached: Performance](https://docs.memcached.org/serverguide/performance/) (one event loop per worker thread; clients pick the server by hashing)
- [Redis FAQ](https://redis.io/docs/latest/develop/get-started/faq/) (1M small key–value pairs ≈ 85 MB; the ~85 B per pair is derived from that)
- [TechCrunch: WhatsApp is now delivering roughly 100 billion messages a day](https://techcrunch.com/2020/10/29/whatsapp-is-now-delivering-roughly-100-billion-messages-a-day/) (2020)

Rules of thumb without a single primary source: ~1M packets/s per core, the latency rows, and the 60% headroom figure.
