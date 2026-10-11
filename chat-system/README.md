# Chat System

Working notes for the "Design a chat system" experiment: design it on paper first, then build the deep-dive parts in Go.

## Lessons

Reader-facing write-ups live on the docs site:
- `lessons/chat-system/design.md`: the interview question, target architecture, and design rationale.
- `lessons/chat-system/websockets.md`: handshake and frames, three kinds of keep-alive, who sends pings, library vs own code, passthrough at a proxy.
- `lessons/chat-system/l7-proxy-tradeoff.md`: L7 proxy in the WebSocket path vs direct connections, and what real systems do.
- `lessons/chat-system/connections-per-server.md`: why a server can hold millions of connections, what limits it, capacity estimate.
- `lessons/chat-system/multiplexing.md`: sharing the proxy → chat server connection; five architectures compared.
- `lessons/chat-system/hipaa-and-ai.md`: applying the design to HIPAA-compliant messaging, and AI as a bot participant.
- `lessons/chat-system/faq.md`: quiz-style follow-up questions.

## Part 1: Interview design (on paper, in this README)

- [ ] **Requirements**: 1:1 and group chat, online presence, delivery/read receipts, offline delivery, message history. Non-functional: low latency, messages never lost, ordering within a conversation. Scale assumptions (users, messages/day).
- [ ] **Estimates**: concurrent connections, messages per second, storage per year.
- [ ] **Connection protocol**: WebSockets vs long polling vs server-sent events.
- [ ] **High-level design**: load balancer / gateway at the edge; stateless API servers (login, lookup, history); stateful chat servers holding WebSockets; Redis for pub/sub and connection counts; message store; push notifications for offline users.
- [ ] **Data model**: messages partitioned by conversation; message IDs that sort by time (e.g. Snowflake-style).
- [ ] **Deep dives**: server placement (lookup API + power of two choices), routing a message to a user on another chat server, group fan-out, presence via heartbeats, rate limiting (connections vs messages), offline delivery, ordering, deploys and reconnect storms.

## Part 2: Build the deep dives (Go)

The build is arranged so we *discover* why each piece is needed.

- [ ] 1. **One server**: WebSocket chat server (`github.com/coder/websocket`) and a tiny client. Everyone is on one machine, so messages go straight from user to user.
- [ ] 2. **Two servers**: clients connect to different servers. Users on different servers can't see each other's messages.
- [ ] 3. **Redis pub/sub**: servers publish messages to Redis and receive other servers' messages from it. Cross-server chat works.
- [ ] 4. **Heartbeats and presence**: server pings on a timer; a missed pong means the user went offline.
- [ ] 5. **Behind the load balancer**: needs the load balancer's WebSocket passthrough and routing by server ID (`../load-balancer`, build log).
- [ ] 6. **Lookup API with power of two choices**: chat servers report connection counts to Redis; the lookup API picks the less loaded of two random servers and returns its ID plus a signed ticket; the chat server verifies the ticket.
- [ ] 7. **Reconnect storm**: kill a server holding many connections; compare placement by random vs least-connections vs power of two, with and without random reconnect delays (jitter). Also add a new, empty server and watch where new users land.
- [ ] 8. **Message rate limiting**: per-user token bucket inside the chat server (reusing `../rate-limiter`).
- [ ] 9. *(Optional)* **Offline delivery and history**: store messages; deliver missed ones on reconnect, in order.
- [ ] 10. *(Optional)* **AI bot participant**: an AI service joins a conversation as a bot user, subscribes via Redis, calls a model and streams its reply back as messages (see `lessons/chat-system/hipaa-and-ai.md`). Build it as a separate Go service, not inside the chat servers.
- [ ] 11. **Interview cheat sheet**: the short version plus follow-up answers.

## Notes

### Mock interview, 2026-10-08 (done during the distributed cache interview)

Started as "where do we store user → chat server?" and ended up settling message routing.

**Estimates (global peak):**
- 200M concurrent connections (given). Heartbeats every 10 s = 20M/s, but they stop at the chat server holding the socket; none reach Redis.
- Messages: ~100B/day (WhatsApp, 2020) ≈ 1.2M/s average, ~3M/s peak; × 2–3 recipients ≈ 7M deliveries/s.
- Connection churn: 200M ÷ 10 min average lifetime ≈ 330k connects/s + the same in disconnects. Connection lifetime is the one assumption that sets both.
- Location map memory: 200M × ~100 B (Redis overhead per key) ≈ 20 GB, which fits on one box. Throughput, not memory, is the limit.

**Decisions:**
- **Placement by load (power of two choices), not by hash.** That means a location map, or something that replaces it. Hash placement would remove the per-user map but loses load balancing and forces users to move on membership changes.
- **Two stores:** a *server registry* (hundreds of entries: alive, region, connection counts; read by the lookup API) and a *user → server* map (200M entries). Placement reads the registry; the map is written after connect.
- **Routing is push (Redis pub/sub), not lookup.** On connect the chat server subscribes to `user:<id>`; senders `PUBLISH`. This turns ~7M map reads/s into ~7M publishes/s: the load moves, it doesn't vanish. Needs sharded pub/sub (`SPUBLISH`, Redis 7) at this scale, because classic `PUBLISH` in Cluster broadcasts to every node. `PUBLISH` returning 0 means the user is offline, so send a push notification.
- **With pub/sub, the per-user map is mostly unnecessary**: subscriptions are the map. Keep at most a presence bit.
- **Crashes:** server-level liveness (one heartbeat key per chat server), with no per-user TTL refresh. That's a few hundred writes/s instead of millions.
- **Proximity:** geo/latency DNS + anycast edge + TLS ended at the edge; the lookup API filters by region before power of two. Open question: global user → home-region directory plus regional maps.

## What we learned

