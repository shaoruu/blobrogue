# blobrogue UI/HUD spec (ui designer, matched to LIVE build)

## Buttons/logo/title — DONE (shipped, awaiting gate)
Pixel arcade-dungeon buttons (.btn base = amber; .secondary = dark), press-down travel, Press Start 2P logo. In index.html <style> + menu.ts.
NEW: .btn--wide (supports a .sub subtitle line) for the quick-play CTA — apply when restyling menu structure.

## MENU structure to KEEP (just restyle in place with .btn classes)
Name input (placeholder "your blob name") → wide "▶ quick play (co-op)" CTA WITH subtitle line → row [play solo | private room] → "join with code" → footer controls hint. Keep the ghosted HUD-preview in menu top-left. Keep all copy.

## HUD anchoring (minimap already exists top-right — don't collide)
- TOP-LEFT: unified .statpanel = hearts row + chip row (FLOOR / skull+kills / coin+coins). Consolidates today's separate hearts + text pills.
- TOP-RIGHT: KEEP minimap, restyle (dark base, ink outline, amber inner keyline + faint glow).
- BOTTOM-RIGHT: weapon pill (name + ammo).
- BOTTOM-LEFT: dash cooldown bar (Shift dash).
- Icons via the ICONS rasterizer (hearts/skull/coin/gun) from the spec; HUD stays a DOM overlay, canvas-draw the pixel icons into it.

## SOURCE (on ui designer's checkout, NOT on main — request inline CSS when building HUD/panels)
BLOBROGUE_UI_SPEC.md ("ADDENDUM — matched to the LIVE build" section) + ui-kit-preview3.html (restyled menu + minimap-aware HUD rendered).

## Build order: buttons/logo (done) → overlay/frame panel → menu restyle w/ .btn--wide → HUD (statpanel + minimap restyle + weapon pill + dash bar).
