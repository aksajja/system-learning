---
title: End-to-end encryption (E2EE)
description: What end-to-end encryption means, how Signal Protocol keys work, who uses it, and what it changes in a chat system design.
sidebar:
  order: 2
---

**End-to-end encrypted** means the sender's device encrypts message content with keys that **only the recipients' devices hold**, so no company server can read it. Encryption "in transit" (TLS) and "at rest" (on disk) are not E2EE: the company's servers still hold the keys.

:::tip[Interview version]
If "design WhatsApp" turns to encryption:
- "Each **device** has a key pair; public keys go to a **key directory** service. Devices agree on pairwise secrets with **Diffie-Hellman** (works even if the recipient is offline, thanks to prekeys), derive a **new key per message** for forward secrecy, and use **sender keys** for groups."
- "The server only routes and stores **ciphertext**; it still sees **metadata** (who, when, size), which routing needs."
- "Fan-out is per **device**, not per user, and is done by the sender's app."
- "Costs: no server-side search, moderation by content, or server-generated link previews; history on a new device is hard."
- "TLS termination at edge proxies doesn't break E2EE: proxies open the TLS layer and find a sealed body."
:::

## Who's end-to-end encrypted

| Service | E2EE? | Details |
|---|---|---|
| **Slack** | **No** | Encrypted in transit (TLS) and at rest; Slack's servers can read messages. **Enterprise Key Management** (paid) lets a customer control the keys for stored data, but Slack still decrypts to process, so it's not E2EE. |
| **Messenger** | **Personal chats: yes, by default** (rolling out since Dec 2023) | Signal Protocol + Meta's **Labyrinth** protocol for storing history. Group chats were **opt-in** as of Meta's March 2024 explainer; current status unconfirmed. Rollout was gradual: a mid-2024 survey found most users hadn't received it yet. |
| **WhatsApp** | **Yes, everything by default** | All chats including groups, Signal Protocol. Key transparency rolled out in 2023. |
| **Discord** | **Calls yes, text no** | Voice and video E2EE for everyone via the **DAVE** protocol (completed March 2026, announced May 2026; stage channels excepted). Text stays readable on purpose, for moderation. |

### Why Slack and Discord text don't use E2EE

E2EE removes everything that needs the server to read messages:
- **Server-side search** (Slack's core feature)
- **Compliance exports and legal discovery** (business customers buy Slack partly *for* this)
- **Integrations and bots** that read channel messages
- **Content moderation and spam filtering by content** (Discord's stated reason)
- **Server-generated link previews**

For Slack it's product strategy: its customers *want* access to their company's data.

## TLS vs end-to-end: two separate layers

**TLS protects each hop.** Client → proxy is one encrypted pipe, proxy → server another; at each proxy and server the data is readable. Picture an armoured van between depots.

**E2EE protects the message itself**, applied by the app *before* TLS. It's the sealed letter inside the van.

```text
What the sender's app puts in the WebSocket message:
  { "to": "bob", "conversation": "c-42", "body": "x8f2k9Qa…" }   ← body is ciphertext;
                                                                    only Bob's devices can open it
That message then travels inside TLS:
  phone ══TLS══▶ L4 ──▶ L7 proxy ══TLS══▶ chat server ══TLS══▶ Bob's phone
                        ▲ opens TLS: sees "to: bob"   ▲ same: stores and forwards
                          and a body it can't read      the sealed blob
```

**Where TLS ends and whether a service is E2EE are independent questions:**

| Setup | TLS ends at | Can the company read messages? | E2EE? |
|---|---|---|---|
| L7 proxy, app encrypts messages (Messenger personal chats, WhatsApp) | The proxy | **No**, only metadata | **Yes** |
| L7 proxy, no app-level encryption (Slack, Discord text) | The proxy | Yes | No |
| Direct to the chat server, no app-level encryption | The chat server | **Yes**: the chat server reads them | **No** |

TLS always ends at *some* server the company runs, so TLS alone is never end-to-end. And E2EE doesn't change the network layout: routing still works because `to` and `conversation` stay readable.

**Metadata stays visible**: who messages whom, which conversation, when, message size, the user's IP address. Routing needs it, which is why privacy discussions about E2EE apps focus on metadata.

## How the keys work (Signal Protocol, used by WhatsApp and Messenger)

Keys aren't "one pair per chat". That would fail because: someone would have to send the private half securely (the problem being solved); people have several devices; one stolen key would expose the whole history.

### Layer 1: a key pair per device

On install, **each device** generates:
- An **identity key pair** (long-term): the device's cryptographic identity.
- A batch of **prekeys**: extra one-time public keys, signed by the identity key.

Private halves never leave the device. Public halves are uploaded to the server's **key directory**.

### Layer 2: a shared secret per pair of devices (X3DH)

To message Bob for the first time, Alice's phone:
1. Fetches Bob's **prekey bundle** (his public keys) from the directory.
2. Combines it with her private keys using **Diffie-Hellman key agreement**: each side mixes its own private key with the other's public key and both arrive at the **same secret**, which never crosses the network.
3. Bob's phone does the mirror calculation when it comes online.

Prekeys make this work **while Bob is offline**. The result is a **symmetric** secret: public-key maths only *agrees* on it, because public-key encryption is slow and size-limited (**hybrid encryption**).

### Layer 3: a new key for every message (Double Ratchet)

From the shared secret, a **new key per message** is derived and old ones are deleted:
- **Forward secrecy**: keys stolen today can't decrypt past messages.
- **Self-healing** (post-compromise security): new key material keeps getting mixed in, so an attacker loses access again.

### Groups: sender keys, and MLS

- Each member's device creates a **sender key** for the group and sends it to every other member's device **once**, over the pairwise sessions. Then each message is encrypted **once**, and the server fans out the same ciphertext. (Without this: 100 members × 2 devices = 200 encryptions per message.)
- When someone leaves, keys are **replaced** so they can't read future messages.
- **MLS** (Messaging Layer Security, RFC 9420) is a newer standard that handles very large groups efficiently with a tree of keys.

### Worked example: fan-out per device

Alice (phone + laptop) sends "hi" to Bob (phone + laptop). Alice's phone encrypts **3 copies**:

```text
→ Bob's phone      (session Alice-phone ↔ Bob-phone)
→ Bob's laptop     (session Alice-phone ↔ Bob-laptop)
→ Alice's laptop   (so her other device sees what she sent)
```

The sender's app does this; the server just delivers sealed copies.

### Summary

| Level | What | Lifetime |
|---|---|---|
| Device | Identity key pair + prekeys (public halves in the directory) | Until the app is reinstalled |
| Pair of devices | Shared secret via Diffie-Hellman (X3DH) | The conversation |
| Message | New key per message (Double Ratchet) | One message |
| Group | A sender key per member's device | Until membership changes |

### The weak spot: trusting the key directory

The server hands out public keys. A malicious or hacked server could hand Alice **its own** key instead of Bob's and read everything (a man-in-the-middle attack). Defences:
- **Safety numbers / security codes**: users compare a code in person or by QR scan.
- **Key transparency**: a public, append-only log of everyone's keys, so substitutions are detectable (WhatsApp, 2023).

## What E2EE changes in a chat system design

- **New component: key directory** (public keys and prekeys per device; prekeys get used up and must be refilled).
- **Fan-out per device**, encrypted by the sender's app; **sender keys** for groups.
- **Server stores and forwards ciphertext only.** Search happens on the device; moderation relies on user reports and metadata.
- **New-device history** is hard: Messenger built Labyrinth for encrypted history storage.
- **Unchanged**: connection handling, routing, Redis pub/sub, placement. They use only metadata (`to`, `conversation`). In the [chat system design](/chat-system/design/), adding E2EE would mean clients encrypt the `body` field while the server code stays the same: server logs would show only sealed blobs.

## Sources

- [Signal: The X3DH key agreement protocol](https://signal.org/docs/specifications/x3dh/)
- [Signal: The Double Ratchet algorithm](https://signal.org/docs/specifications/doubleratchet/)
- [RFC 9420: The Messaging Layer Security (MLS) protocol](https://www.rfc-editor.org/rfc/rfc9420)
- [WhatsApp Encryption Overview (security whitepaper, PDF)](https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf)
- [Meta: Deploying key transparency at WhatsApp](https://engineering.fb.com/2023/04/13/security/whatsapp-key-transparency/)
- [Meta: Launching default end-to-end encryption on Messenger (Dec 2023)](https://about.fb.com/news/2023/12/default-end-to-end-encryption-on-messenger/)
- [Meta Engineering: Building end-to-end security for Messenger (Labyrinth)](https://engineering.fb.com/2023/12/06/security/building-end-to-end-security-for-messenger/)
- [Meta: End-to-end encryption on Messenger explained (Mar 2024)](https://about.fb.com/news/2024/03/end-to-end-encryption-on-messenger-explained/)
- [Accountable Tech: Meta's default encryption on Messenger remains incomplete](https://accountabletech.org/research/metas-e2e-survey/)
- [Slack Engineering: Engineering dive into Slack Enterprise Key Management](https://slack.engineering/engineering-dive-into-slack-enterprise-key-management/)
- [Slack: Security and encryption](https://slack.com/trust/security)
- [Discord: Meet DAVE, E2EE for audio and video](https://discord.com/blog/meet-dave-e2ee-for-audio-video)
- [BleepingComputer: Discord rolls out end-to-end encryption on voice, video calls](https://www.bleepingcomputer.com/news/security/discord-rolls-out-end-to-end-encryption-on-voice-video-calls/)
