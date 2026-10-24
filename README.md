# fxplorer · iOS-inspired preview

A local Windows preview of fxplorer with an iPad Files-inspired workspace: a floating sidebar, an inset browsing surface, large blue folder icons, grid/list views and a compact path/search toolbar. Details open on request from the top-right panel button. The colorful storage map, saved analyses and resizable panels remain available, with iOS Light and Dark appearances.

## Run the Windows app

Open **`dist/fxplorer-0.5.1-ios-preview-win-x64.exe`**. This is a portable Windows x64 executable; no Node.js installation is needed on the destination PC. The app extracts its runtime when launched. Keep the executable wherever you prefer. The previous `dist/fxplorer-0.4.0-win-x64.exe` and `dist/fxplorer-0.5.0-ios-preview-win-x64.exe` remain available for comparison.

This preview defaults to **iOS Light**, with **iOS Dark** available in Settings. Its settings, pins, review list, diagnostics and scan cache live separately in `%APPDATA%\fxplorer-ios-preview`; it does not migrate or clear the standard app's data. Explicit `--user-data-dir` profiles are respected for testing. The source and executable are local-only; no commit, push or release is implied.

Close an earlier iOS preview before opening this version. Both preview versions use the same local profile, so an already running instance would otherwise receive the launch.

This development build is unsigned, so Windows may show a reputation prompt. Preferences and the review list are saved locally in the current user's Electron application-data directory. No file data is uploaded, and the application has no telemetry or remote content.

## What it does

- Browse real folders, local drives and accessible network paths with a path bar, back/forward history, parent navigation, and up to 12 tabs.
- Adjust appearance through **Settings** in the sidebar: iOS Light, iOS Dark, Dark, Light, Windows, Pastel UI or seven Refractive Glass palettes. The iOS-inspired themes have their own blue accent and restrained surface treatment; **Solid panels** removes transparency. Glass intensity and accent choices remain saved for the other themes. Preferences persist locally. Use Ctrl+, to open settings.
- Choose **Pastel UI** for white rounded cards, sage controls, softly colored storage tiles and locally bundled Nunito typography, adapted from Priyanka Kumari's Pastel UI Kit. It has its own opaque appearance; glass and accent settings are preserved and apply again when returning to a Refractive Glass theme. See `THEME-CREDITS.md` for the reference and attribution.
- In the iOS-inspired workspace, switch between grid and list beside **Files & folders**. Click the folder breadcrumb or press Ctrl+L to edit the path. The details button opens or hides the inspector; grid/list and explicit details visibility persist across restarts. A single tab stays out of the way, with the top **+** opening another tab. Other themes retain their original workspace layout.
- Drag either vertical panel boundary to resize the navigation or details panel. Widths are saved locally across restarts. Double-click a boundary to restore its default. Focus a boundary and use Left/Right (Shift for larger steps), Home or End for keyboard resizing. The middle area keeps at least 560 pixels at the supported minimum window width; navigation is bounded to 160–420 pixels and details to 220–480 pixels, with tighter effective limits when needed.
- Analyze a folder in an isolated background process. Stop the analysis at any time, or navigate away to cancel it.
- Explore a colorful, size-proportional storage map that updates during analysis. Each block represents a direct child of the current location. Select a block for details; double-click a folder anywhere on its block to open it and redraw the map for its direct contents. Descendant folders are shown after entering their parent.
- Automatically save analysis metadata and detailed folder reports four levels deep. Navigate back, switch tabs or restart the app and reuse the saved measurements. Settings offers three, four or six retained levels. Deeper files are still included in totals until the scan entry limit is reached.
- Reopen recent saved analyses from the sidebar or Settings. View their timestamps, open their storage folder or clear saved reports from Settings.
- Sort files by name, size, type or modified date. The text filter matches the current list; largest-file and review views also match paths. The Dotfiles switch shows names beginning with `.` or `$`; it does not inspect Windows hidden/system attributes.
- Discover the 200 largest files across the analyzed folder and its subfolders.
- Inspect size, location and modification metadata, with a chart of file categories across the analyzed location.
- Preview text up to 128 KiB and PNG, JPEG, GIF, WebP, BMP and ICO images up to 8 MiB. Unsupported formats can be opened through Windows.
- Pin folders and maintain a persistent review shortlist. Marking an item for review does not change or remove it.
- Create folders, rename items, copy/paste files or folders within fxplorer, copy paths to the Windows clipboard, and reveal items in Windows Explorer. Copy/paste uses fxplorer's internal clipboard; it does not import files copied by another app.
- Move individual selected items to the Recycle Bin after a native confirmation. There is no permanent-delete action. Executables, scripts and shortcut-like files also require confirmation before opening.
- Export the current analysis as a JSON report.

Folder sizes are measured on demand and represent logical file bytes. Compressed, sparse and cloud-placeholder files can occupy different physical space. Scans include dotfiles, skip symbolic links/junctions and inaccessible entries, and stop at the selected entry limit (100,000, 250,000 or 1,000,000), visibly marking partial results. The balanced default is 250,000. Listings display up to 50,000 immediate entries; each saved folder report retains up to 5,000 immediate child records within a 2 MiB estimated metadata budget and aggregates additional children. Empty files/folders remain in the table but have no area on the map. More than 60 non-empty immediate children are grouped on the map; the table retains every listed item and loads rows in batches of 1,500.

Saved reports are gzip-compressed metadata in `%APPDATA%\fxplorer-ios-preview\scan-cache\v1` for this preview (`%APPDATA%\fxplorer\scan-cache\v1` in the standard app). File contents are not copied into the cache. Each analysis is limited to 5,000 folder reports / 64 MiB, with up to 12 analyses / 256 MiB retained overall. The oldest completed analyses are removed when needed; abandoned incomplete writes are recovered at startup. Limits can reduce the number of saved subfolders, and the interface labels limited or partial scans. Navigating deeper than the saved reports shows the live file list and offers analysis on demand.

Saved measurements are dated snapshots. F5 refreshes the live file listing and reuses saved sizes; **Analyze again** updates measurements after external file changes. Directory modification changes are flagged when detected; changes deep within a directory are not watched automatically. File operations performed inside fxplorer invalidate overlapping saved analyses, including partially failed copies. Canceling a replacement analysis preserves previous completed reports.

Copy operations never intentionally overwrite an existing destination. A failed recursive copy can leave a partial destination; the source is retained. There is no automatic cleanup, duplicate deletion, move/cut, multiselection, filesystem watcher, or recursive text search in this initial version.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Open folder | Ctrl+O |
| New / close tab | Ctrl+T / Ctrl+W |
| Address / filter | Ctrl+L / Ctrl+F |
| Back / forward / parent | Alt+Left / Alt+Right / Alt+Up |
| Refresh | F5 |
| Rename selected item | F2 |
| Copy / paste selected item | Ctrl+C / Ctrl+V |
| Recycle selected item | Delete, then confirm |
| Navigate rows / open / preview | Up/Down / Enter / Space |

## Develop and package

Requires Windows x64 and Node.js 22.12 or newer. Runtime and build versions are pinned in `package-lock.json`.

```powershell
npm ci
node node_modules/electron/install.js
npm start
npm test
npm run test:desktop
npm run test:cache-desktop
npm run test:layout-desktop
npm run test:pastel-desktop
npm run test:ios-desktop
npm run test:ios-workspace
npm run build:win
npm run test:packaged
```

`test:desktop` drives the real Electron UI against generated fixtures. `test:cache-desktop` checks four-level saved navigation, restart restore, cache controls, glass palettes and a live colored map. `test:layout-desktop` checks separator dragging, keyboard/cancel behavior, responsive constraints and saved widths. `test:pastel-desktop` checks the separate theme, native appearance, offline font, map/preview behavior, theme switching and restart. `test:ios-desktop` checks the preview appearances, text preview, settings and profile isolation; `test:ios-workspace` checks grid/list persistence, path editing, theme layout restoration, tabs, optional details and cached map/grid drilldown. `test:packaged` checks both the unpacked application and the portable executable, including isolated-process scanning from the packaged archive. These checks require permission to launch desktop processes. Generated fixtures, test profiles and screenshots stay in the ignored `.test-output/` directory.

The self-contained portable executable is in `dist/`; `dist/win-unpacked/` is the unpacked runtime used for verification and must be copied as a whole if used directly. Regenerate the original vector-drawn application icon with `powershell -File scripts/generate-icon.ps1`.

## Implementation

- `desktop/main.cjs`: native window, validated IPC handlers, dialogs and file operations.
- `desktop/preload.cjs`: a fixed, narrow bridge exposed to a sandboxed renderer.
- `desktop/filesystem.cjs`, `desktop/scan-hierarchy.cjs` and the process/worker adapters: metadata, bounded previews, drive discovery and cancellable streaming analysis. The desktop scanner runs in an isolated utility process with a 128 MiB V8 heap limit; scanner failures return an error to the UI.
- `desktop/scan-cache.cjs`: bounded compressed folder snapshots, atomic completion, root identity checks, pruning, invalidation and interrupted-write recovery.
- `ui/`: local HTML/CSS/JavaScript interface, original inline SVG icons and weighted rectangular map.
- `ui/ios-workspace.js` and `ui/ios-workspace.css`: theme-scoped Files-style composition, grid/list choice and optional inspector; the original controls and listeners are reused and restored for other themes.
- `tests/`: real-filesystem and desktop/package checks.

The renderer has Node integration disabled, context isolation and sandboxing enabled, no remote navigation or popup windows, a restrictive content-security policy, and no network connections. File content is displayed as text or raster data, never injected as executable markup. IPC handlers validate the calling frame and filesystem names. The app uses the current Windows user's permissions; it does not elevate itself.

Canonical project documentation belongs in the separate Revath vault under `Projects/fxplorer/`.
