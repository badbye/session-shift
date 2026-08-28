# SessionShift

SessionShift is a Chrome extension for using multiple isolated sessions in
parallel, with one session assigned to each tab.

This repository is based on the original [SessionShift project](https://github.com/anhkiet75/session-shift). The list below describes only the features added or substantially extended in this repository.

The Storage tab also references the interface and inspection workflow of [Storage Inspector](https://github.com/evilcos/storage-inspector), a Chrome extension for inspecting localStorage, sessionStorage, and Cookies. SessionShift integrates the relevant inspection experience into its existing popup: the displayed data is always scoped to the current page and current Profile. Local and session storage are read through the active Profile's namespace, while Cookies come from that Profile's isolated store; the Default Profile reads the browser's current Cookie container. This integration is Profile-aware and does not turn the normal Profile/Rule export into a session backup.

## Added and extended capabilities

- **Global Profile management** — Replaced the original per-site session-list model with reusable Profiles shared across sites. Profiles have stable IDs and can be renamed, recolored, duplicated, or deleted.
- **Deterministic URL Rules** — Added a separate Rule model and editor for automatically binding matching HTTP(S) URLs to a Profile. Rules support required scheme and hostname, optional port and URL regular expressions, priority, and per-tab manual overrides.
- **Validated Profile/Rule transfer** — Added versioned JSON import/export for Profile metadata and URL Rules, including schema validation and stable Profile/Rule IDs. Login Cookies and page Storage are intentionally excluded.
- **Linked-tab Profile inheritance** — Added automatic Profile inheritance for tabs opened from an isolated tab, with an option to disable it.
- **Profile-aware tab actions** — Added commands to open the current page in a selected Profile and to open links in a Profile through the context menu.
- **Cookie isolation hardening** — Extended the original isolation implementation with registrable-domain cookie stores, upstream `Set-Cookie` capture, broader request isolation, serialized cookie writes, and stale-data cleanup.
- **Interface and accessibility improvements** — Added a dedicated Options page, theme switching, keyboard shortcuts, optional native tab groups, color-coded tab indicators, inline delete confirmation, and accessibility improvements.
- **Localization and RTL support** — Added runtime localization for 55 Chrome locales, bidirectional layout support, and English fallback for destructive actions in unreviewed locales.

## Install from source

```bash
npm install
npm run build
```

Then open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select the generated `dist/` directory.

## Basic use

1. Open the SessionShift popup and create a Profile.
2. Log in to the website while that Profile is active.
3. Create a Rule if matching URLs should select the Profile automatically.
4. Use the popup, keyboard shortcuts, or context menu to switch or open Profiles.

Each Profile's login state is stored separately. Removing and reinstalling the
extension clears the extension's local session data; importing Profiles and
Rules alone does not restore a previous login, so affected Profiles must be
logged in again.

## Privacy and scope

SessionShift runs locally and does not require an external service. It needs
access to web pages in order to isolate network cookies and page-visible
storage. Session cookies are sensitive data and are not included in the normal
Profile/Rule export file.

## License

[MIT](LICENSE)
