# Agent 007 — Design System

## Identity

Agent 007 is a pixel office for managing AI terminal agents. The aesthetic is
dark, terminal-native, with spy/espionage personality. UI should feel like a
mission control dashboard — calm, information-dense, utility-first.

**Logo:** Golden martini glass (filled, with olive) placed inline between
"Agent" and "007" in the app title. Favicon uses the same martini glass SVG.

**Brand color:** Gold `#d4a847` — used as the accent color throughout.

## Naming Conventions

**Agents** — Spy codenames from a fixed pool:
`Shadow, Phantom, Viper, Cipher, Raven, Onyx, Echo, Spectre, Falcon, Ghost, Dagger, Mirage, Cobra, Apex, Ember`

Random assignment, recycled on agent death. User can override with custom name.

**Branches** — Cocktail names with `{git-username}/` prefix:
`bill/vesper, bill/martini, bill/gimlet, bill/negroni, bill/sidecar, bill/daiquiri, bill/manhattan, bill/mojito, bill/paloma, bill/sazerac, bill/aviation, bill/bellini, bill/spritz, bill/collins, bill/julep, bill/highball, bill/rickey, bill/fizz`

Git username read from `git config user.name`, lowercased, spaces to hyphens.
Falls back to `agent` if not configured. User can override with custom branch name.

## Color System

Two themes: dark (default) and light. Gold accent in both. Persisted to localStorage.

### Dark Theme (default)
```css
--bg-dark:       #090a0c    /* deepest: headers, panel tops */
--bg-panel:      #0f1114    /* panels: explorer, terminal */
--bg-office:     #131519    /* pixel office canvas */
--bg-terminal:   #07080a    /* terminal viewport */
--bg-tabs:       #0d0e11    /* tab bar */
--border:        #1f2228
--text:          #d8dce4    /* primary text */
--text-muted:    #9ca3af    /* secondary text (agent names, buttons) */
--text-dim:      #6b7280    /* tertiary text (branches, labels) */
--accent:        #d4a847    /* gold: interactive elements, brand */
```

### Light Theme (Linear-inspired warm palette)
```css
--bg-dark:       #f2f1ee    /* headers, sidebars */
--bg-panel:      #f9f8f7    /* content panels */
--bg-office:     #f2f1ee    /* pixel office */
--bg-terminal:   #f9f8f7    /* terminal */
--bg-tabs:       #f2f1ee    /* tab bar */
--border:        #e4e2dd
--text:          #222222
--text-muted:    #6b6b6b
--text-dim:      #999999
--accent:        #a07d2e    /* darker gold for contrast on light bg */
```

### State indicators (shared across both themes)
```css
--state-working:      #d4a847    /* yellow: agent is producing output */
--state-waiting:      #7fbc6a    /* green: agent is at a prompt */
--state-message:      #e0853a    /* orange: agent needs attention */
--state-idle:         #4a4e58    /* gray: no activity */
--state-disconnected: #c44040    /* red: process exited */
--state-recording:    #c44040    /* red: voice input mic is live (same red as disconnected) */
```

### Terminal ANSI Colors (dark theme — GitHub dark palette)
```
black: #6e7681    red: #ff7b72     green: #3fb950    yellow: #d29922
blue: #58a6ff     magenta: #bc8cff cyan: #76d9e6     white: #c9d1d9
brightBlack: #8b949e  brightRed: #ffa198   brightGreen: #56d364  brightYellow: #e3b341
brightBlue: #79c0ff   brightMagenta: #d2a8ff  brightCyan: #a5d6ff  brightWhite: #f0f3f6
```

## Typography

- **Font stack:** `'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace`
- **Sizes:**
  - 9px — panel labels (REPOS), uppercase, letter-spacing: 2-3px
  - 10px — branch labels, diff viewer, loading text
  - 11px — explorer items (files, agents), form labels
  - 12px — terminal tabs, form inputs, repo/branch in terminal header
  - 13px — terminal header agent info
  - 14px — app title (bold, letter-spacing: 1px)

## Text Hierarchy

Three levels of text prominence:
- `--text` — Primary content, headings, repo names, app title, buttons
- `--text-muted` — Secondary content, agent names, branch names, labels
- `--text-dim` — Hints, placeholders, inactive items, panel section labels

## Layout

Three-panel layout with per-panel headers:

```
┌─────────────┬──────────────┬────────────────────────┐
│ Agent🍸007  │ + New Agent  │ Repo: 007bot  ⚡ main ☀│
│ REPOS [+↻<] │              │                        │
├─────────────┼──────────────┼────────────────────────┤
│             │              │ [tab1] [tab2] [tab3]   │
│  Explorer   │  Pixel       │────────────────────────│
│  (file      │  Office      │                        │
│   tree)     │  (canvas)    │  Terminal (xterm.js)    │
│             │              │                        │
└─────────────┴──────────────┴────────────────────────┘
```

- **Panel headers:** All use `--bg-dark` background for visual continuity
- **Dividers:** Gradient top (matches header bg) + border below. Gold on hover.
- **Explorer:** Two-row header (logo row + REPOS row), collapsible via Cmd+E
- **Office:** Centered "+ New Agent" button
- **Terminal:** "Repo:" label + repo name + branch icon + branch name + theme toggle in the header; the voice-input mic floats at the viewport's bottom-right, next to the prompt line
- **Terminal tabs:** Draggable for reordering, order persisted to localStorage
- Panel widths persisted to localStorage
- Below 900px: explorer auto-hidden

## Pixel Office

Canvas-rendered pixel art workstations at Z=3 scale factor.

### Workstation grid
- Cell: 32w x 36h pixels (96 x 108 screen px)
- Gap: 12px horizontal, 18px vertical
- Max 4 columns, responsive to panel width
- **Centered placement** — grid is vertically centered on full canvas height

### Workstation anatomy (back-to-front draw order)
1. **Monitor** — 14w x 9h, 1px uniform bezel, content varies by state
2. **Monitor stand** — 2w centered, 1px tall neck + 4w base
3. **Desk** — sprite-based (desk.png / desk2.png), top 13 rows cropped
4. **Character** — state-dependent:
   - WORKING: back-facing, close to desk (sy+13)
   - WAITING/IDLE/MESSAGE: front-facing, leaned back (sy+18)
   - DISCONNECTED: pixel art X pattern, no character
5. **Name tag** — bold 11px monospace, centered below character
   - Active: gold `#d4a847` with pulsing glow animation
   - Inactive: `--text-muted` with 0.7 opacity

### Monitor screen states
- **WORKING:** Animated colored code lines scrolling
- **WAITING:** Shows +additions/-removals (green/red) if changes exist, else prompt chevron with blinking cursor
- **MESSAGE:** Accent-colored text lines with thought bubble (three dots)
- **IDLE:** Same as WAITING
- **DISCONNECTED:** Dark screen

### Message bubble
- Accent-colored dots (not hardcoded orange), positioned relative to character
- Only shown for MESSAGE state (agent needs user input)

### Room elements
- **Walls:** Fixed warm cream plaster, independent of UI theme
- **Floor:** Warm wood planks, fixed base `#4a3525`
- **Windows:** Two windows with day/night cycle based on local time
- **Seating:** Three U-shaped nooks with couches and armchairs
- **Plants:** Potted plants under windows
- **Particles:** 5 ambient dust motes

## Interactive Behaviors

### Icon buttons
- Shared `.icon-btn` primitive (formerly `.theme-toggle`): theme toggle in the
  terminal header; the voice mic reuses it with the `.voice-fab` overlay class

### Voice input
- Mic button floats bottom-right of the terminal viewport (`.voice-fab`,
  34px, shadowed, clears the xterm scrollbar) so it sits next to the prompt
  line being dictated into
- Mic button pulses `--state-recording` red while listening (`mic-pulse`)
- Transcript pill is anchored to the mic (right-aligned with the fab, one
  row ABOVE it, growing leftward) so the reaction appears where the user
  clicked without ever covering the terminal's last row — that row is where
  dictated keystrokes echo; it slides up from the mic (`pill-in`) on show
- Fab/pill/presence geometry all derive from `--voice-fab-*` custom
  properties on `:root`; the presence pill is stacked above the voice column
  (`bottom: var(--voice-column-top)`) so it can never sit on the mic and eat
  its clicks, and resizing the fab moves the whole column together
- The recording signals (button pulse, live dot, screen-reader "started")
  turn on only after `getUserMedia` grants — the requesting phase uses the
  dot-less notice variant
- `prefers-reduced-motion: reduce` disables the pulse and slide animations
- The pill's pulsing dot means "recording" — hidden on notice/error variants
  (the mic is off there; a red dot would be an inverted privacy signal)
- Screen-reader announcements go to a visually-hidden `.sr-only` live region

### Theme toggle
- Sun/moon SVG icons in terminal panel header
- Toggles between dark and light themes
- Terminal colors update in real time (full ANSI palette swap)

### Auto-reload on reconnect
- WebSocket reconnection triggers full page reload
- Clears stale agent state after server restart

### Clipboard paste
- Cmd+V with image data in clipboard uploads as screenshot
- Uses capture phase to intercept before xterm.js

### New agent spawning
- Newly spawned agent auto-activates (switches terminal tab)
- Empty repos get automatic initial commit

### Branch sync
- Branch name updates in real time in explorer and terminal header
- Server polls branch on every file tree scan cycle
