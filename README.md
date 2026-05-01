# Dramatic Peninsula 🎵

> A GNOME Shell extension that turns your laptop's physical notch into a
> music widget — like Apple's Dynamic Island, but on Linux, held together
> with DBus calls and optimism.

---

## What is this?

Apple has the **Dynamic Island**. It's polished, it's animated, it's the
centerpiece of their marketing.

You have the **Dramatic Peninsula**. It's attached to your panel on one
side (hence: peninsula, not island), it animates your music with a tiny
waveform, and it will absolutely lose its mind if you dare open a YouTube
tab while Apple Music is paused.

We fixed that last part. Mostly.

---

## Features

- Collapses flush into the physical notch when idle or paused — completely
  invisible, like your productivity
- Expands on hover to show track info, album art, playback controls, a
  progress bar, and a volume slider
- Animated waveform bars while music plays
- Actually blocks controls when YouTube is active (we had to fight for this)
- Works exclusively with Apple Music in Firefox because we are not
  general-purpose software, we are **art**

---

## Requirements

- GNOME Shell 45 or higher
- Asahi Linux (or any Linux with a notch, both of you)
- Firefox browser
- Apple Music subscription (ironic, given you're on Linux)
- The Firefox MPRIS plugin that exposes media controls over DBus
  (`firefox-mpris` or equivalent)
- A physical notch. No notch? It still works, it just looks like a weird
  floating pill at the top of your screen. A conversation starter.

---

## Installation

1. Clone this repo into your GNOME extensions folder:
   ```
   git clone <repo> ~/.local/share/gnome-shell/extensions/dramatic-peninsula@you
   ```
2. Edit `src/constants.js` to match your setup (see Caveats below, and
   also consider your life choices)
3. Restart GNOME Shell (`Alt+F2` → `r` → `Enter`, or log out if you're on
   Wayland and that doesn't work, which it won't)
4. Enable the extension via GNOME Extensions app or:
   ```
   gnome-extensions enable dramatic-peninsula@you
   ```
5. Open Firefox, go to Apple Music, play a song
6. Stare at the notch
7. Feel something

---

## Caveats (please read, unlike most READMEs)

This extension has more hardcoded values than a CS freshman's first
project. Specifically:

- **Panel height is hardcoded to 42px.** If your panel is a different
  height the collapsed pill will either peek out below the notch like a
  shy rectangle, or disappear entirely into it like it owes you money.

- **Only works with Firefox.** The player watcher explicitly filters for
  a bus name containing `firefox`. Spotify, Rhythmbox, your obscure
  terminal music player — all ignored. This is a feature disguised as
  a limitation.

- **Only reacts to Apple Music tabs.** It checks the track URL for
  `music.apple.com`. Playing from any other source in Firefox? The
  peninsula remains dramatically silent.

- **Album art only loads from local file paths.** The Firefox MPRIS
  bridge caches art locally and provides a `file://` URI, which we load
  directly. Remote URLs will show the placeholder `♪` symbol, which
  is honestly more artistic anyway.

- **Volume control writes to the MPRIS Volume property.** Whether your
  browser respects this is between you and Firefox.

- **The progress bar seeks using SetPosition.** Apple Music's web player
  may or may not honor this depending on the phase of the moon and your
  Firefox version.

- **Rounded album art corners may not work.** We tried. We really tried.
  `St.Bin`, `clip_to_allocation`, border-radius — it's a whole thing.
  PRs welcome.

---

## Known Issues

- Everything described in Caveats
- The extension logs to `/tmp/fun-notch.log` because we needed to debug
  at 2am and never removed it. You can watch your music metadata stream
  by in real time with `tail -f /tmp/fun-notch.log`, which is either
  useful or haunting depending on your mood.
- If you manage to trigger a race condition between YouTube and Apple
  Music fast enough, the peninsula gets confused. We respect that you
  would even try.

---

## Contributing

If you want to make this work with Spotify, other browsers, arbitrary
panel heights, or without a physical notch — go for it. Just know that
every generalisation you add brings it one step closer to becoming
software and one step further from being a personal art project built at
midnight on Asahi Linux.

---

## Credits

Built by a human and Claude, at midnight, on Asahi Linux.
The human had the idea. Claude wrote the code. The bugs were a
collaboration.

---

*"It's not an island. It's not even really a peninsula. It's a vibe."*
