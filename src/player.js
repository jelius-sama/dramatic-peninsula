// src/player.js
//
// Handles all MPRIS/DBus communication.
// The UI layer passes callbacks; this class never touches St/Clutter directly.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    MPRIS_BUS_PREFIX,
    MPRIS_OBJECT_PATH,
    MPRIS_PLAYER_IFACE,
    LOG_FILE,
    TIMELINE_TICK_MS,
} from './constants.js';

const APPLE_MUSIC_URL = 'music.apple.com';

export class Player {
    /**
     * @param {object} callbacks
     *   onPlay()          — track is playing
     *   onPause()         — track is paused / stopped
     *   onMetadata(meta)  — { title, artist, artUrl, length }
     *   onVolume(frac)    — volume changed 0.0–1.0
     *   onPosition(µs)    — position changed
     *   onDisconnect()    — player left the bus
     */
    constructor(callbacks) {
        this._cb = callbacks;

        this._busName = null;
        this._dbus = null;
        this._nameWatcherId = null;
        this._propsWatcherId = null;

        // Internal state
        this._lastTrackUrl = '';        // URL of the last confirmed Apple Music track
        this._isAppleMusic = false;     // true only when current track is AM

        this._timelineSupported = null;
        this._trackPosition = 0;
        this._trackLength = 0;
        this._timelineTimer = null;
        this._syncCounter = 0;

        this._currentVolume = 1.0;
    }

    // ── Logging ───────────────────────────────────────────────────────────────

    _log(msg) {
        try {
            let f = Gio.File.new_for_path(LOG_FILE);
            let ts = new Date().toISOString();
            let s = f.append_to(Gio.FileCreateFlags.NONE, null);
            s.write(`[${ts}] [Player] ${msg}\n`, null);
            s.close(null);
        } catch (e) { console.error(e); }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    start() {
        this._dbus = Gio.DBus.session;

        this._nameWatcherId = this._dbus.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            this._onNameOwnerChanged.bind(this)
        );

        this._findExistingPlayers();
    }

    stop() {
        this._stopTimelinePoller();

        if (this._nameWatcherId) {
            this._dbus.signal_unsubscribe(this._nameWatcherId);
            this._nameWatcherId = null;
        }
        if (this._propsWatcherId) {
            this._dbus.signal_unsubscribe(this._propsWatcherId);
            this._propsWatcherId = null;
        }

        this._dbus = null;
        this._busName = null;
    }

    // Send a method call (Play, Pause, PlayPause, Next, Previous, SetPosition)
    call(method, params = null) {
        if (!this._busName || !this._dbus) return;

        // Before sending any command, confirm Apple Music is still the active track
        this._dbusGet(this._busName, 'Metadata', reply => {
            try {
                let u = reply.deepUnpack()[0];
                u = u.recursiveUnpack ? u.recursiveUnpack() : u;
                let url = u['xesam:url'] ?? '';
                if (!url.includes(APPLE_MUSIC_URL)) {
                    this._log(`Command ${method} blocked: active track is not Apple Music (${url})`);
                    return;
                }
            } catch (e) {
                this._log(`call() guard failed: ${e}`);
                return;
            }

            // Confirmed AM is active — send the command
            this._dbus.call(
                this._busName, MPRIS_OBJECT_PATH, MPRIS_PLAYER_IFACE,
                method, params, null,
                Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try { conn.call_finish(res); }
                    catch (e) { this._log(`call ${method}: ${e}`); }
                }
            );
        });
    }

    // Set a writable property (e.g. Volume)
    setProp(prop, value) {
        if (!this._busName || !this._dbus) return;
        this._dbus.call(
            this._busName, MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [MPRIS_PLAYER_IFACE, prop, value]),
            null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try { conn.call_finish(res); }
                catch (e) { this._log(`setProp ${prop}: ${e}`); }
            }
        );
    }

    seek(positionMicroseconds) {
        this.call('SetPosition', new GLib.Variant(
            '(ox)', ['/org/mpris/MediaPlayer2/TrackList/NoTrack', positionMicroseconds]
        ));
        this._trackPosition = positionMicroseconds;
        this._cb.onPosition(this._trackPosition, this._trackLength);
    }

    setVolume(frac) {
        this._currentVolume = Math.max(0, Math.min(1, frac));
        this.setProp('Volume', new GLib.Variant('d', this._currentVolume));
        this._cb.onVolume(this._currentVolume);
    }

    nudgeVolume(delta) {
        this.setVolume(this._currentVolume + delta);
    }

    get trackLength() { return this._trackLength; }
    get timelineSupported() { return this._timelineSupported; }

    // ── Bus discovery ─────────────────────────────────────────────────────────

    _findExistingPlayers() {
        this._dbus.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    let names = conn.call_finish(res).deepUnpack()[0];
                    names
                        .filter(n => n.startsWith(MPRIS_BUS_PREFIX))
                        .forEach(n => this._watchPlayer(n));
                } catch (e) { this._log(`_findExistingPlayers: ${e}`); }
            }
        );
    }

    _onNameOwnerChanged(conn, sender, path, iface, sig, params) {
        let [name, , newOwner] = params.deepUnpack();
        if (!name.startsWith(MPRIS_BUS_PREFIX)) return;

        if (newOwner !== '') {
            this._watchPlayer(name);
        } else if (name === this._busName) {
            this._log(`Player left: ${name}`);
            this._busName = null;
            this._isAppleMusic = false;
            this._lastTrackUrl = '';
            this._stopTimelinePoller();

            if (this._propsWatcherId) {
                this._dbus.signal_unsubscribe(this._propsWatcherId);
                this._propsWatcherId = null;
            }

            this._cb.onDisconnect();
        }
    }

    _watchPlayer(busName) {
        if (!busName.toLowerCase().includes('firefox')) {
            this._log(`Skip: ${busName}`);
            return;
        }
        this._log(`Watch: ${busName}`);
        this._busName = busName;

        if (this._propsWatcherId)
            this._dbus.signal_unsubscribe(this._propsWatcherId);

        this._propsWatcherId = this._dbus.signal_subscribe(
            busName,
            'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            MPRIS_OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE,
            this._onPropertiesChanged.bind(this)
        );

        // Chain: read metadata first, then read status inside the callback.
        // This guarantees _isAppleMusic / _lastTrackUrl are set before we
        // decide whether to react to the playback status.
        this._readMetadataThen(busName, () => {
            this._readPlaybackStatus(busName);
        });

        this._readVolume(busName);
        this._probeTimeline(busName);
    }

    // ── DBus helpers ──────────────────────────────────────────────────────────

    _dbusGet(busName, prop, cb) {
        this._dbus.call(
            busName, MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [MPRIS_PLAYER_IFACE, prop]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try { cb(conn.call_finish(res)); }
                catch (e) { this._log(`DBus Get ${prop}: ${e}`); }
            }
        );
    }

    _readMetadataThen(busName, then = null) {
        this._dbusGet(busName, 'Metadata', reply => {
            try {
                this._processMetadata(reply.deepUnpack()[0]);
            } catch (e) {
                this._log(`_readMetadataThen: ${e}`);
            }
            if (then) then();
        });
    }

    _readPlaybackStatus(busName) {
        this._dbusGet(busName, 'PlaybackStatus', reply => {
            try {
                // No metadata arg — status-only path, trust _isAppleMusic
                this._processStatus(reply.deepUnpack()[0].unpack(), null);
            } catch (e) { this._log(`_readPlaybackStatus: ${e}`); }
        });
    }

    _readVolume(busName) {
        this._dbusGet(busName, 'Volume', reply => {
            try {
                let vol = reply.deepUnpack()[0].unpack();
                this._currentVolume = Math.max(0, Math.min(1, vol));
                this._cb.onVolume(this._currentVolume);
            } catch (e) { this._log(`_readVolume: ${e}`); }
        });
    }

    // ── PropertiesChanged signal ───────────────────────────────────────────────

    _onPropertiesChanged(conn, sender, path, iface, sig, params) {
        let [, changed] = params.deepUnpack();

        // Always process Metadata before PlaybackStatus so _isAppleMusic is
        // up to date when we decide whether to handle the status change.
        if ('Metadata' in changed)
            this._processMetadata(changed['Metadata']);

        if ('PlaybackStatus' in changed)
            this._processStatus(
                changed['PlaybackStatus'].unpack(),
                // Pass the raw metadata variant if it arrived in the same signal,
                // so _processStatus can do an inline URL check as a double-guard.
                'Metadata' in changed ? changed['Metadata'] : null
            );

        if ('Volume' in changed) {
            this._currentVolume = Math.max(0, Math.min(1, changed['Volume'].unpack()));
            this._cb.onVolume(this._currentVolume);
        }

        if ('Position' in changed && this._timelineSupported) {
            try {
                this._trackPosition = changed['Position'].unpack();
                this._cb.onPosition(this._trackPosition, this._trackLength);
            } catch (_) { }
        }
    }

    // ── Core processing ───────────────────────────────────────────────────────

    /**
     * Processes a PlaybackStatus value.
     *
     * Guard logic:
     *   1. If metadata arrived in the same signal, check its URL directly.
     *      If it's not Apple Music → ignore unconditionally.
     *   2. If no metadata in the signal (status-only, e.g. YouTube pause),
     *      fall back to _isAppleMusic which was set by the last _processMetadata call.
     *
     * This handles two distinct cases correctly:
     *   - YouTube starts playing (sends Metadata + PlaybackStatus together):
     *     metadata URL ≠ AM → blocked by check #1.
     *   - YouTube pauses (sends only PlaybackStatus, no Metadata):
     *     _isAppleMusic is false (was cleared when YT track loaded) → blocked by check #2.
     *   - Apple Music pauses (sends only PlaybackStatus):
     *     _isAppleMusic is true → allowed through.
     */
    _processStatus(status, metadataVariant) {
        if (metadataVariant !== null) {
            // Metadata arrived in same signal — check URL inline
            try {
                let u = metadataVariant.recursiveUnpack
                    ? metadataVariant.recursiveUnpack()
                    : metadataVariant;
                let url = u['xesam:url'] ?? '';
                if (!url.includes(APPLE_MUSIC_URL)) {
                    this._log(`Status ignored (inline check): ${url}`);
                    return;
                }
            } catch (e) {
                this._log(`_processStatus inline check failed: ${e}`);
                return;
            }
            // Confirmed Apple Music — handle immediately
            this._applyStatus(status);
        } else {
            // Status-only signal — we cannot trust _isAppleMusic because another
            // tab may have taken over playback without sending a Metadata change.
            // Re-read metadata fresh to confirm Apple Music is still the active track.
            if (!this._busName) return;
            this._dbusGet(this._busName, 'Metadata', reply => {
                try {
                    let u = reply.deepUnpack()[0];
                    u = u.recursiveUnpack ? u.recursiveUnpack() : u;
                    let url = u['xesam:url'] ?? '';
                    if (!url.includes(APPLE_MUSIC_URL)) {
                        this._log(`Status ignored (re-read check): ${url}`);
                        return;
                    }
                    this._applyStatus(status);
                } catch (e) {
                    this._log(`_processStatus re-read failed: ${e}`);
                }
            });
        }
    }

    _applyStatus(status) {
        this._log(`Status accepted: ${status}`);
        if (status === 'Playing') {
            this._cb.onPlay();
        } else {
            this._cb.onPause();
        }
    }

    _processMetadata(metadata) {
        try {
            let u = metadata.recursiveUnpack ? metadata.recursiveUnpack() : metadata;
            let url = u['xesam:url'] ?? '';

            if (!url.includes(APPLE_MUSIC_URL)) {
                this._log(`Metadata ignored: not Apple Music (${url})`);
                // Clear the flag so status-only signals from this player are blocked
                this._isAppleMusic = false;
                this._lastTrackUrl = '';
                return;
            }

            // Apple Music track confirmed
            this._isAppleMusic = true;
            this._lastTrackUrl = url;

            let title = u['xesam:title'] ?? '';
            let artists = u['xesam:artist'] ?? [];
            let artist = Array.isArray(artists) ? artists.join(', ') : String(artists);
            let artUrl = u['mpris:artUrl'] ?? '';
            let len = u['mpris:length'];
            this._trackLength = (len !== undefined && len !== null) ? Number(len) : 0;

            this._log(`Metadata: ${artist} — ${title} (len=${this._trackLength})`);

            this._cb.onMetadata({ title, artist, artUrl, length: this._trackLength });
        } catch (e) {
            this._log(`_processMetadata: ${e}`);
        }
    }

    // ── Timeline ──────────────────────────────────────────────────────────────

    _probeTimeline(busName) {
        this._dbusGet(busName, 'Position', reply => {
            try {
                let pos = reply.deepUnpack()[0].unpack();
                this._timelineSupported = true;
                this._trackPosition = pos;
                this._log(`Timeline supported, pos=${pos}`);
                this._cb.onPosition(this._trackPosition, this._trackLength);
                this._startTimelinePoller();
            } catch (e) {
                this._log(`Timeline not supported: ${e}`);
                this._timelineSupported = false;
                this._cb.onPosition(null, null); // signal "not supported"
            }
        });
    }

    _startTimelinePoller() {
        if (this._timelineTimer) return;
        this._syncCounter = 0;

        this._timelineTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMELINE_TICK_MS, () => {
            if (!this._busName || !this._timelineSupported)
                return GLib.SOURCE_REMOVE;

            // Only advance when actually playing
            if (this._isAppleMusic) {
                this._trackPosition = Math.min(
                    this._trackPosition + TIMELINE_TICK_MS * 1000,
                    this._trackLength
                );
                this._cb.onPosition(this._trackPosition, this._trackLength);

                // Hard re-sync every 5 ticks
                this._syncCounter++;
                if (this._syncCounter % 5 === 0) {
                    this._dbusGet(this._busName, 'Position', reply => {
                        try {
                            this._trackPosition = reply.deepUnpack()[0].unpack();
                            this._cb.onPosition(this._trackPosition, this._trackLength);
                        } catch (_) { }
                    });
                }
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimelinePoller() {
        if (this._timelineTimer) {
            GLib.Source.remove(this._timelineTimer);
            this._timelineTimer = null;
        }
    }
}
