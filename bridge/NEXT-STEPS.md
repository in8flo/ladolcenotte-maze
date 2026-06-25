# LED maze — next steps (picking up tomorrow)

Target: finished and portable for **Thursday night (Vegas)**.

## Where we are (all working)
- Full chain proven: **Foundry (Forge) → bridge.py → Pico → LEDs**.
- Firmware is the **batched serial listener**, saved as `code.py` on the Pico — runs
  on boot (red flash), survives a full-frame flood.
- Bridge mapping is **geometric** and validated (column 0 = 38 LEDs; bottom tile =
  LEDs 36,37, matches the real strip). Order is correct: starts top-left, **down**
  col 0, **up** col 1, snaking left→right.
- **What's left:** the even spacing assigns *boundary* LEDs (ones that straddle two
  tiles) to a tile, so they light when they shouldn't (e.g. E3's top LED bleeding
  into the E4 hedge), and a couple columns drift (Eleanor's tent shifted up). We
  need an **explicit, hand-verified tile→LED map** for one quadrant.

## PART 1 — Map one quadrant exactly (then auto-mirror to all 5)

Goal: each tile lights only the LED(s) clearly inside it; LEDs stranded *between*
tiles stay dark.

Plan for tomorrow:
1. **I build an interactive mapper** (right in chat): a 5×25 quadrant grid in your
   labels — **columns A–E left→right, rows 1–25 from the bottom** — pre-filled with
   the current geometric guess, showing each tile's LED indices + the snake path.
2. **You run the walk:** `python bridge.py --port COMx --calibrate` → `walk 0 0.3`.
   One LED lights at a time; you see physically which tile it's in (or if it's
   stranded on a boundary).
3. **You correct in the widget:** drop the between-LEDs so they stay dark, nudge any
   LED into its true tile. Most are already right — only the off ones need a tap.
4. **It sends me the exact map;** I encode it as an explicit lookup (boundary LEDs
   excluded) and mirror it to all five quadrants automatically.

Fallback if the widget is clunky: just tell me, per column top-to-bottom, the LED
index(es) for each tile and which to skip. The widget should be faster.

## PART 2 — Make it run on your laptop (and as hands-off as possible)

The good news: **Foundry and the module live on The Forge (cloud)** — nothing to
move. Just open the browser on the laptop and log in. Only the **bridge** runs
locally (it talks to the USB Pico), and the **Pico** you just bring (firmware's
saved on it).

So on the laptop you only need: the bridge code + Python + 2 libraries. Tomorrow
I'll make this as turnkey as possible:

- **Auto-detect the Pico's COM port** — so you just run the bridge with no `--port`
  (handles the laptop's different port numbers).
- **Best case — a standalone `.exe`:** I'll try to build a single double-click
  launcher with no Python install needed. Copy it to the laptop, plug in the Pico,
  double-click → it finds the Pico and runs. (Foundry's already in the cloud.)

If the `.exe` route hits snags, the manual path is small:
1. Install **Python 3** from python.org (tick "Add Python to PATH").
2. Get the code — `git clone https://github.com/in8flo/ladolcenotte-maze.git`
   (or copy the `ledmaze` folder via Google Drive / USB).
3. In `ledmaze/bridge`: `pip install websockets pyserial`.
4. Plug in the Pico → `python bridge.py` → set Foundry LED output mode to a bridge
   mode → F5.

## Tonight
Nothing to do — everything is committed and pushed to GitHub, so it's backed up and
already clone-able onto the laptop. Rest up. 🌙

## Tomorrow's order of attack
1. Finish the exact tile map (Part 1) — the gameplay-critical bit.
2. Add Pico auto-detect + (try) the `.exe` so the laptop "just works" (Part 2).
3. End-to-end dry run on the laptop with the Pico before Thursday.
