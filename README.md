# ChatGPT-Usage-Overlay

**Usage Under Chat v0.3.0** shows your 5-hour and weekly ChatGPT usage allowances and progress bars underneath the message box. **Automatic checks use your existing ChatGPT tab. An extra Usage tab is no longer needed.**

The extension checks about every two minutes while a ChatGPT tab is open. It does not load a second ChatGPT page, reload your conversation, create a hidden iframe/offscreen document, or run a background renderer. A small event-driven service worker schedules reads through an existing tab's content script.

## Install or update

1. [Download the repository ZIP](https://github.com/jasone9/ChatGPT-Usage-Overlay/archive/refs/heads/main.zip) and extract it.
2. For an existing installation, copy the new files into the folder you originally loaded. Open `chrome://extensions` and click the extension's **Reload** button.
3. For a new installation, enable **Developer mode**, click **Load unpacked**, and select the extracted folder containing `manifest.json`.
4. Refresh your ChatGPT chat and allow about 30 seconds for the first read. You can close the old Usage tab.

On upgrade, the extension closes only the inactive Usage tab tracked as its own by version 0.2. It preserves a foreground tab or one navigated to a conversation. It never recreates an automatic Usage tab.

## What the bars show

Each bar represents **remaining** allowance: a full bar means 100% left. Bars turn amber at 25% and red at 10%. Numeric percentages and accessible labels accompany both the composer bars and the extension popup. Light and dark themes are supported.

The last-read time is always visible. Checks occur periodically rather than instantly after every message. Chrome scheduling, network failures, and reporting delays can postpone updates. Readings older than five minutes are marked potentially outdated and expire after 24 hours. A reported reset time never causes the extension to invent a full balance.

## Controls

- **Refresh** or **Refresh now** requests an earlier check, with a one-minute minimum between successful attempts. Server-requested/error backoff also applies to manual clicks.
- **Read Usage automatically** pauses/resumes reads.
- **Show beneath the message box** hides/shows the overlay.
- **Open Usage settings** opens Settings only when you explicitly click it, so you can compare the displayed numbers. It is not an automatic reader tab.
- **Info** under the composer explains the reader.

## How the tab-free reader works

The service worker chooses an existing, loaded, non-incognito `chatgpt.com` tab and sends a read request to its isolated content script. The script makes two same-origin GET requests:

1. `/api/auth/session` obtains the current session's short-lived access credential.
2. `/backend-api/wham/usage` retrieves rate-limit data using that credential. If the session exposes an account ID, it is sent as the `ChatGPT-Account-Id` header.

The usage route and response fields are corroborated by OpenAI's Codex backend client and generated models. These are internal website endpoints, not a stable public extension API; their availability, authentication, and schema may change. A live signed-in account is needed to verify compatibility with a particular workspace.

The parser identifies the five-hour and weekly windows by their explicit durations (18,000 and 604,800 seconds), then converts `used_percent` to remaining percentage. It validates ranges and refuses unknown or ambiguous data. Monthly credit pools and additional model-specific limits are not substituted for the two allowances. Reset timestamps are formatted in your browser's time zone.

Only normalized allowance values and safe status information are passed to the worker. Invalid responses report an error instead of opening a fallback tab. Temporary errors preserve the last good reading; sign-out, access rejection, and a detected account mismatch clear old account balances. Errors retry with increasing delays of 2–30 minutes, honoring a longer `Retry-After` value within that limit.

## Session and privacy handling

- The session credential exists only in the content script's request scope. It is never written to extension storage, inserted into the DOM, included in runtime messages, or logged.
- Requests are fixed to same-origin ChatGPT paths, use GET and `no-store`, and refuse redirects. No credential is forwarded to another origin.
- The extension does not request cookie-reading permission, API keys, or a separate sign-in. It uses the browser's existing signed-in session.
- Local extension storage holds normalized percentages, reset text, read time, preferences, and status. Session-only storage holds scheduling/backoff metadata and, when available, a one-way hash for detecting a session/account change. Raw user/account identifiers are not persisted.
- The extension does not parse conversation text for usage values or upload chats to an external service. There are no analytics or remote scripts.
- Permissions remain `storage`, `alarms`, and the ChatGPT-only host permission. No broad all-sites, `tabs`, `cookies`, or `offscreen` permission is requested.

The balance belongs to the account selected by ChatGPT's session/usage response. Automatic per-conversation workspace matching is not implemented. If you use several workspaces, compare the bar against Settings after switching. An available session account ID and response account ID must agree; a mismatch is rejected.

## Troubleshooting

**No values after updating:** refresh your existing ChatGPT tabs so they load the new content script, then choose **Refresh now**. No automatic page or fallback tab will open.

**Sign-in or access error:** sign in through ChatGPT normally. The extension will retry more slowly; it does not bypass sign-in, challenges, or access restrictions.

**Only one allowance:** only windows actually returned and recognized are shown. Missing data is not replaced with 100%.

**Old values:** check the last-read time and status. Failed reads back off. Settings remains available for comparison through the popup button.

**No overlay:** make sure a composer is visible and the display switch is enabled. A changed ChatGPT/Work composer layout may need a selector update.

No requests are made when there is no loaded ChatGPT tab. Incognito, native desktop apps, other domains, and embedded subframes are outside this version's scope.

## Development and validation

Use Node.js 18 or newer. No build step is required to load the unpacked extension.

```sh
npm install
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

The fast suite covers the API schema, window mapping, zero/full balances, same-origin requests, error redaction, transient credential handling, account mismatch, cancellation, scheduling, backoff, pause, and safe migration from the previous reader tab. Legacy text-parser tests remain for the shared parser.

The Chromium integration suite serves local HTTPS fixtures for the ChatGPT chat and authenticated session/usage responses. It checks the actual unpacked extension, session cookies, authenticated reads, no automatic Usage-page navigation, no conversation reloads, progress bars, mobile layouts, warning colors, pause, retry delays, and clearing balances after sign-out. Fixture tests do not authenticate a real ChatGPT account.

GitHub Actions runs syntax, logic, and browser integration checks on pushes and pull requests. Browser diagnostics contain fixture data and normalized state only. The build workspace lacks an installed browser, so browser execution runs in CI.

## Primary source references

- [OpenAI Codex usage request](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs)
- [OpenAI Codex request authentication and account header](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)
- [OpenAI rate-limit response model](https://github.com/openai/codex/blob/main/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs)
- [OpenAI window response model](https://github.com/openai/codex/blob/main/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs)

Independent prototype; not affiliated with OpenAI. Version **0.3.0**.
