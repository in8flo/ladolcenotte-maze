# Game-Day Checklist — LED Maze

Run through this once before the session. It targets the exact failure from the
first live run (the bridge link freezing mid-game).

## The night before
- [ ] Re-download the latest code onto the laptop (Code → Download ZIP) so it has
      the auto-reconnect fix and the bridge-side recovery.
- [ ] Update the Foundry module on Forge to **v1.11.0+** (Manage Modules → Update),
      then hard-reload.
- [ ] Finish printing any remaining hedges (budget from your slicer's total time).

## Laptop power settings (this is what killed the link last time)
Windows suspends USB and sleeps the machine on battery — that dropped the bridge.
- [ ] **Plug the laptop into AC power** for the whole session.
- [ ] Settings → System → Power → Screen & sleep → set **all** sleep timers to *Never*
      while plugged in.
- [ ] Device Manager → Universal Serial Bus controllers → each **USB Root Hub** →
      Properties → Power Management → **uncheck** "Allow the computer to turn off
      this device to save power."
- [ ] Control Panel → Power Options → your plan → Change advanced settings →
      **USB settings → USB selective suspend → Disabled.**

## Setup order at the table
1. [ ] Plug in the Pico. Wait for all 5 quadrants to flash red (firmware alive).
2. [ ] Double-click `start-bridge.bat`. Wait for "listening for Foundry."
3. [ ] The hedges light green immediately — confirms the bridge + Pico are good.
4. [ ] Open Foundry, set output mode to a bridge mode, then **F5**.
5. [ ] Check the DM panel: the top banner should read **🟢 LED bridge connected**.

## During play — what's different now
- If the link ever drops, the panel banner turns **🔴 red and pulses**, and you get
  a warning toast. **You no longer need to do anything** — it auto-reconnects every
  3s and repaints the whole maze the instant it's back. No more kill-the-bat + F5.
- If red persists more than ~15s: check the Pico's USB cable, then look at
  `bridge/bridge-log.txt` — it timestamps every connect/drop/serial error.

## If you still want a manual reset
Closing and reopening `start-bridge.bat` is always safe — on reconnect the module
resends the full state automatically.
