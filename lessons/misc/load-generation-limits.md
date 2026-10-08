---
title: Load generation limits
description: Why a load generator runs out of ephemeral ports long before a server does, and how to get past ~16k connections from one machine.
sidebar:
  order: 3
---

A server only *accepts* connections, so every client shares its one listening port. A load generator is the other side: it *opens* every connection itself, and each one needs a source port of its own. That puts the generating machine up against a limit the server under test never sees, which matters as soon as a test needs many long-lived connections, such as thousands of WebSockets.

## The ephemeral port limit

Each connection from the generator uses an ephemeral (temporary) source port. On a Mac (macOS) that range is 49152–65535, so one machine can hold only **~16k connections to one server address**.

Phoenix's 2M-WebSocket demo needed 45+ client machines for exactly this reason (see [Connections per server](/chat-system/connections-per-server/)).

## Workarounds

To go past ~16k connections from one machine:
- Have the server **listen on several ports**: each port is a separate destination with its own ~16k.
- Use **several loopback source addresses** (`127.0.0.2`, `127.0.0.3` …), each with its own port range. On macOS each needs an alias:

  ```sh
  sudo ifconfig lo0 alias 127.0.0.2
  ```
- Raise the **open-files limit** on both sides: a Mac (macOS) caps one process at 92,160 (`kern.maxfilesperproc`).

:::note
A few thousand connections is enough to see reconnect storms, so these workarounds are rarely needed for that.
:::
