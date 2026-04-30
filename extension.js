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
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const MPRIS_BUS_PREFIX = 'org.mpris.MediaPlayer2';
const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const LOG_FILE = '/tmp/fun-notch.log';

// ─── Sizes ─────────────────────────────────────────────────────────────────────
const COLLAPSED_IDLE_WIDTH = 160;
const COLLAPSED_PLAYING_WIDTH = 310;
const EXPANDED_WIDTH = 520;
const COLLAPSED_HEIGHT = 42;
const EXPANDED_HEIGHT = 162;

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

// ─── Timeline poll interval ────────────────────────────────────────────────────
const TIMELINE_TICK_MS = 1000;

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
        this._lastArtUrl = '';
        this._waveTimer = null;
        this._waveStart = Date.now();

        // Timeline state
        this._timelineSupported = null; // null = unknown, true/false once probed
        this._trackLength = 0;          // microseconds
        this._trackPosition = 0;        // microseconds
        this._timelineTimer = null;

        // Volume state
        this._currentVolume = 0.6;      // 0.0 – 1.0

        this._buildUI();
        this._startWatching();
        this._startWaveAnimation();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI Construction
    // ─────────────────────────────────────────────────────────────────────────

    _buildUI() {

        // ── Outer pill container ──────────────────────────────────────────
        this._widget = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: this._pillStyle(COLLAPSED_IDLE_WIDTH, COLLAPSED_HEIGHT),
            reactive: true,
            clip_to_allocation: true,
        });

        // ── Collapsed layer ───────────────────────────────────────────────
        this._collapsedLayer = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px; padding: 0 14px;',
        });

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

        this._collapsedLayer.add_child(this._idleDot);
        this._widget.add_child(this._collapsedLayer);

        // ── Expanded layer ────────────────────────────────────────────────
        this._expandedLayer = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            // style: 'spacing: 14px; padding: 14px 16px;',
            style: 'spacing: 14px; padding: 42px 16px 14px 16px;',
        });

        // ── Column 1: Album art ───────────────────────────────────────────
        this._artBox = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: `
                width: 90px;
                min-height: 90px;
                border-radius: 10px;
                background-color: #150e2a;
                border: 1px solid rgba(255,255,255,0.07);
            `,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });

        // Placeholder label (shown when no art)
        this._artLabel = new St.Label({
            text: '♪',
            style: 'color: rgba(255,255,255,0.20); font-size: 28px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._artBox.add_child(this._artLabel);

        // Texture actor for real album art (hidden until loaded)
        this._artTexture = new Clutter.Actor({
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        this._artBox.add_child(this._artTexture);

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

        this._centerSpacer = new St.Widget({ y_expand: true });

        // Progress row — hidden via opacity if timeline not supported
        this._progressRow = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style: 'spacing: 2px;',
        });

        this._progressTrack = new St.Widget({
            style: `
                height: 8px;
                border-radius: 4px;
                background-color: rgba(255,255,255,0.10);
            `,
            x_expand: true,
            reactive: true,
        });
        this._progressFill = new St.Widget({
            style: `
                width: 0px;
                height: 8px;
                border-radius: 4px;
                background-color: rgba(255,255,255,0.50);
            `,
        });
        this._progressTrack.add_child(this._progressFill);

        // Click on progress track to seek
        this._progressTrack.connect('button-press-event', (actor, event) => {
            if (!this._timelineSupported || this._trackLength <= 0) return Clutter.EVENT_PROPAGATE;
            let [x] = event.get_coords();
            let [ax] = actor.get_transformed_position();
            let w = actor.get_width();
            let frac = Math.max(0, Math.min(1, (x - ax) / w));
            let seekPos = Math.round(frac * this._trackLength);
            this._mprisCall('SetPosition', new GLib.Variant('(ox)', ['/org/mpris/MediaPlayer2/TrackList/NoTrack', seekPos]));
            this._trackPosition = seekPos;
            this._updateProgressUI();
            return Clutter.EVENT_STOP;
        });

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

        this._progressRow.add_child(this._progressTrack);
        this._progressRow.add_child(this._timeRow);

        this._centerCol.add_child(this._expandedTitle);
        this._centerCol.add_child(this._expandedArtist);
        this._centerCol.add_child(this._centerSpacer);
        this._centerCol.add_child(this._progressRow);

        // ── Column 3: Playback controls ───────────────────────────────────
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

        // ── Wire button click handlers ─────────────────────────────────────
        this._btnPrev.connect('clicked', () => {
            this._log('Prev clicked');
            this._mprisCall('Previous', null);
        });
        this._btnPlayPause.connect('clicked', () => {
            this._log('PlayPause clicked');
            this._mprisCall('PlayPause', null);
        });
        this._btnNext.connect('clicked', () => {
            this._log('Next clicked');
            this._mprisCall('Next', null);
        });

        this._btnRow.add_child(this._btnPrev);
        this._btnRow.add_child(this._btnPlayPause);
        this._btnRow.add_child(this._btnNext);

        // ── Volume row ────────────────────────────────────────────────────
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
                height: 8px;
                border-radius: 4px;
                background-color: rgba(255,255,255,0.10);
            `,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        this._volFill = new St.Widget({
            style: `
                width: 36px;
                height: 8px;
                border-radius: 4px;
                background-color: rgba(255,255,255,0.35);
            `,
        });
        this._volTrack.add_child(this._volFill);
        this._volHigh = new St.Label({
            text: '🔊',
            style: 'font-size: 9px; color: rgba(255,255,255,0.22);',
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Click on volume track to set volume
        this._volTrack.connect('button-press-event', (actor, event) => {
            this._onVolTrackClick(actor, event);
            return Clutter.EVENT_STOP;
        });
        // Scroll on volume track to nudge volume
        this._volTrack.connect('scroll-event', (actor, event) => {
            this._onVolScroll(event);
            return Clutter.EVENT_STOP;
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

    _makeCtrlBtn(role) {
        const isPlay = role === 'play';
        const size = isPlay ? 40 : 32;
        const glyphs = { prev: '⏮', play: '⏸', next: '⏭' };

        const bgNormal = isPlay ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.00)';
        const bgHover = isPlay ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
        const fgNormal = isPlay ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.55)';
        const fgHover = 'rgba(255,255,255,1.00)';

        const baseStyle = (bg, fg) => `
            width: ${size}px;
            height: ${size}px;
            border-radius: ${Math.round(size / 2)}px;
            background-color: ${bg};
            color: ${fg};
            font-size: ${isPlay ? 17 : 14}px;
            padding: 0;
        `;

        let btn = new St.Button({
            style: baseStyle(bgNormal, fgNormal),
            label: glyphs[role],
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });

        btn.connect('enter-event', () => { btn.style = baseStyle(bgHover, fgHover); });
        btn.connect('leave-event', () => { btn.style = baseStyle(bgNormal, fgNormal); });

        return btn;
    }

    // ── MPRIS DBus method call ─────────────────────────────────────────────────

    _mprisCall(method, params) {
        if (!this._currentPlayer) return;
        this._dbusConnection.call(
            this._currentPlayer,
            MPRIS_OBJECT_PATH,
            MPRIS_PLAYER_IFACE,
            method,
            params,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try { conn.call_finish(res); }
                catch (e) { this._log(`_mprisCall ${method}: ${e}`); }
            }
        );
    }

    // ── MPRIS DBus property set ────────────────────────────────────────────────

    _mprisSet(prop, value) {
        if (!this._currentPlayer) return;
        this._dbusConnection.call(
            this._currentPlayer,
            MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'Set',
            new GLib.Variant('(ssv)', [MPRIS_PLAYER_IFACE, prop, value]),
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (conn, res) => {
                try { conn.call_finish(res); }
                catch (e) { this._log(`_mprisSet ${prop}: ${e}`); }
            }
        );
    }

    // ── Volume handling ───────────────────────────────────────────────────────

    _onVolTrackClick(actor, event) {
        let [x] = event.get_coords();
        let [ax] = actor.get_transformed_position();
        let w = actor.get_width();
        let frac = Math.max(0, Math.min(1, (x - ax) / w));
        this._setVolume(frac);
    }

    _onVolScroll(event) {
        let dir = event.get_scroll_direction();
        let delta = (dir === Clutter.ScrollDirection.UP) ? 0.05 : -0.05;
        this._setVolume(Math.max(0, Math.min(1, this._currentVolume + delta)));
    }

    _setVolume(frac) {
        this._currentVolume = frac;
        this._mprisSet('Volume', new GLib.Variant('d', frac));
        this._updateVolUI();
    }

    _updateVolUI() {
        // volFill width is 0–58 px
        let px = Math.round(this._currentVolume * 58);
        this._volFill.style = `
            width: ${px}px;
            height: 8px;
            border-radius: 4px;
            background-color: rgba(255,255,255,0.35);
        `;
    }

    _readVolume(busName) {
        this._dbusGet(busName, 'Volume', reply => {
            try {
                let vol = reply.deepUnpack()[0].unpack();
                this._currentVolume = Math.max(0, Math.min(1, vol));
                this._updateVolUI();
            } catch (e) { this._log(`_readVolume: ${e}`); }
        });
    }

    // ── Timeline handling ─────────────────────────────────────────────────────

    _probeTimeline(busName) {
        // Try reading Position; if it throws / returns nothing, mark unsupported
        this._dbusGet(busName, 'Position', reply => {
            try {
                let pos = reply.deepUnpack()[0].unpack(); // microseconds (int64)
                this._timelineSupported = true;
                this._trackPosition = pos;
                this._log(`Timeline supported, pos=${pos}`);
                this._updateProgressUI();
                this._startTimelinePoller();
            } catch (e) {
                this._log(`Timeline not supported: ${e}`);
                this._timelineSupported = false;
                // Hide progress row — keeps layout intact, just invisible
                this._progressRow.opacity = 0;
            }
        });
    }

    _startTimelinePoller() {
        if (this._timelineTimer) return;
        this._timelineTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMELINE_TICK_MS, () => {
            if (!this._widget || !this._currentPlayer || !this._timelineSupported)
                return GLib.SOURCE_REMOVE;

            if (this._isPlaying) {
                // Optimistically advance position without a DBus round-trip every second
                this._trackPosition = Math.min(
                    this._trackPosition + TIMELINE_TICK_MS * 1000,
                    this._trackLength
                );
                this._updateProgressUI();

                // Every 5 seconds do a real DBus read to re-sync
                if (!this._syncCounter) this._syncCounter = 0;
                this._syncCounter++;
                if (this._syncCounter % 5 === 0) {
                    this._dbusGet(this._currentPlayer, 'Position', reply => {
                        try {
                            this._trackPosition = reply.deepUnpack()[0].unpack();
                            this._updateProgressUI();
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

    _updateProgressUI() {
        if (!this._timelineSupported) return;

        let elapsed = this._trackPosition;  // µs
        let total = this._trackLength;    // µs

        let frac = total > 0 ? Math.max(0, Math.min(1, elapsed / total)) : 0;
        let trackPx = this._progressTrack.get_width() || 200;
        let fillPx = Math.round(frac * trackPx);

        this._progressFill.style = `
            width: ${fillPx}px;
            height: 8px;
            border-radius: 4px;
            background-color: rgba(255,255,255,0.50);
        `;

        this._timeElapsed.set_text(this._formatTime(elapsed));
        this._timeTotal.set_text(this._formatTime(total));
    }

    _formatTime(microseconds) {
        let secs = Math.floor(microseconds / 1_000_000);
        let m = Math.floor(secs / 60);
        let s = secs % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    // ── Album art loading ─────────────────────────────────────────────────────

    _loadAlbumArt(artUrl) {
        if (!artUrl || artUrl === this._lastArtUrl) return;
        this._lastArtUrl = artUrl;
        this._log(`Loading art: ${artUrl}`);

        try {
            let file = Gio.File.new_for_uri(artUrl);
            let path = file.get_path();

            if (!path) {
                // Remote URL — not typical for Apple Music via MPRIS but handle gracefully
                this._showArtPlaceholder();
                return;
            }

            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 90, 90, false);
            if (!pixbuf) { this._showArtPlaceholder(); return; }

            let image = new Clutter.Image();
            image.set_bytes(
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha()
                    ? Cogl.PixelFormat.RGBA_8888
                    : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(),
                pixbuf.get_height(),
                pixbuf.get_rowstride()
            );

            this._artTexture.set_content(image);
            this._artTexture.set_content_scaling_filters(
                Clutter.ScalingFilter.TRILINEAR,
                Clutter.ScalingFilter.LINEAR
            );
            this._artTexture.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);

            // Fade in texture, fade out placeholder label
            this._artLabel.opacity = 0;
            this._artTexture.opacity = 255;

            this._log('Art loaded successfully');
        } catch (e) {
            this._log(`Art load failed: ${e}`);
            this._showArtPlaceholder();
        }
    }

    _showArtPlaceholder() {
        this._lastArtUrl = '';
        this._artTexture.opacity = 0;
        this._artLabel.opacity = 255;
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

        this._widget.style = this._pillStyle(EXPANDED_WIDTH, EXPANDED_HEIGHT);
        this._animateProp(this._widget, 'width', EXPANDED_WIDTH);
        this._animateProp(this._widget, 'height', EXPANDED_HEIGHT);

        this._animateProp(this._collapsedLayer, 'opacity', 0);
        this._animateProp(this._expandedLayer, 'opacity', 255);

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
        this._expandedArtist.set_text('');

        // Refresh progress display when expanding
        if (this._timelineSupported) this._updateProgressUI();
    }

    // ── Collapse (not hovered) ────────────────────────────────────────────────

    _collapse() {
        this._log('collapse');

        this._animateProp(this._expandedLayer, 'opacity', 0);

        if (this._isPlaying || this._isPaused) {
            let w = COLLAPSED_PLAYING_WIDTH;
            this._widget.style = this._pillStyle(w, COLLAPSED_HEIGHT);
            this._animateProp(this._widget, 'width', w);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);

            this._syncCollapsedPlaying();
            this._animateProp(this._collapsedLayer, 'opacity',
                this._isPaused ? 160 : 255
            );
        } else {
            this._widget.style = this._pillStyle(COLLAPSED_IDLE_WIDTH, COLLAPSED_HEIGHT);
            this._animateProp(this._widget, 'width', COLLAPSED_IDLE_WIDTH);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);

            this._syncCollapsedIdle();
            this._animateProp(this._collapsedLayer, 'opacity', 255);
        }
    }

    _syncCollapsedIdle() {
        this._collapsedLayer.remove_all_children();
        this._collapsedLayer.style = 'spacing: 0px; padding: 0 14px;';
        this._idleDot.x_expand = true;
        this._collapsedLayer.add_child(this._idleDot);
    }

    _syncCollapsedPlaying() {
        this._collapsedLayer.remove_all_children();
        this._collapsedLayer.style = 'spacing: 8px; padding: 0 14px;';
        this._idleDot.x_expand = false;
        this._collapsedLayer.add_child(this._waveBox);
        this._collapsedLayer.add_child(this._collapsedTitle);
        // this._collapsedTitle.set_text(this._lastTitle || '');
        // We don't need to show title
        this._collapsedTitle.set_text('');
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
            this._stopTimelinePoller();
            this._showArtPlaceholder();
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
        this._readVolume(busName);
        this._probeTimeline(busName);
    }

    _dbusGet(busName, prop, cb) {
        this._dbusConnection.call(
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

        if ('Volume' in changed) {
            this._currentVolume = Math.max(0, Math.min(1, changed['Volume'].unpack()));
            this._updateVolUI();
        }

        // Seek event also fires PropertiesChanged with no Position key, but
        // the Seeked signal is separate — handle Position if present (rare)
        if ('Position' in changed && this._timelineSupported) {
            try {
                this._trackPosition = changed['Position'].unpack();
                this._updateProgressUI();
            } catch (_) { }
        }
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

            // Track length from metadata (µs)
            let len = u['mpris:length'];
            this._trackLength = (len !== undefined && len !== null) ? Number(len) : 0;

            // Album art URL
            let artUrl = u['mpris:artUrl'] ?? '';
            if (artUrl) this._loadAlbumArt(artUrl);
            else this._showArtPlaceholder();

            this._log(`Meta: ${this._lastArtist} — ${this._lastTitle} (len=${this._trackLength})`);

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

        this._stopTimelinePoller();

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
