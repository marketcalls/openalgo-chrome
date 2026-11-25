# Changelog

## 2.0.1 (2026-11-25)

### Fixed
- Settings: the **Test connection** button no longer gets squeezed and clipped when the connection result is long; the result now wraps beside it.
- README screenshot no longer shows a broker name.

## 2.0.0 (2026-11-25)

### Fixed
- **Buttons failed with `API Error: Failed to fetch` on every site except the OpenAlgo dashboard.** Orders were sent with `fetch()` from the content script, which runs with the web page's origin, so OpenAlgo's CORS allow-list, mixed-content blocking (https page → http server), Chrome's Local Network Access rules and the page's CSP all blocked them. All requests now go through the background service worker, which has host permissions.
- LX/SX sent a smart order with `position_size: 0`, which also flattened a position on the *opposite* side. They now check the open position first and only close the side they name.
- Rapid double clicks could send duplicate orders. Buttons now lock while an order is in flight.
- Requests could hang forever. They now time out (including a stalled response body). Order calls that end in a lost connection, timeout, 5xx or proxy error page are reported as "may have been placed. Check the order book" instead of a plain failure.
- The popup could send an order with the previous quantity if you clicked within 350 ms of typing; pending edits are now saved before every order, and the popup follows changes made from the bar.
- Font and visibility glitches caused by page stylesheets.
- The bar disappeared on single-page apps that replace `<body>`, sat under page pop-ups with very high z-index, and was unclickable over full-screen charts.

### Security
- The API key was rendered into an `<input>` in every page's DOM, where any website could read it. It now lives only in extension storage restricted to trusted contexts and is never sent to the page.
- Any website could place orders by calling `.click()` on the injected buttons. The UI now lives in a closed shadow root on a plain `<div>` host (a custom-element host could be hijacked through `ElementInternals`) and ignores untrusted events.
- Clickjacking defences: the bar re-raises itself above page pop-ups, undoes page changes to its position or style, refuses clicks for a second after any such change or while covered, requires the click to start on the same button, and never treats a double-click as a confirmation.
- Settings markup was built with `innerHTML` from stored values (HTML injection). It is now built only with DOM APIs.
- The API key is no longer synced to the Google account; it moves from `storage.sync` to `storage.local` on upgrade.
- Service worker message handlers validate the sender; account-level actions can only be triggered from the extension's own pages.
- Stricter extension-page CSP (`object-src 'none'; base-uri 'none'; frame-ancestors 'none'`).
- Warning when the API key would be sent over plain `http://` to a non-local host.

### Added
- **Options trading:** CE/PE entry at ATM / ITM1–10 / OTM1–10 via `optionsorder`, with nearest-expiry auto-selection or a chosen expiry, and buyer or writer side. Exits close exactly the contracts the extension opened, check the position before each close, and handle semi-auto approval and partial failures per contract.
- **WebSocket live data:** LTP and day change for the active symbol or underlying, and fill/rejection alerts for the extension's own orders. Connects only while a bar or the popup is visible.
- **Popup trading panel:** trade from the toolbar (works on pages where content scripts cannot run), with live quote and net position, a lot-size hint for options, a list of tracked option contracts, and *Close all positions* / *Cancel all orders* (each needs a second click to confirm).
- Connection test showing broker and Sandbox/Live mode; a SANDBOX/LIVE label on the bar.
- Optional "confirm before sending orders" (two-click arming).
- Show the bar on every site, only on selected sites, or nowhere; per-site switch.
- Light/dark bar theme that follows the page, a minimised pill mode, and a drag position that is remembered and kept on screen.
- Onboarding: the settings page opens on install. Open tabs get the bar without reloading after install or update.

### Changed
- Settings moved from the in-page panel to the popup/options page (keeps the API key out of web pages).
- Removed the 960-line `css/styles.css` and the old `content.css`; the extension is still plain JavaScript with no dependencies or build step.
- Minimum Chrome version: 116.

## 1.0 (2025-03-30)
- Initial release: LE/LX/SE/SX buttons with an in-page settings panel.
