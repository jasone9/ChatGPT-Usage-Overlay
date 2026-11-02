# ChatGPT-Usage-Overlay

**Usage Under Chat** is a Chrome extension that automatically reads your displayed **5-hour** and **weekly** Usage allowances and puts them underneath the ChatGPT message box.

No screenshots, copying, pasted values, API keys, or setup forms. Once installed, open a ChatGPT chat. The extension opens one inactive Usage tab and checks it about every **2 minutes** while another ChatGPT tab is open.

## Install or replace the old version

1. [Download this repository as a ZIP](https://github.com/jasone9/ChatGPT-Usage-Overlay/archive/refs/heads/main.zip) and **Extract All**. Keep the extracted folder in a permanent location.
2. Open `chrome://extensions`. If you installed the earlier **Usage Under Chat v0.1** prototype, remove that copy first so both versions do not run together.
3. Turn on **Developer mode**, click **Load unpacked**, and select the extracted folder containing **manifest.json**.
4. Refresh your ChatGPT chat. Allow about 30 seconds for the first automatic read.

Leave the Usage reader tab open in the background. The extension does not switch you away from your chat. If you close the reader, a replacement is opened when the next check is due.

Example appearance (illustrative values):

**Usage · 5h 94% left ↻ 6:25 PM · Weekly 99% left · Auto · read just now**

## Controls

- **Refresh** under the composer or **Refresh now** in the extension popup requests an earlier check. There is a one-minute minimum between attempts.
- **Open Usage reader** in the popup opens/focuses the source page if a login or unsupported layout needs attention.
- **Read Usage automatically** pauses/resumes the reader.
- **Show beneath the message box** hides/shows the overlay without changing the reader setting.
- **Info** under the composer explains the automatic reader.

The numbers belong to the account/workspace selected in the source Usage tab. If you switch accounts or workspaces, check that the Usage tab is using the intended one. This version does not identify or maintain separate balances for multiple workspaces.

## What “automatic” means

The extension loads the normal authenticated Usage page in an inactive browser tab. A content script reads the displayed allowance labels, percentages, and reset text. A Manifest V3 service worker schedules later reloads with Chrome alarms and distributes normalized values through local extension storage.

The current primary source is `https://chatgpt.com/settings/usage`, matching OpenAI's current Codex CLI usage link. Older account/layout routes are tried after failed reads. The original prototype recognized an older route and only captured values when you manually opened Usage; version 0.2 removes that manual capture workflow.

This is **periodic automatic reading**, not an instant server-pushed balance. Usage changes and reporting delays may take time to appear. The bar always shows the last successful read time. Readings older than 5 minutes are marked as potentially outdated and expire after 24 hours. Reset labels are copied as displayed; the extension never assumes an allowance has refilled.

Failed reads preserve the last successful values and retry with increasing delays (2–30 minutes), instead of inventing percentages or rapidly reloading the page. A visible error is shown when the reader cannot recognize Usage. Browser sleep and Chrome's alarm scheduling can delay checks.

## Privacy and permissions

- Runs only on `https://chatgpt.com/*`.
- `storage`: stores normalized allowance values, reset labels, read timestamp/source, status, and display preferences locally in this Chrome profile.
- `alarms`: schedules refreshes and read timeouts.
- ChatGPT-only host permission: discovers ChatGPT tabs and manages the extension-created Usage tab. It does not request access to every website or the broad `tabs` permission.
- A session-only record tracks the reader tab and retry times. It is not an authentication record.
- Does not read cookies, access tokens, or private API responses. Authentication is handled by the ordinary ChatGPT page.
- Does not upload or save conversation text. Conversation articles, message containers, code blocks, and editors are excluded from Usage parsing.
- No remote scripts, analytics, credential prompts, or API keys. The extension makes no direct API fetches; the normal Usage page makes its own requests.
- Incognito is not supported.

## Compatibility and troubleshooting

**Numbers do not appear:** click the extension icon → **Open Usage reader**. Check that the page loads and you are signed in. If the page does not display Usage or shows a rate-limit/security message, pause automatic reading until the page works normally. The reader reports failure rather than displaying made-up data.

**Bar does not appear:** refresh your ChatGPT tab, enable the display switch, and make sure a message composer is visible. The extension supports common ChatGPT/Work editor selectors; a changed composer layout may need an update.

**Values look old:** check the last-read time and reader status. The source page itself can lag. The two-minute interval is approximate; failures back off.

**Only one allowance appears:** only recognized allowances are displayed. Some accounts do not show both limits. Monthly credit values and code-review limits are not substituted for missing allowances.

English Usage labels are currently supported. Native desktop apps, other domains, embedded subframes, and automatic workspace-specific matching are outside this version's scope.

## Development and tests

Use Node.js 18 or newer. No build step is needed to load the extension.

```sh
npm install
npm test
npm run check
npx playwright install chromium
npm run test:browser
```

The fast test suite exercises parsing against the supplied screenshot's text layout and service-worker behavior against a mocked Chrome API. Coverage includes independent allowances, zero balances, invalid/ambiguous values, snapshot expiry, refresh scheduling, duplicate requests, retries/backoff, origin checks, pause, and protection of user chat tabs.

The separate Chromium integration suite loads the actual unpacked extension, intercepts ChatGPT pages with local HTML fixtures, and checks automatic source-tab creation, background refresh, overlay positioning, conversation-text exclusion, composer replacement, narrow layouts, popup pause, and error states. **Fixture tests do not verify a live signed-in ChatGPT account.**

GitHub Actions runs syntax, logic, and browser integration tests on pushes and pull requests. Browser fixture screenshots are test artifacts and contain no real account data.

The build workspace could run the fast tests and syntax checks. It could not launch Chromium because no browser was installed and browser/package downloads were blocked; browser execution is therefore delegated to the repository's CI. See the Actions result for the pushed commit, and do not treat the presence of a browser test file as a passing result.

## Source references

- [OpenAI Codex's current Usage URL](https://github.com/openai/codex/blob/main/codex-rs/tui/src/status/card.rs)
- [Chrome extension alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Chrome tab permissions and APIs](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Playwright extension testing](https://playwright.dev/docs/chrome-extensions)

Independent prototype; not affiliated with OpenAI. Version **0.2.0**.
