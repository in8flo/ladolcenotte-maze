# Testing the Maze Module on The Forge (Overlay Phase)

This is the step-by-step Mike follows to test the La Dolce Notte maze/horde
module in Foundry on **The Forge**, with the **on-screen LED overlay** standing
in for the physical LEDs. No hardware, no Python bridge needed for this phase.

The overlay draws the *exact* cell colors the real LEDs would show, as
translucent squares on the Act 2 scene.

---

## 0. One-time: install the module on The Forge

> This URL works once the repo is published and the first `v*` tag has built a
> release (see `PACKAGING.md`).

**Manifest URL:**

```
https://github.com/in8flo/ladolcenotte-maze/releases/latest/download/module.json
```

1. Log into The Forge → **My Foundry** → launch your Foundry instance.
2. In Foundry: **Game Settings → Manage Modules → Install Module**.
3. Paste the manifest URL into the **Manifest URL** box at the bottom → **Install**.
4. Wait for "Installation complete".

> The Forge can also install from the **Bazaar**; the manifest-URL route above
> works on any tier and is the one to use here.

---

## 1. Enable it on the Act 2 world

1. Launch the **Act 2** world (the one with the maze chase scene).
2. **Game Settings → Manage Modules**.
3. Check **"La Dolce Notte — Maze & Horde"** → **Save Module Settings** (the
   world reloads).
4. As GM you'll see a notification: *"La Dolce Notte maze module loaded…"*.

> Everything below is **GM-only**. Players never see the panel, the overlay
> toggle, or trigger horde advancement.

---

## 2. Confirm output mode = overlay-only

1. **Game Settings → Configure Settings → La Dolce Notte — Maze & Horde**.
2. **LED output mode** should be **"Overlay only (on-screen, no hardware)"** —
   this is the default. Leave it there for this phase.
   - The other modes (`Overlay + LED bridge`, `LED bridge only`) are for when the
     physical build is wired. With no bridge running they do nothing harmful, but
     overlay-only is the clean test setting.

There is **no error and no hang** when the LED bridge is absent — that's the
whole point of this phase.

---

## 3. Open the Act 2 scene and confirm the overlay

1. Open the **Act 2 maze scene**.
2. You should see a faint grid of colored squares over the maze:
   - dim **amber** corridors,
   - colored **tents** (Sal orange, Eleanor red, Everly blue, Lavinia purple,
     Rupert teal),
   - pulsing **magenta portals**,
   - yellow-green **sprites**,
   - crimson **prison**.
3. **Toggle the overlay** any of three ways:
   - the **▦ "Toggle LED Overlay"** button in the left token-tools toolbar,
   - the **Shift+O** hotkey,
   - the **On-screen overlay** button in the 🎭 panel (step 5).

### If the overlay doesn't line up with the maze art

The overlay maps maze cell → grid square. If your scene has padding or the maze
art doesn't start exactly at grid cell (0,0), nudge it:

1. **Configure Settings → Maze grid offset — X / Y (cells)**.
2. Increase **Y** to push the overlay **down**, **X** to push it **right**
   (one step = one grid cell). Negative values move it up/left.
3. Turn on **Debug: log token cells** (same settings page), open the browser
   console (**F12**), and drag a token onto a known maze cell — the console
   prints the computed `row, col`. Adjust X/Y until a token on the maze's
   top-left walkable cell logs `row 0, col …` matching the maze data.
4. **Overlay opacity** is on the same page (and in the panel) if it's too strong
   or too faint.

---

## 4. Drop player tokens and confirm they light up

1. Drag your **player-character** tokens onto the maze (must be Actor type
   **character** — NPC tokens are ignored on purpose).
2. Each token's cell lights at **full brightness** in that PC's color
   (Vis white, Bob amber, Lys gold, Gideon brown, Carter cyan; any other name
   defaults to white).
3. **Move a token** — its lit cell follows it, one grid square at a time.
   - With **Debug** on, every move logs the `row, col` to the console.

---

## 5. Open the 🎭 Horde Control panel

1. In the **token tools** (left toolbar), click **🎭 "La Dolce Notte — Horde
   Control"**.
2. The panel shows live status (horde state, mode, front row, rounds, pending
   sprints), all the config sliders, overlay controls, and test buttons.

### Test the overlay rendering (no hardware)

- **Test Panels** — lights the four Pico row-bands in distinct colors
  (rows 0–6 red, 7–12 green, 13–18 blue, 19–24 amber). Confirms top-to-bottom
  alignment.
- **Rainbow** — a hue sweep across the columns.
- **Clear** — drops the test pattern and returns to the live game state.

---

## 6. Unleash the horde and watch the green wall climb

1. (Optional) Set **Mode** to *Split party* or *Together* and tweak the config
   fields — all changes are live and persist.
2. Click **🌊 Start Horde**. The horde appears as a solid **green wall** at the
   south edge (bottom rows).
3. Advance it:
   - Run Foundry's **Combat Tracker** and click **Next Round** — after the
     start-delay rounds, the wall climbs automatically each round (a GM chat
     whisper reports the new front row), **or**
   - click **⏭ Advance Now** in the panel to step it manually.
4. Watch the green wall climb north toward the tents and players in the overlay.

---

## 7. Sprite sprint

1. Move a player token across a **sprite** cell (yellow-green).
2. You'll get a notification: *"… disturbed a sprite! Horde will sprint +N next
   round."*
3. On the next advance, the wall jumps the extra rows (the chat message notes the
   sprint). Each sprite only triggers once.

---

## 8. Swarm Tactics

1. With the horde overlapping a player's cell, start that token's **turn** in the
   Combat Tracker (it must be a character token inside the green wall).
2. The **Swarm Tactics — The Ecstasy** dialog fires: DC 13 Wisdom save, with
   buttons for **2d6 psychic**, **Charmed (move deeper)**, or **Passed**.
3. Picking an option posts the result to chat.

---

## 9. Confirm config is live and persists

1. Change **Start delay**, **Split/Together speed**, **Sprite sprint**, or
   **Swarm DC** in the panel — they take effect immediately.
2. Reload the world — the horde state and config persist (stored on the world).

---

## Definition of done (this phase)

- [x] Module installs on The Forge via the manifest URL
- [x] Overlay draws the 25×25 LED state on the Act 2 scene, aligned to the maze
- [x] Player tokens light their cells as they move
- [x] Horde advances visually as a green wall when unleashed
- [x] Sprite crossing speeds the horde and posts a message
- [x] Swarm Tactics dialog fires on a turn started in the horde
- [x] All config values are live-editable and persist
- [x] No errors when the LED bridge is absent (overlay-only mode)

---

## Notes for the hardware phase (later)

- Switch **LED output mode** to *Overlay + LED bridge* (to keep the on-screen
  view while driving LEDs) or *LED bridge only*.
- Start the Python bridge (`python bridge/bridge.py`) before opening the scene;
  set **LED Bridge URL** if it isn't `ws://localhost:8765`.
- The module emits the same cell→color map either way — only the bridge changes
  when the physical LED layout is finalized.
