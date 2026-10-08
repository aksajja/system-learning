# Traffic Generator

Shared tooling in Go: drive load against any experiment and report what happened. Features are added when an experiment needs them.

## Planned features

- [ ] **Count responses**: send N requests with C at a time; count status codes and response bodies (e.g. which backend answered). *(Until built, `seq 300 | xargs -P 30 -I{} curl -s localhost:8090` does the job.)*
- [ ] **Fixed request rate**: send R requests/second for D seconds; count `200` vs `429`. *(Rate limiter.)*
- [ ] **Many simulated clients**: give each request a client identity (e.g. an `X-Forwarded-For` IP or API key) to test per-client limits. *(Rate limiter.)*
- [ ] **Latency report**: median and slowest 1% (p50 / p99), plus error rates over time.
- [ ] **WebSocket clients**: open many connections via the lookup API, send messages, measure delivery time. *(Chat.)*
- [ ] **Reconnect-storm measurement**: when a chat server dies, record how its clients reconnect (with and without jitter) and how connections end up spread across servers. *(Chat, step 7.)*

Optional, for the optional load balancer builds:
- [ ] **Slow requests**: mix in deliberately slow requests to show round-robin giving uneven work.
- [ ] **Steady traffic while killing a backend**: measure the failure window (errors until health checks react).

## Limits on the generating side

Moved to the side-topic page `lessons/misc/load-generation-limits.md` (ephemeral port limit, workarounds).

## What we learned

