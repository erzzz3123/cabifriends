# Handoff: Cabi & Friends directory

## Overview
Cabi & Friends (friends.cabifoods.com) is a curated directory of the people, producers, farmers, restaurants, shops and makers Cabi Foods works with across Japan. Two views share one dataset: a dense editorial **Directory** and a **Map** of all 47 prefectures. Each Friend has a profile page. The whole interface switches between English and Japanese.

## About the design files
`index.html` is a working **high-fidelity prototype** in vanilla HTML/CSS/JS. It is already wired to the Vercel API and can ship as-is. If you move it into a framework (React/Next, Astro, etc.), recreate it pixel-for-pixel using that framework's patterns; treat `index.html` as the source of truth for look and behaviour.

## Fidelity
High-fidelity. Final colours, type, spacing and interactions.

## Global
- Page background `#FFFFFF`. Ink `#432F29` (Cabi Black, warm brown — never pure black).
- Muted text `rgba(67,47,41,.74)`. Soft rules `var(--cf-rule-soft)`. Hover fill `var(--cf-hover)` (both in `_ds/tokens/friends.css`).
- Font: **Ginto Light** (`fonts/Ginto-Light.ttf`, weight 300) for everything, with JP fallback `Hiragino Kaku Gothic ProN, Yu Gothic, Noto Sans JP`. Body `text-transform: uppercase`, `letter-spacing: .02em`, 15px / 1.5.
- Meta/UI labels: 11–12px, `letter-spacing: .06em`, weight 400, uppercase.
- The util bar, header, main and footer are rendered at `zoom: .9` (everything was scaled 10% down). In a rebuild, bake the 0.9 factor into sizes instead.
- Page side padding `--pad: 40px` (16px under 760px).
- Rules: 1px `#432F29` for section dividers; soft rule for rows. No shadows. No gradients except the map panel's "↓ Scroll" fade.
- Corners: 10px on cards/photos, 40px on tags/chips, 8px on the map tooltip, 14px top corners on the mobile bottom sheet.
- Selection: ink background, white text.
- Links: ink, no underline; hover underline 1px, offset 3px.

## Screens

### Util bar (30px, bottom rule)
Left: tabs "Cabi Foods ↗" (external) and "Cabi & Friends" (active: ink fill, white text), each with a right rule. Right: language toggle `EN / 日本語`, active underlined, inactive muted. Choice persists in `localStorage.cf_lang`.

### Header (100px, bottom rule)
Cabi & Friends lockup (`assets/cabi-friends-black.png`, 96×72 box, background-size 214px). Nav right: Directory · Map · About · Submit a Producer | Cabi Foods ↗. 12px uppercase; active/hover = 1px bottom border.

### Explore bar (Directory + Map)
Row with bottom rule: search input (12px, 35px tall, placeholder "Search friends, places, ingredients…"; `/` focuses, Esc clears) and text controls styled as `[ ] Label` / `[•] Label`: Directory · Map, List · Grid, "Sort: …" (cycles No. 1 → / Random / Recently added / A–Z / North → South), Filter (n), Random Friend ↝.
Filter panel (hidden by default): three rows — Type, Food (top 12 + "+ N more"), Place — of pill tags with counts. Hovering a tag dims non-matching rows/dots to 22% opacity; clicking toggles it (AND logic).

### Directory — List (default)
Two equal columns, 30px gap.
- **Left (index)**: padding-left 100px. Entries in one column, 34px apart; each is a 56px index column `[01]` + three lines: English name, Japanese name, `Prefecture · Makes`. 13px / 1.38.
- Hover an entry: text italicises; a strip of 3 photo thumbnails (64px tall, natural aspect, 10px gap) fades in 8px below.
- Click a thumbnail or entry: thumbnails close in a **staircase** (right to left, 260ms stagger, 420ms each, `scale(.6,0)` + fade, `cubic-bezier(.5,0,.75,0)`), while the clicked image **flies** (FLIP, 620ms `cubic-bezier(.22,1,.36,1)`) into the right panel. Other entries dim to 28%.
- **Right (detail panel)**: sticky (top 16px, max-height viewport − 32px, scrolls internally, no scrollbar). Header: name EN + JA, `Prefecture · Makes`; actions "Open profile →", "Close ×". Then all photos stacked and centred at natural aspect (widths cycle 100% / 86% / 72%), each with caption `fig. N   caption`, then description. Panel content fades in 250ms after a 350ms delay.
- Yamada Seiyu is open by default. Esc or clicking empty list space closes.
- Under 760px: panel hidden, thumbnails always visible and scroll horizontally, tapping opens the profile.

### Directory — Grid
4 columns (2 on mobile), 36×16px gap. Card: 891:952 photo, radius 10, number pill top-left; hover overlays ink at 94% with JP prefecture, coordinates, makes; title swaps EN → JA on hover. Tag links below.

### Map
Grid: map (flex) | 380px index panel, top rule.
- d3 Mercator of 47 prefectures (`assets/japan-topo.js`), Okinawa in an inset box top-left. Dashed graticule at 30/35/40/45°N and 130–145°E with labels.
- Fills: white (no Friends), ink 13% (has Friends), ink 34% (known for current search), ink (selected). 0.6px stroke.
- Dots: ink 4.5px circles, white 1.5px stroke, grow to 8px on hover. Fade in north→south, 90ms stagger after 250ms.
- Tooltips (ink, white text, radius 8): prefecture = name EN/JA, "Known for", Friend count. Dot = name, JA, makes, city, 3 thumbnails (64px tall).
- Index panel: "47 prefectures in Japan", search results when active, then prefectures grouped by region with superscript Friend counts. Sticky "↓ Scroll" fade at bottom, hides at end.
- **Prefecture drawer**: click a prefecture, dot or name → 380px panel slides in from the right over the index (450ms `cubic-bezier(.2,.7,.2,1)`). Content: `Pref. 07 · Region`, Close ×, name 40px uppercase + JA 24px, description, Known for (tags → search), In season (Spring/Summer/Autumn/Winter), Cabi's Friends in X (rows → profile, or "Know someone in X? →" linking to Submit with the prefecture prefilled), Nearby (tags). URL becomes `#/map/:pref`. Esc closes.
- Under 760px: drawer becomes a bottom sheet (max 82vh, grab handle, dimmed backdrop, 44px close target).
- Legend bottom-left; "Random prefecture" button bottom-right.

### Friend profile (`#/friend/:slug`)
Grid 4fr (min 300px) | 8fr, 30px gap.
- Left, sticky: ← Back to Directory; name 30px + JA 18px; sections with 11px muted headings — Information (Category, Location, Makes, Maker, Friend since, Website, Instagram as a 120px key/value list), Description + story, Why they're a Cabi Friend, Craft (Specialties, Ingredients, Methods), Tags, Location (300×260 mini map + coordinates).
- Right: photos, radius 10. fig. 1 at 3:2, then fig. 2 + 3 side by side at 4:5, then the rest at 3:2. Captions `fig. N  caption`.
- Below: "Keep wandering" path (Friend → Prefecture → Food → next Friend), three columns (Place, Food, Related Friends), pager (← prev · Random · next →).
- Mobile: single column, photos first.

### About (`#/about`)
Two columns: heading "A directory of our friends across Japan." + stats (Friends, Prefectures with Friends, 47 Food guides); four paragraphs + Visit Cabi Foods ↗ / Submit a Producer.

### Submit a Producer (`#/submit`)
Form (2-column field grid) + 340px sticky note. Toggle "I'm the producer / I'm recommending someone" (changes the name label). Fields: Your name*, Business name*, Japanese name, Category, Location, Prefecture* (grouped by region; `?pref=` prefills), What they make, Their story, Website, Instagram, Email*, Photos (up to 6). Fields are underline-only; focused underline turns ink. Posts multipart to `/api/submit`; shows a thank-you state.

### Footer (120px, top rule)
Cabi wordmark (`assets/cabi-logo-black.png`) + "Cabi & Friends is a project by Cabi Foods"; right "Shop Cabi Foods ↗".

### Intro
On first load of the Directory, the page shows a grey ground (ink 58% mixed with white) with only the logo for ~500ms, then the bars appear, then content (~1.2s total), with a 550ms background cross-fade.

### Image loading
Images start at opacity 0 and fade in (280ms) after decode with a random 80–500ms delay.

## State
`lang`, `view` (directory|map), `layout` (list|grid), `q`, `tags` (Set of `type:` / `food:` / `place:` keys), `sort`, `open` (selected Friend in list), `openI`, `sel` (selected prefecture), `preview` (hovered tag), `showFilters`. Routing is hash-based.

## Data
`FRIENDS[]`: id, slug, name_en, name_ja, prefecture (slug), city, latitude, longitude, category (Producer|Farmer|Restaurant|Shop|Craft), makes, maker, since, tags[], specialties[], ingredients[], methods[], description, story[], relationship_to_cabi, website, instagram, works_with[], images[{src, caption}].
`PREFS[]` (47, in JIS order): slug, name_en, name_ja, region, description, specialties[], seasonal_foods[4].
Live from `/api/data` (Supabase), fallback `data.js`. Only Airtable rows with **Published** ticked appear.

## Assets
Logos from the Cabi Design System (`assets/cabi-friends-black.png`, `assets/cabi-logo-black.png`). Friend photos in `assets/friends/<slug>/` (sample set — real photos should come through Airtable's Photos column). Prefecture geometry in `assets/japan-topo.js`. Most Friends currently show grey placeholder blocks.

## Open items
- Real photos for all Friends.
- Prefecture food-guide full pages exist in code (`renderPref`) but are switched off (`PREF_GUIDE=false`); the map drawer replaces them.
- JA translations for Friend descriptions/stories are not yet in the data.
