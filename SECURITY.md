# Security policy

## Supported versions

pi-peers is young; only the latest release gets fixes.

| Version | Supported |
|---|---|
| 0.1.x (latest) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please don't open a public issue.** Report privately instead:

- **Preferred:** use GitHub's [private vulnerability reporting](https://github.com/rcconsult/pi-peers/security/advisories/new).
- **Or email** radovan.chytracek@rcconsult.biz with "pi-peers security" in the subject.

Include what you found, how to reproduce it, and which versions and operating systems are affected. You'll get an acknowledgement within 7 days. Once a fix is released, the advisory is published, with credit to you if you want it.

## What counts

pi-peers is built for **one user's own agents**, and its threat model follows from that. The [README's Security section](README.md#security) and [ADR 0001](docs/adr/0001-pi-agent-discovery-and-remote-control.md) describe it in full.

**In scope** (please report):
- Another user account on the same machine reaching your agents, reading tokens, or injecting messages.
- Another machine reaching your agents without going through SSH.
- A peer message bypassing the inbound policy (`ask` / `deny`), the approval dialog, or the hop limit.
- Tokens appearing in `pi-peers list`, `get_state`, logs or SSH traffic.
- A peer name or address leading to command execution on a remote host (shell or `ssh` option injection).
- Reverse-link frames reaching the wrong agent or a closed channel.

**Out of scope** (by design):
- Processes running as **your own user**. They can read your discovery files and claim to be any peer. The sender label is not proof of identity.
- Administrators and SYSTEM on Windows, and root on Linux/macOS.
- What an agent does after **you** approve a message, or after you set the policy to `allow`. Peer messages can carry prompt injections; that's why the default is `ask`.
- A compromised SSH account or `~/.pi-peers/hosts` file. Both are trusted configuration.
