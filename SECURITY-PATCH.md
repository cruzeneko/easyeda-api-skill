# Local security patch (fork delta)

This repository is a mirror of the upstream JLCEDA `easyeda-api-skill` release
artifact. `scripts/bridge-server.mjs` and the `curl` examples in `SKILL.md` carry
a local hardening patch that upstream does not have.

**If you re-sync from upstream, this patch will be silently overwritten.** Re-apply it.

## What upstream shipped

The bridge executes arbitrary JavaScript inside the running EasyEDA client. As
shipped it had no authentication of any kind, sent `Access-Control-Allow-Origin: *`,
and performed no `Origin` check on WebSocket upgrades. Because WebSockets are exempt
from the same-origin policy, **any web page open in any browser on the machine could
scan ports 49620-49629, connect to `ws://127.0.0.1:<port>/agent`, and run code inside
the user's EDA client** — reading every project and library, or silently editing board
files. `GET /eda-windows` also handed out window IDs unauthenticated, and a second
client could re-`register` a live window ID to displace the real EDA window and return
forged results to the AI agent.

## What this patch changes

| Control | Effect |
| --- | --- |
| Bearer token | Required on `/execute`, `/eda-windows`, `/eda-windows/select` and `ws://.../agent`. Minted per run, written to `~/.easyeda-bridge/token` (0600), compared with `timingSafeEqual`. Pin with `EASYEDA_BRIDGE_TOKEN`. |
| CORS removed | No `Access-Control-Allow-Origin` is emitted; preflight is refused, so browsers cannot read responses. |
| Origin rejection | Any request or WS upgrade carrying a browser `Origin` (including opaque `null`) is refused on agent-facing surfaces. |
| Host allowlist | `Host` must name a loopback address, which defeats DNS rebinding. |
| WS upgrade gate | `verifyClient` applies the above to upgrades, which CORS never covered. |
| Registration lock | A live `windowId` cannot be re-registered by a second client. |
| Result routing | A `result`/`error` only settles a request that was routed to that window. |
| Body cap | 1 MiB, closing an unbounded local memory DoS. |
| Bug fix | `POST /eda-windows/select` referenced an undeclared `activeWindowId`, throwing a `ReferenceError` that was caught and reported as `400 Invalid request body` — while the selection had already taken effect. |

The `/eda` WebSocket path is **not** token-gated: the stock `run-api-gateway.eext`
extension has no way to learn the token. It is gated on loopback `Host` plus an origin
allowlist (no `Origin` for the desktop client; official EasyEDA web origins for the
browser client, extendable via `EASYEDA_BRIDGE_ALLOWED_ORIGINS`).

## Also added by this fork

`scripts/install.sh` — provisions Node (reusing a system one, or fetching a pinned
official build into a user-local prefix with its SHA-256 verified against
`SHASUMS256.txt`), installs `ws` from the lockfile via `npm ci`, and registers the
skill under `~/.claude/skills`. It prints a plan and requires an explicit `y` on a
real terminal first; a piped stdin is refused rather than treated as consent. It
never starts the bridge.

`SKILL.md` also gained an **Untrusted Content & Prompt Injection** section. Results from
`/execute` carry text from shared projects, third-party library entries and document fields,
all of it attacker-controllable, and the agent reading those results is the one component
with no technical boundary protecting it. The section tells the agent to treat returned
content as data, never to act on instructions embedded in it, never to place the bridge token
in code sent to the EDA client, and to distrust results that contradict the request — since
the un-token-gated `/eda` path means a result is not proof of what EDA actually did.

## Residual risk

- Any process running as this user can read the token file. Same-user boundary, not a sandbox.
- The singleton check trusts any local process that answers `/health` with our service
  string, so a squatter can make the real bridge stand down. Set `EASYEDA_BRIDGE_NO_SINGLETON=1`
  to always bind our own port.
- `run-api-gateway.eext`, which performs the actual code execution inside EDA, is a
  third-party binary downloaded from jlc-ext.com and is not reviewed here.
- The bridge is still an RCE channel into your EDA client by design. Run it only while
  doing EDA work, and stop it afterwards.
