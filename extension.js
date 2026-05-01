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

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Player } from './src/player.js';
import { NotchUI } from './src/ui.js';

import {
    COLLAPSED_IDLE_WIDTH,
    COLLAPSED_HEIGHT,
    WAVE_TICK_MS,
    WAVE_PERIOD,
    WAVE_COUNT,
    WAVE_BAR_W,
    WAVE_MIN_H,
    WAVE_MAX_H,
    WAVE_PHASES,
    WAVE_REST_H,
} from './src/constants.js';

export default class FunNotch extends Extension {

    enable() {
        this._isPlaying = false;
        this._waveTimer = null;
        this._waveStart = Date.now();

        this._buildUI();

        // Wire Player → UI
        this._player = new Player({
            onPlay: () => {
                this._isPlaying = true;
                this._ui.setPlaying();
            },
            onPause: () => {
                this._isPlaying = false;
                this._ui.setPaused();
            },
            onMetadata: (meta) => {
                this._ui.setMetadata(meta);
            },
            onVolume: (frac) => {
                this._ui.setVolume(frac);
            },
            onPosition: (pos, len) => {
                this._ui.setPosition(pos, len);
            },
            onDisconnect: () => {
                this._isPlaying = false;
                this._ui.disconnect();
            },
        });

        this._player.start();
        this._startWaveAnimation();
    }

    disable() {
        if (this._waveTimer) {
            GLib.Source.remove(this._waveTimer);
            this._waveTimer = null;
        }

        this._player?.stop();
        this._player = null;

        if (this._widget) {
            Main.layoutManager.removeChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
        }

        this._ui = null;
    }

    // ── UI construction ───────────────────────────────────────────────────────
    // Builds all actors, connects hover + button events, then hands everything
    // to NotchUI which owns state transitions from here on.

    _buildUI() {
        // ── Outer pill ────────────────────────────────────────────────────
        this._widget = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            // background-color: #0c0c0c;
            style: `
                background-color: #000000;
                border-radius: 0 0 22px 22px;
                width: ${COLLAPSED_IDLE_WIDTH}px;
                height: ${COLLAPSED_HEIGHT}px;
            `,
            reactive: true,
            clip_to_allocation: true,
        });

        // ── Collapsed layer ───────────────────────────────────────────────
        const collapsedLayer = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px; padding: 0 14px;',
        });

        const idleDot = new St.Widget({
            style: `
                width: 7px; height: 7px;
                border-radius: 4px;
                background-color: #252525;
            `,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        const waveBox = new St.BoxLayout({
            style: 'spacing: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        const waveBars = [];
        for (let i = 0; i < WAVE_COUNT; i++) {
            let bar = new St.Widget({
                style: this._barStyle(WAVE_REST_H[i], 0.5),
                y_align: Clutter.ActorAlign.CENTER,
            });
            waveBox.add_child(bar);
            waveBars.push(bar);
        }
        this._waveBars = waveBars; // needed by wave animation

        const collapsedTitle = new St.Label({
            text: '',
            style: 'color: rgba(255,255,255,0.68); font-size: 12px;',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        collapsedTitle.clutter_text.set_ellipsize(imports.gi.Pango.EllipsizeMode.END);

        collapsedLayer.add_child(idleDot);
        this._widget.add_child(collapsedLayer);

        // ── Expanded layer ────────────────────────────────────────────────
        const expandedLayer = new St.BoxLayout({
            x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0,
            style: 'spacing: 14px; padding: 42px 16px 14px 16px;',
        });

        // Column 1 — Album art
        const artBox = new St.Bin({
            style: `
                width: 90px; min-height: 90px;
                border-radius: 10px;
                background-color: #150e2a;
                border: 1px solid rgba(255,255,255,0.07);
            `,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            clip_to_allocation: true,
        });
        const artLabel = new St.Label({
            text: '♪',
            style: 'color: rgba(255,255,255,0.20); font-size: 28px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        const artTexture = new Clutter.Actor({
            x_expand: true, y_expand: true, opacity: 0,
        });
        artBox.add_child(artLabel);
        artBox.add_child(artTexture);

        // Column 2 — Track info + progress
        const centerCol = new St.BoxLayout({
            vertical: true, x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            style: 'spacing: 0px;',
        });

        const expandedTitle = new St.Label({
            text: '',
            style: 'color: white; font-size: 13px; font-weight: bold;',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        expandedTitle.clutter_text.set_ellipsize(imports.gi.Pango.EllipsizeMode.END);

        const expandedArtist = new St.Label({
            text: '',
            style: 'color: rgba(255,255,255,0.42); font-size: 11px;',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        expandedArtist.clutter_text.set_ellipsize(imports.gi.Pango.EllipsizeMode.END);

        const centerSpacer = new St.Widget({ y_expand: true });

        const progressRow = new St.BoxLayout({
            vertical: true, x_expand: true, style: 'spacing: 2px;',
        });
        const progressTrack = new St.Widget({
            style: `height: 8px; border-radius: 4px; background-color: rgba(255,255,255,0.10);`,
            x_expand: true, reactive: true,
        });
        const progressFill = new St.Widget({
            style: `width: 0px; height: 8px; border-radius: 4px; background-color: rgba(255,255,255,0.50);`,
        });
        progressTrack.add_child(progressFill);

        const timeRow = new St.BoxLayout({ x_expand: true });
        const timeElapsed = new St.Label({
            text: '0:00',
            style: 'color: rgba(255,255,255,0.22); font-size: 9px;',
            x_align: Clutter.ActorAlign.START,
        });
        const timeSpacer = new St.Widget({ x_expand: true });
        const timeTotal = new St.Label({
            text: '0:00',
            style: 'color: rgba(255,255,255,0.22); font-size: 9px;',
            x_align: Clutter.ActorAlign.END,
        });
        timeRow.add_child(timeElapsed);
        timeRow.add_child(timeSpacer);
        timeRow.add_child(timeTotal);

        progressRow.add_child(progressTrack);
        progressRow.add_child(timeRow);

        centerCol.add_child(expandedTitle);
        centerCol.add_child(expandedArtist);
        centerCol.add_child(centerSpacer);
        centerCol.add_child(progressRow);

        // Column 3 — Controls
        const controlsCol = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'spacing: 10px;',
        });

        const btnPrev = this._makeCtrlBtn('prev');
        const btnPlayPause = this._makeCtrlBtn('play');
        const btnNext = this._makeCtrlBtn('next');

        const btnRow = new St.BoxLayout({
            style: 'spacing: 2px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btnRow.add_child(btnPrev);
        btnRow.add_child(btnPlayPause);
        btnRow.add_child(btnNext);

        // Volume
        const volRow = new St.BoxLayout({
            style: 'spacing: 5px;',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const volLow = new St.Label({ text: '🔈', style: 'font-size: 14px; color: rgba(255,255,255,0.22);', y_align: Clutter.ActorAlign.CENTER });
        const volTrack = new St.Widget({
            style: `width: 58px; height: 8px; border-radius: 4px; background-color: rgba(255,255,255,0.10);`,
            y_align: Clutter.ActorAlign.CENTER, reactive: true,
        });
        const volFill = new St.Widget({
            style: `width: 36px; height: 8px; border-radius: 4px; background-color: rgba(255,255,255,0.35);`,
        });
        volTrack.add_child(volFill);
        const volHigh = new St.Label({ text: '🔊', style: 'font-size: 14px; color: rgba(255,255,255,0.22);', y_align: Clutter.ActorAlign.CENTER });

        volRow.add_child(volLow);
        volRow.add_child(volTrack);
        volRow.add_child(volHigh);

        controlsCol.add_child(btnRow);
        controlsCol.add_child(volRow);

        expandedLayer.add_child(artBox);
        expandedLayer.add_child(centerCol);
        expandedLayer.add_child(controlsCol);
        this._widget.add_child(expandedLayer);

        // ── Position pill top-center ──────────────────────────────────────
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

        Main.layoutManager.addTopChrome(this._widget);

        // ── Hand actors to NotchUI ────────────────────────────────────────
        this._ui = new NotchUI(this._widget, {
            collapsedLayer, expandedLayer,
            idleDot, waveBox, collapsedTitle,
            artBox, artLabel, artTexture,
            expandedTitle, expandedArtist,
            centerSpacer, progressRow,
            progressTrack, progressFill,
            timeElapsed, timeTotal,
            btnPlayPause,
            volTrack, volFill,
        });

        // ── Button events ─────────────────────────────────────────────────
        btnPrev.connect('clicked', () => this._player?.call('Previous'));
        btnPlayPause.connect('clicked', () => this._player?.call('PlayPause'));
        btnNext.connect('clicked', () => this._player?.call('Next'));

        // Seek on progress click
        progressTrack.connect('button-press-event', (actor, event) => {
            if (!this._player?.timelineSupported || this._player?.trackLength <= 0)
                return Clutter.EVENT_PROPAGATE;
            let [x] = event.get_coords();
            let [ax] = actor.get_transformed_position();
            let frac = Math.max(0, Math.min(1, (x - ax) / actor.get_width()));
            this._player.seek(Math.round(frac * this._player.trackLength));
            return Clutter.EVENT_STOP;
        });

        // Volume click + scroll
        volTrack.connect('button-press-event', (actor, event) => {
            let [x] = event.get_coords();
            let [ax] = actor.get_transformed_position();
            let frac = Math.max(0, Math.min(1, (x - ax) / actor.get_width()));
            this._player?.setVolume(frac);
            return Clutter.EVENT_STOP;
        });
        volTrack.connect('scroll-event', (actor, event) => {
            let dir = event.get_scroll_direction();
            let delta = (dir === Clutter.ScrollDirection.UP) ? 0.05 : -0.05;
            this._player?.nudgeVolume(delta);
            return Clutter.EVENT_STOP;
        });

        // Hover
        this._widget.connect('enter-event', () => this._ui.setHovered(true));
        this._widget.connect('leave-event', () => this._ui.setHovered(false));
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
                for (let i = 0; i < WAVE_COUNT; i++)
                    this._waveBars[i].style = this._barStyle(WAVE_REST_H[i], 0.18);
            }
            return GLib.SOURCE_CONTINUE;
        };
        this._waveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WAVE_TICK_MS, tick);
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
        const size = isPlay ? 40 : 38;
        const glyphs = { prev: '⏮', play: '⏸', next: '⏭' };

        const bgNormal = isPlay ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.00)';
        const bgHover = isPlay ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.08)';
        const fgNormal = isPlay ? 'rgba(255,255,255,0.90)' : 'rgba(255,255,255,0.55)';
        const fgHover = 'rgba(255,255,255,1.00)';

        const s = (bg, fg) => `
            width: ${size}px; height: ${size}px;
            border-radius: ${Math.round(size / 2)}px;
            background-color: ${bg}; color: ${fg};
            font-size: ${isPlay ? 17 : 14}px; padding: 0;
        `;

        let btn = new St.Button({
            style: s(bgNormal, fgNormal),
            label: glyphs[role],
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        btn.connect('enter-event', () => { btn.style = s(bgHover, fgHover); });
        btn.connect('leave-event', () => { btn.style = s(bgNormal, fgNormal); });
        return btn;
    }
}
