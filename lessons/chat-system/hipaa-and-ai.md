---
title: HIPAA and AI conversations
description: Applying the chat design to a HIPAA-compliant messaging system, and whether AI conversations belong in a separate system.
sidebar:
  order: 6
---

How the chat architecture choices apply to a **HIPAA-compliant messaging system**, and whether **AI conversations** should be a separate system from **peer conversations**.

:::caution[Not legal advice]
This is architecture guidance, not legal advice. HIPAA compliance needs review by a compliance or legal team.
:::

## Interview version

:::tip[Interview version]
- "HIPAA doesn't prescribe a topology. It means every component that handles PHI is in scope and needs a BAA, encryption in transit and at rest, access control, and audit logs."
- "I'd use a managed L7 load balancer under a BAA, **re-encrypting** to the chat servers; Redis and the message store encrypted and under BAAs; every PHI access audited."
- "Not end-to-end encrypted by default: the organisation must retain, audit and produce records."
- "No PHI in push notifications or logs."
- "AI as a separate service that joins conversations as a **bot participant**, sharing the platform's identity, storage and audit, but scaling, rate-limiting and failing independently."
:::

## Where large services are in 2026

- **WhatsApp is no longer direct-to-server.** Observed 2026-10, from one location: clients connect to `g.whatsapp.net` → `chat.cdn.whatsapp.net` → a Meta-owned IP whose reverse DNS is `whatsapp-chatd-edge-shv-01-atl3.facebook.com`: a WhatsApp chat *edge* host in Meta's Atlanta point of presence. Internals aren't public, but direct-to-server describes WhatsApp in 2012.
- **The lesson from all the examples:** large services converge on an **edge tier near users** (TLS and connection handling) in front of the core. Slack: Envoy, Flannel, gateway servers. Meta: Proxygen edge proxies, the WhatsApp chat edge. Direct connections were a stage very efficient early systems went through. Details: [L7 proxy in the WebSocket path vs direct](/chat-system/l7-proxy-tradeoff/#what-real-systems-do).

## HIPAA: what shapes the architecture

HIPAA protects **PHI** (protected health information). The rules that matter for design:
1. **Every system that handles PHI is in scope.** Every vendor running one must sign a **BAA** (business associate agreement): cloud provider, managed load balancer, Redis, database, logging and monitoring tools, AI provider.
2. **Encryption in transit and at rest**, **access control**, and **audit logs** of who accessed what.
3. **Retention and the right of access**: the organisation must be able to retrieve and produce records.
4. **Minimum necessary**: use or disclose only the PHI needed for a purpose (with exceptions, e.g. treatment).

:::note[Pending change to check]
In December 2024 HHS issued a proposed update to the HIPAA Security Rule (published January 2025). Among other things it would remove the "required" vs "addressable" distinction, which would make encryption effectively mandatory. Its status in 2026 is unconfirmed. Encrypting everything is the safe design either way.
:::

### What that means for the architecture options

The options are those compared in [L7 proxy in the WebSocket path vs direct](/chat-system/l7-proxy-tradeoff/) (A and B) and [Multiplexing](/chat-system/multiplexing/#comparing-the-architectures) (C, D and E).

| Option | HIPAA view |
|---|---|
| **A. L7 proxy, one upstream per user** | **Recommended.** The proxy decrypts TLS, so it's in scope: use a load balancer under a BAA (e.g. AWS's load balancers are HIPAA-eligible) and **re-encrypt** to chat servers. Standard parts, few custom pieces, less to secure and certify. |
| **B. Direct (L4 pass-through, TLS ends at chat servers)** | Reasonable alternative: PHI is decrypted in **fewer places**, a genuine compliance plus. Cost: no L7 features such as a web application firewall. |
| **C/D/E. Multiplexing, gateway tier** | Unnecessary at typical healthcare scale (thousands to low millions of concurrent users); more custom components to secure. |
| **End-to-end encryption** | Usually not the default in healthcare messaging: it conflicts with retention, audit and producing records. Common pattern: transport + at-rest encryption, strict access control, complete audit logs. See [End-to-end encryption](/misc/e2ee/). |

### Recommended shape

```text
Clients ──TLS──▶ managed L7 load balancer (under a BAA) ──TLS again──▶ chat servers
                 lookup API + short-lived tickets
chat servers ⇄ Redis (TLS + auth, under a BAA) ⇄ message store (encrypted at rest, keys in a key-management service)
every read and write of PHI → audit log
```

- **Redis pub/sub carries message content**, so Redis is in scope: TLS, authentication, a BAA-covered service (e.g. AWS ElastiCache).
- **Search indexes, caches and backups** containing PHI are in scope too.

### Pitfalls (more common than architecture mistakes)

:::caution
- **Push notifications**: Apple's and Google's push services aren't under your BAA. Send "You have a new message", never the content.
- **Logs and error trackers**: message bodies leak into logs, crash reports and analytics. Keep PHI out, or keep those tools under a BAA.
- **Devices**: encrypted local storage, session timeouts, remote logout for lost phones.
:::

## AI conversations vs peer conversations

**Recommendation: share the platform, separate the AI service.** Not two separate systems, and not AI built into the chat servers.

### Why AI doesn't belong inside the chat servers

| | Peer messaging | AI conversations |
|---|---|---|
| Traffic shape | Short messages, fan-out to participants, presence, receipts | Request → **streamed response over seconds**, 1:1 with the model |
| Bottleneck | Connections, fan-out | Model provider rate limits, tokens, **cost** |
| Failure | Must stay up | Model outages and slowdowns happen; they **mustn't affect** clinician–patient messaging |
| Controls | Message rate limits | Token budgets, prompt safety, clinical safety review |
| Extra compliance | Standard | The **AI provider needs a BAA** and a **no-retention** agreement; prompts and outputs contain PHI and must be audited too |

### Why not a completely separate system

- It would duplicate identity, auth, conversation storage, retention, audit logging and the compliance burden.
- AI will show up *inside* peer conversations anyway: drafting replies, summarising a patient thread, triage.

### The pattern: AI as a bot participant

```text
                     ┌─ chat servers (peer messaging)
shared platform ─────┤
(auth, conversations,│
 storage, audit)     └─ AI service: joins conversations as a "bot user"
                        subscribes via the same pub/sub, calls the model provider,
                        streams its reply back as messages
```

- **AI-only chats** are conversations whose other participant is the bot.
- **AI inside peer chats** is the same bot, invited into the conversation.
- **Everything lands in the same audited, retained store**: one compliance story for both.
- **The AI service scales, rate-limits and fails independently**: a model outage means "the assistant is unavailable", and peer messaging keeps working.
- **Mark AI-generated content clearly** in the stored record.
- **Send only the data needed** for each AI task (minimum necessary).
- Several major AI providers offer BAAs for some offerings; check current terms with the provider you use.

## Sources

- [HHS: Summary of the HIPAA Security Rule](https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html)
- [HHS: HIPAA Security Rule NPRM fact sheet (Dec 2024)](https://www.hhs.gov/hipaa/for-professionals/security/hipaa-security-rule-nprm/factsheet/index.html)
- [HHS: Business associates](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html)
- [HHS: Guidance on HIPAA and cloud computing](https://www.hhs.gov/hipaa/for-professionals/special-topics/health-information-technology/cloud-computing/index.html)
- [HHS: Minimum necessary requirement](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/minimum-necessary-requirement/index.html)
- [AWS: HIPAA eligible services reference](https://aws.amazon.com/compliance/hipaa-eligible-services-reference/)
- [Slack Engineering: Real-time Messaging](https://slack.engineering/real-time-messaging/)
- [Meta: How Facebook achieves disruption-free updates (APNIC blog)](https://blog.apnic.net/2021/03/29/how-facebook-achieves-disruption-free-updates-with-zero-downtime/)
