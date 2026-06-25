# Laptop setup for Vegas — one-time, ~10 minutes

The game runs from the laptop in Vegas. **Foundry and the module live in the cloud
(The Forge), so there's nothing to move there** — you just log into Foundry in the
browser. The only thing that runs locally is the **bridge** (it talks to the Pico
over USB). The **Pico carries its own firmware**, so you just bring the board.

Do these steps on the laptop **before you leave**, while the Pico is here to test with.

## 1. Install Python (one time)
- Get it from <https://www.python.org/downloads/>.
- Run the installer and **tick "Add Python to PATH"** on the first screen. (Important.)

## 2. Get the code
Pick whichever is easier:
- **Git:** `git clone https://github.com/in8flo/ladolcenotte-maze.git`
- **Or no Git:** on GitHub, **Code → Download ZIP**, then unzip it somewhere easy
  (e.g. `Documents\ladolcenotte-maze`). Google Drive / USB stick works too — you only
  need the `ledmaze` folder.

## 3. Test the bridge with the Pico (do this here, before Vegas)
1. Plug the Pico into the laptop's USB.
2. Open the `ledmaze\bridge` folder and **double-click `start-bridge.bat`**.
   - First run installs two small libraries automatically (needs internet — do it here).
   - It auto-detects the Pico (don't worry about COM numbers) and prints
     `listening for Foundry`.
3. In the browser, open the Foundry world on The Forge.
4. In the module settings (**Configure Settings → La Dolce Notte**): set **LED output
   mode** to a bridge mode, **LED Bridge URL** = `ws://localhost:8765`.
5. **Press F5** in Foundry (the module only connects to the bridge on page load).
6. Move a token → the LEDs light. ✅ If they do, the laptop is ready.

## In Vegas (every session — 30 seconds)
1. Plug in the Pico.
2. Double-click `start-bridge.bat`.
3. Open Foundry in the browser, press **F5**.
4. Play.

## If something's off
- **LEDs dark / nothing happens:** make sure you pressed **F5 in Foundry after** the
  bridge window said "listening". The module only connects on page load.
- **"no Pico auto-detected":** unplug/replug the Pico; close Thonny if it's open (only
  one program can use the USB port at a time); then re-run the launcher.
- **Want to see ports:** run `python bridge.py --list-ports` — it marks the Pico.
- **Tile mapping looks off:** double-click `calibrate.bat` for the mapping tools.
