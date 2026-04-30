/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_BUS_PREFIX = 'org.mpris.MediaPlayer2';
const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
const LOG_FILE = '/tmp/fun-notch.log';

// ─── Sizes ─────────────────────────────────────────────────────────────────────
// Collapsed must stay ≤ 36 px — under the 42 px panel height so the pill
// sits flush inside the panel bar.  Expanded hangs below the panel.

const COLLAPSED_IDLE_WIDTH = 160;
const COLLAPSED_PLAYING_WIDTH = 310;
const EXPANDED_WIDTH = 520;
const COLLAPSED_HEIGHT = 36;   // ≤ 42 px
const EXPANDED_HEIGHT = 120;   // 90 px art + 15 px padding each side

// ─── Animation ────────────────────────────────────────────────────────────────
const ANIM_DURATION = 280;
const ANIM_MODE = Clutter.AnimationMode.EASE_OUT_QUINT;

// ─── Waveform ─────────────────────────────────────────────────────────────────
const WAVE_TICK_MS = 40;
const WAVE_PERIOD = 750;
const WAVE_COUNT = 3;
const WAVE_BAR_W = 3;
const WAVE_MIN_H = [3, 4, 3];
const WAVE_MAX_H = [12, 18, 14];
const WAVE_PHASES = [0, 140, 260];
const WAVE_REST_H = [6, 11, 7];

export default class FunNotch extends Extension {

    // ── Logging ───────────────────────────────────────────────────────────────

    _log(msg) {
        try {
            let f = Gio.File.new_for_path(LOG_FILE);
            let ts = new Date().toISOString();
            let s = f.append_to(Gio.FileCreateFlags.NONE, null);
            s.write(`[${ts}] ${msg}\n`, null);
            s.close(null);
        } catch (e) { console.error(e); }
    }

    // ── enable ────────────────────────────────────────────────────────────────

    enable() {
        this._log('enable()');

        this._isPlaying = false;
        this._isPaused = false;
        this._isHovered = false;
        this._lastTitle = '';
        this._lastArtist = '';
        this._waveTimer = null;
        this._waveStart = Date.now();

        this._buildUI();
        this._startWatching();
        this._startWaveAnimation();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI Construction
    //
    // Architecture:
    //   _widget  (St.Widget, BinLayout — the outer pill)
    //     └─ _collapsedLayer  (St.BoxLayout — idle dot OR waveform+title)
    //     └─ _expandedLayer   (St.BoxLayout — art | center-col | controls-col)
    //
    // Only one layer is visible at a time.  Using separate layers means
    // neither layer's children ever take up invisible space and push things
    // sideways — the classic cause of the "right-lean" bug with a single
    // shared BoxLayout.
    // ─────────────────────────────────────────────────────────────────────────

    _buildUI() {

        // ── Outer pill container ──────────────────────────────────────────
        // BinLayout stacks children on top of each other, so collapsed and
        // expanded layers share the same space.  The pill shape (flat top,
        // rounded bottom) is set on this actor.
        this._widget = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: this._pillStyle(COLLAPSED_IDLE_WIDTH, COLLAPSED_HEIGHT),
            reactive: true,
            clip_to_allocation: true,
        });

        // ── Collapsed layer ───────────────────────────────────────────────
        // A simple horizontal BoxLayout that fills the pill.
        // Children: idleDot (idle) -OR- waveBox + collapsedTitle (playing).
        this._collapsedLayer = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px; padding: 0 14px;',
        });

        // Idle dot — centered single dot when nothing plays
        this._idleDot = new St.Widget({
            style: `
                width: 7px;
                height: 7px;
                border-radius: 4px;
                background-color: #252525;
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        // Waveform bars
        this._waveBox = new St.BoxLayout({
            style: 'spacing: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._waveBars = [];
        for (let i = 0; i < WAVE_COUNT; i++) {
            let bar = new St.Widget({
                style: this._barStyle(WAVE_REST_H[i], 0.5),
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._waveBox.add_child(bar);
            this._waveBars.push(bar);
        }

        // Collapsed track title (truncated single line)
        this._collapsedTitle = new St.Label({
            text: '',
            style: 'color: rgba(255,255,255,0.68); font-size: 12px;',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._collapsedTitle.clutter_text.set_ellipsize(
            imports.gi.Pango.EllipsizeMode.END
        );

        // Start collapsed layer with just the idle dot
        this._collapsedLayer.add_child(this._idleDot);
        this._widget.add_child(this._collapsedLayer);

        // ── Expanded layer ────────────────────────────────────────────────
        // Three-column horizontal layout: [art] [center] [controls]
        // Hidden (opacity 0, width/height 0) until hover.
        this._expandedLayer = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            style: 'spacing: 14px; padding: 14px 16px;',
        });

        // ── Column 1: Album art ───────────────────────────────────────────
        this._artBox = new St.BoxLayout({
            style: `
                width: 90px;
                min-height: 90px;
                border-radius: 10px;
                background-color: #150e2a;
                border: 1px solid rgba(255,255,255,0.07);
            `,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._artLabel = new St.Label({
            text: '♪',
            style: 'color: rgba(255,255,255,0.20); font-size: 28px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._artBox.add_child(this._artLabel);

        // ── Column 2: Track info + progress bar ───────────────────────────
        this._centerCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: 'spacing: 0px;',
        });

        this._expandedTitle = new St.Label({
            text: '',
            style: 'color: white; font-size: 13px; font-weight: bold;',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._expandedTitle.clutter_text.set_ellipsize(
            imports.gi.Pango.EllipsizeMode.END
        );

        this._expandedArtist = new St.Label({
            text: '',
            style: 'color: rgba(255,255,255,0.42); font-size: 11px;',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._expandedArtist.clutter_text.set_ellipsize(
            imports.gi.Pango.EllipsizeMode.END
        );

        // Spacer pushes progress to bottom of column
        this._centerSpacer = new St.Widget({ y_expand: true });

        // Progress track + fill (child widget for the fill bar)
        this._progressTrack = new St.Widget({
            style: `
                height: 3px;
                border-radius: 2px;
                background-color: rgba(255,255,255,0.10);
            `,
            x_expand: true,
        });
        this._progressFill = new St.Widget({
            style: `
                width: 130px;
                height: 3px;
                border-radius: 2px;
                background-color: rgba(255,255,255,0.50);
            `,
        });
        this._progressTrack.add_child(this._progressFill);

        // Timestamps row
        this._timeRow = new St.BoxLayout({ x_expand: true });
        this._timeElapsed = new St.Label({
            text: '0:00',
            style: 'color: rgba(255,255,255,0.22); font-size: 9px;',
            x_align: Clutter.ActorAlign.START,
        });
        this._timeSpacer = new St.Widget({ x_expand: true });
        this._timeTotal = new St.Label({
            text: '0:00',
            style: 'color: rgba(255,255,255,0.22); font-size: 9px;',
            x_align: Clutter.ActorAlign.END,
        });
        this._timeRow.add_child(this._timeElapsed);
        this._timeRow.add_child(this._timeSpacer);
        this._timeRow.add_child(this._timeTotal);

        this._centerCol.add_child(this._expandedTitle);
        this._centerCol.add_child(this._expandedArtist);
        this._centerCol.add_child(this._centerSpacer);
        this._centerCol.add_child(this._progressTrack);
        this._centerCol.add_child(this._timeRow);

        // ── Column 3: Playback controls ───────────────────────────────────
        // Vertical: [⏮ ⏸ ⏭] above [volume strip]
        // Buttons use very dark subtle backgrounds — no bright grey circles.
        this._controlsCol = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px;',
        });

        this._btnRow = new St.BoxLayout({
            style: 'spacing: 2px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._btnPrev = this._makeCtrlBtn('prev');
        this._btnPlayPause = this._makeCtrlBtn('play');
        this._btnNext = this._makeCtrlBtn('next');

        this._btnRow.add_child(this._btnPrev);
        this._btnRow.add_child(this._btnPlayPause);
        this._btnRow.add_child(this._btnNext);

        // Volume row
        this._volRow = new St.BoxLayout({
            style: 'spacing: 5px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volLow = new St.Label({
            text: '🔈',
            style: 'font-size: 9px; color: rgba(255,255,255,0.22);',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volTrack = new St.Widget({
            style: `
                width: 58px;
                height: 2px;
                border-radius: 1px;
                background-color: rgba(255,255,255,0.10);
            `,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volFill = new St.Widget({
            style: `
                width: 36px;
                height: 2px;
                border-radius: 1px;
                background-color: rgba(255,255,255,0.35);
            `,
        });
        this._volTrack.add_child(this._volFill);
        this._volHigh = new St.Label({
            text: '🔊',
            style: 'font-size: 9px; color: rgba(255,255,255,0.22);',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._volRow.add_child(this._volLow);
        this._volRow.add_child(this._volTrack);
        this._volRow.add_child(this._volHigh);

        this._controlsCol.add_child(this._btnRow);
        this._controlsCol.add_child(this._volRow);

        // Assemble expanded layer
        this._expandedLayer.add_child(this._artBox);
        this._expandedLayer.add_child(this._centerCol);
        this._expandedLayer.add_child(this._controlsCol);

        this._widget.add_child(this._expandedLayer);

        // ── Position: top-center ──────────────────────────────────────────
        this._widget.add_constraint(new Clutter.AlignConstraint({
            source: Main.layoutManager.uiGroup,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        // factor 0.0 = top edge — flat top merges with panel bar,
        // rounded bottom hangs below like a hardware notch.
        this._widget.add_constraint(new Clutter.AlignConstraint({
            source: Main.layoutManager.uiGroup,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.0,
        }));

        // ── Hover ─────────────────────────────────────────────────────────
        this._widget.connect('enter-event', () => {
            this._isHovered = true;
            this._expand();
        });
        this._widget.connect('leave-event', () => {
            this._isHovered = false;
            this._collapse();
        });

        Main.layoutManager.addTopChrome(this._widget);
    }

    // ── Style helpers ─────────────────────────────────────────────────────────

    // Flat top / rounded bottom — mimics a notch cutout below the panel bar.
    _pillStyle(w, h) {
        return `
            background-color: #0c0c0c;
            border-radius: 0 0 22px 22px;
            width: ${w}px;
            height: ${h}px;
        `;
    }

    _barStyle(h, alpha) {
        return `
            width: ${WAVE_BAR_W}px;
            height: ${Math.round(h)}px;
            border-radius: 2px;
            background-color: rgba(255,255,255,${alpha.toFixed(2)});
        `;
    }

    // ── Control button factory ────────────────────────────────────────────────
    //
    // Design intent: buttons should read as dark, near-invisible controls on
    // the black background — like the boringNotch style where the icons float
    // without obvious button chrome.  The play button gets a very subtle dark
    // tint to distinguish it, not a bright grey circle.
    //
    // No click handlers wired — these are UI stubs only.

    _makeCtrlBtn(role) {
        const isPlay = role === 'play';
        const size = isPlay ? 40 : 32;

        // Glyphs — plain Unicode, no emoji, renders cleanly at these sizes
        const glyphs = { prev: '⏮', play: '⏸', next: '⏭' };

        // Colors: play button gets a barely-there tint; side buttons are
        // fully transparent backgrounds so they don't look like grey pills.
        const bgNormal = isPlay
            ? 'rgba(255,255,255,0.08)'   // very faint — almost invisible
            : 'rgba(255,255,255,0.00)';  // transparent
        const bgHover = isPlay
            ? 'rgba(255,255,255,0.16)'
            : 'rgba(255,255,255,0.08)';
        const fgNormal = isPlay
            ? 'rgba(255,255,255,0.90)'
            : 'rgba(255,255,255,0.55)';
        const fgHover = 'rgba(255,255,255,1.00)';

        let btn = new St.Button({
            style: `
                width: ${size}px;
                height: ${size}px;
                border-radius: ${Math.round(size / 2)}px;
                background-color: ${bgNormal};
                color: ${fgNormal};
                font-size: ${isPlay ? 17 : 14}px;
                padding: 0;
            `,
            label: glyphs[role],
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });

        btn.connect('enter-event', () => {
            btn.style = `
                width: ${size}px;
                height: ${size}px;
                border-radius: ${Math.round(size / 2)}px;
                background-color: ${bgHover};
                color: ${fgHover};
                font-size: ${isPlay ? 17 : 14}px;
                padding: 0;
            `;
        });
        btn.connect('leave-event', () => {
            btn.style = `
                width: ${size}px;
                height: ${size}px;
                border-radius: ${Math.round(size / 2)}px;
                background-color: ${bgNormal};
                color: ${fgNormal};
                font-size: ${isPlay ? 17 : 14}px;
                padding: 0;
            `;
        });

        return btn;
    }

    // ── Waveform animation ────────────────────────────────────────────────────

    _startWaveAnimation() {
        this._waveStart = Date.now();

        const tick = () => {
            if (!this._widget) return GLib.SOURCE_REMOVE;

            if (this._isPlaying) {
                let now = Date.now() - this._waveStart;
                for (let i = 0; i < WAVE_COUNT; i++) {
                    let t = (now + WAVE_PHASES[i]) % WAVE_PERIOD / WAVE_PERIOD;
                    let s = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
                    let h = WAVE_MIN_H[i] + (WAVE_MAX_H[i] - WAVE_MIN_H[i]) * s;
                    this._waveBars[i].style = this._barStyle(h, 0.90);
                }
            } else {
                let alpha = this._isPaused ? 0.28 : 0.18;
                for (let i = 0; i < WAVE_COUNT; i++)
                    this._waveBars[i].style = this._barStyle(WAVE_REST_H[i], alpha);
            }
            return GLib.SOURCE_CONTINUE;
        };

        this._waveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAVE_TICK_MS, tick);
    }

    // ── Expand (hovered) ──────────────────────────────────────────────────────

    _expand() {
        this._log('expand');

        // Resize the pill
        this._widget.style = this._pillStyle(EXPANDED_WIDTH, EXPANDED_HEIGHT);
        this._animateProp(this._widget, 'width', EXPANDED_WIDTH);
        this._animateProp(this._widget, 'height', EXPANDED_HEIGHT);

        // Swap layers
        this._animateProp(this._collapsedLayer, 'opacity', 0);
        this._animateProp(this._expandedLayer, 'opacity', 255);

        // Populate text and update play/pause glyph
        if (this._isPlaying) {
            this._btnPlayPause.label = '⏸';
            this._expandedTitle.style = 'color: white; font-size: 13px; font-weight: bold;';
            this._expandedArtist.style = 'color: rgba(255,255,255,0.42); font-size: 11px;';
        } else if (this._isPaused) {
            this._btnPlayPause.label = '▶';
            this._expandedTitle.style = 'color: rgba(255,255,255,0.50); font-size: 13px; font-weight: bold;';
            this._expandedArtist.style = 'color: rgba(255,255,255,0.28); font-size: 11px;';
        } else {
            this._btnPlayPause.label = '▶';
            this._expandedTitle.style = 'color: rgba(255,255,255,0.28); font-size: 13px; font-weight: bold;';
            this._expandedArtist.style = 'color: rgba(255,255,255,0.16); font-size: 11px;';
        }

        let hasTrack = this._isPlaying || this._isPaused;
        this._expandedTitle.set_text(
            this._lastTitle || (hasTrack ? 'Unknown Title' : 'Nothing Playing')
        );
        // this._expandedArtist.set_text(this._lastArtist || '');
        // Don't need the title when not hovered
        this._expandedArtist.set_text('');
    }

    // ── Collapse (not hovered) ────────────────────────────────────────────────

    _collapse() {
        this._log('collapse');

        // Fade out expanded layer
        this._animateProp(this._expandedLayer, 'opacity', 0);

        if (this._isPlaying || this._isPaused) {
            let w = COLLAPSED_PLAYING_WIDTH;
            this._widget.style = this._pillStyle(w, COLLAPSED_HEIGHT);
            this._animateProp(this._widget, 'width', w);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);

            // Rebuild collapsed layer: waveform + title
            this._syncCollapsedPlaying();
            this._animateProp(this._collapsedLayer, 'opacity',
                this._isPaused ? 160 : 255
            );
        } else {
            this._widget.style = this._pillStyle(COLLAPSED_IDLE_WIDTH, COLLAPSED_HEIGHT);
            this._animateProp(this._widget, 'width', COLLAPSED_IDLE_WIDTH);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);

            // Rebuild collapsed layer: just the idle dot
            this._syncCollapsedIdle();
            this._animateProp(this._collapsedLayer, 'opacity', 255);
        }
    }

    // Swap collapsed layer children to the "idle" layout (single dot, centered)
    _syncCollapsedIdle() {
        this._collapsedLayer.remove_all_children();
        this._collapsedLayer.style = 'spacing: 0px; padding: 0 14px;';

        // Re-add just the dot; x_expand centers it in the row
        this._idleDot.x_expand = true;
        this._collapsedLayer.add_child(this._idleDot);
    }

    // Swap collapsed layer children to the "playing" layout (waveform + title)
    _syncCollapsedPlaying() {
        this._collapsedLayer.remove_all_children();
        this._collapsedLayer.style = 'spacing: 8px; padding: 0 14px;';

        this._idleDot.x_expand = false;
        this._collapsedLayer.add_child(this._waveBox);
        this._collapsedLayer.add_child(this._collapsedTitle);
        this._collapsedTitle.set_text(this._lastTitle || '');
    }

    // ── Generic animate helper ────────────────────────────────────────────────

    _animateProp(actor, prop, value) {
        actor.set_easing_duration(ANIM_DURATION);
        actor.set_easing_mode(ANIM_MODE);
        actor[prop] = value;
    }

    // ── DBus / MPRIS ──────────────────────────────────────────────────────────

    _startWatching() {
        this._log('_startWatching');
        this._dbusConnection = Gio.DBus.session;

        this._nameWatcherId = this._dbusConnection.signal_subscribe(
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

    _findExistingPlayers() {
        this._dbusConnection.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try {
                    let names = conn.call_finish(res).deepUnpack()[0];
                    names.filter(n => n.startsWith(MPRIS_BUS_PREFIX))
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
        } else {
            this._log(`Player left: ${name}`);
            this._isPlaying = false;
            this._isPaused = false;
            if (!this._isHovered) this._collapse();

            if (this._propertiesWatcherId) {
                this._dbusConnection.signal_unsubscribe(this._propertiesWatcherId);
                this._propertiesWatcherId = null;
            }
        }
    }

    _watchPlayer(busName) {
        if (!busName.toLowerCase().includes('firefox')) {
            this._log(`Skip: ${busName}`);
            return;
        }
        this._log(`Watch: ${busName}`);
        this._currentPlayer = busName;

        if (this._propertiesWatcherId)
            this._dbusConnection.signal_unsubscribe(this._propertiesWatcherId);

        this._propertiesWatcherId = this._dbusConnection.signal_subscribe(
            busName,
            'org.freedesktop.DBus.Properties', 'PropertiesChanged',
            MPRIS_OBJECT_PATH, null,
            Gio.DBusSignalFlags.NONE,
            this._onPropertiesChanged.bind(this)
        );

        this._readCurrentTrack(busName);
        this._readPlaybackStatus(busName);
    }

    _dbusGet(busName, prop, cb) {
        this._dbusConnection.call(
            busName, MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', prop]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE, -1, null,
            (conn, res) => {
                try { cb(conn.call_finish(res)); }
                catch (e) { this._log(`DBus Get ${prop}: ${e}`); }
            }
        );
    }

    _readCurrentTrack(busName) {
        this._dbusGet(busName, 'Metadata', reply => {
            try { this._updateMetadata(reply.deepUnpack()[0]); }
            catch (e) { this._log(`_readCurrentTrack: ${e}`); }
        });
    }

    _readPlaybackStatus(busName) {
        this._dbusGet(busName, 'PlaybackStatus', reply => {
            try { this._handlePlaybackStatus(reply.deepUnpack()[0].unpack()); }
            catch (e) { this._log(`_readPlaybackStatus: ${e}`); }
        });
    }

    _onPropertiesChanged(conn, sender, path, iface, sig, params) {
        let [, changed] = params.deepUnpack();

        if ('PlaybackStatus' in changed)
            this._handlePlaybackStatus(changed['PlaybackStatus'].unpack());

        if ('Metadata' in changed)
            this._updateMetadata(changed['Metadata']);
    }

    _handlePlaybackStatus(status) {
        this._log(`Status: ${status}`);
        this._isPlaying = (status === 'Playing');
        this._isPaused = (status === 'Paused');

        if (this._isHovered) this._expand();
        else this._collapse();
    }

    _updateMetadata(metadata) {
        try {
            let u = metadata.recursiveUnpack ? metadata.recursiveUnpack() : metadata;
            let url = u['xesam:url'] ?? '';

            if (!url.includes('music.apple.com')) {
                this._log('Not Apple Music, skip');
                return;
            }

            this._lastTitle = u['xesam:title'] ?? '';
            let artists = u['xesam:artist'] ?? [];
            this._lastArtist = Array.isArray(artists) ? artists.join(', ') : String(artists);
            this._log(`Meta: ${this._lastArtist} — ${this._lastTitle}`);

            if (this._isHovered) this._expand();
            else this._collapse();
        } catch (e) {
            this._log(`_updateMetadata: ${e}`);
        }
    }

    // ── disable ───────────────────────────────────────────────────────────────

    disable() {
        this._log('disable()');

        if (this._waveTimer) {
            GLib.Source.remove(this._waveTimer);
            this._waveTimer = null;
        }

        if (this._nameWatcherId) {
            this._dbusConnection.signal_unsubscribe(this._nameWatcherId);
            this._nameWatcherId = null;
        }

        if (this._propertiesWatcherId) {
            this._dbusConnection.signal_unsubscribe(this._propertiesWatcherId);
            this._propertiesWatcherId = null;
        }

        if (this._widget) {
            Main.layoutManager.removeChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
        }

        this._dbusConnection = null;
    }
}
