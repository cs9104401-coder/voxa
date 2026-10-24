# Voxa UI design rules
Original design, dark and calm. Never copy another product's assets, copy or branding.

## Tokens (define once in renderer/style.css :root; no hard-coded colors elsewhere)
bg #0f1013, surface #17181c, surface-2 #1b1d23, surface-3 #22242b, border #2a2c33, text #f2f3f5, muted #9aa0ab, one accent (soft blue), plus ok/warn/danger. Radii 8/12/14/16/28. 8px spacing grid. Type scale 12/14/16/18/28 with the Segoe UI Variable or Inter stack. Inline SVG icons, 1.5px stroke, one style.

## Components (reuse, do not reinvent)
Button, IconButton, Toggle, Keycap, Card, Row, Badge, Segmented, Select/Combobox, Carousel, Toast. Every interactive element has hover, active, focus-visible and disabled states and works by keyboard.

## Layout
Pages scroll inside their own container, never the window. Works from 860 to 1600px wide with no overflow or clipping. Long text ellipsizes. Never show raw stack traces; show a human reason and a fix hint. Every list has empty, loading and error states.

## Island/notch overlay
- One fixed-size transparent window with padding for the shadow. Never setBounds per state. showInactive, focusable false, alwaysOnTop screen-saver, click-through except over the pill and card. Follows the display under the pointer; handle DPI and multi-monitor.
- One persistent pill element; states are CSS classes. Animate width, height and border-radius with CSS transitions (about 380ms, spring-like linear() easing) using ResizeObserver-measured sizes. Crossfade inner layers (opacity plus slight blur/scale). Never replace the pill with innerHTML.
- The animation controller is interruptible: retarget from current values, never snap. Hide the window only after the exit animation ends. Pause waveform and timers while hidden. prefers-reduced-motion means fades only.
- Waveform from real mic level with fast attack and slow release; thinking = staggered dots; error = small shake.

## Test matrix (ui-gallery must cover)
Every overlay state including long text and approval with long content; every dashboard page with fake data and empty data; 100/125/150/200% scaling.