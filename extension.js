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

// Sizes
const COLLAPSED_IDLE_WIDTH = 120;   // not playing, collapsed
const COLLAPSED_PLAYING_WIDTH = 220; // playing, collapsed (wider so em dash is visible)
const EXPANDED_WIDTH = 400;          // hovered, expanded
const COLLAPSED_HEIGHT = 36;
const EXPANDED_HEIGHT = 48;

// Animation
const ANIM_DURATION = 250; // ms
const ANIM_MODE = Clutter.AnimationMode.EASE_OUT_QUAD;

export default class FunNotch extends Extension {

    _log(message) {
        try {
            let file = Gio.File.new_for_path(LOG_FILE);
            let timestamp = new Date().toISOString();
            let line = `[${timestamp}] ${message}\n`;
            let stream = file.append_to(Gio.FileCreateFlags.NONE, null);
            stream.write(line, null);
            stream.close(null);
        } catch (e) {
            console.error(e)
        }
    }

    enable() {
        this._log('enable() called');

        // Track state
        this._isPlaying = false;
        this._isPaused = false;
        this._isHovered = false;
        this._lastTitle = '';
        this._lastArtist = '';

        // --- Build UI ---

        this._widget = new St.BoxLayout({
            style: `
                background-color: black;
                border-radius: 12px;
                padding: 0 12px;
                width: ${COLLAPSED_IDLE_WIDTH}px;
                height: ${COLLAPSED_HEIGHT}px;
            `,
            reactive: true,
            clip_to_allocation: true,
        });

        // Left slot — future image/waveform area
        this._leftSlot = new St.Bin({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'min-width: 0;',
        });

        // Em dash shown when playing but collapsed
        this._waveformLabel = new St.Label({
            text: '—',
            style: 'color: white; font-size: 16px;',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
            opacity: 0, // hidden by default
        });
        this._leftSlot.set_child(this._waveformLabel);

        // Separator
        this._separator = new St.Widget({
            style: 'width: 8px;',
            opacity: 0, // hidden when collapsed
        });

        // Right slot — text
        this._textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 0, // hidden when collapsed
        });

        this._titleLabel = new St.Label({
            text: '',
            style: 'color: white; font-size: 13px;',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._artistLabel = new St.Label({
            text: '',
            style: 'color: #aaaaaa; font-size: 11px;',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._artistLabel);

        this._widget.add_child(this._leftSlot);
        this._widget.add_child(this._separator);
        this._widget.add_child(this._textBox);

        // Center on screen
        this._widget.add_constraint(new Clutter.AlignConstraint({
            source: Main.layoutManager.uiGroup,
            align_axis: Clutter.AlignAxis.X_AXIS,
            factor: 0.5,
        }));
        this._widget.add_constraint(new Clutter.AlignConstraint({
            source: Main.layoutManager.uiGroup,
            align_axis: Clutter.AlignAxis.Y_AXIS,
            factor: 0.5,
        }));

        // Hover events
        this._widget.connect('enter-event', () => {
            this._isHovered = true;
            this._expand();
        });
        this._widget.connect('leave-event', () => {
            this._isHovered = false;
            this._collapse();
        });

        Main.layoutManager.addTopChrome(this._widget);
        this._startWatching();
    }

    // --- Animation helpers ---

    _animateProp(actor, prop, value) {
        actor.set_easing_duration(ANIM_DURATION);
        actor.set_easing_mode(ANIM_MODE);
        actor[prop] = value;
    }

    _expand() {
        this._log('Expanding');

        // Expand the widget
        this._animateProp(this._widget, 'width', EXPANDED_WIDTH);
        this._animateProp(this._widget, 'height', EXPANDED_HEIGHT);

        // Hide em dash, show text area
        this._animateProp(this._waveformLabel, 'opacity', 0);
        this._animateProp(this._separator, 'opacity', 255);
        this._animateProp(this._textBox, 'opacity', 255);

        // Update text content based on state
        if (this._isPlaying) {
            // Actively playing — full brightness
            this._titleLabel.style = 'color: white; font-size: 13px;';
            this._artistLabel.style = 'color: #aaaaaa; font-size: 11px;';
            this._titleLabel.set_text(this._lastTitle || 'Unknown Title');
            this._artistLabel.set_text(this._lastArtist || '');
        } else if (this._isPaused) {
            // Paused — dimmed to indicate paused state
            this._titleLabel.style = 'color: #888888; font-size: 13px;';
            this._artistLabel.style = 'color: #666666; font-size: 11px;';
            this._titleLabel.set_text(this._lastTitle || 'Unknown Title');
            this._artistLabel.set_text(this._lastArtist || '');
        } else {
            // Nothing playing
            this._titleLabel.style = 'color: #888888; font-size: 13px;';
            this._artistLabel.style = 'color: #666666; font-size: 11px;';
            this._titleLabel.set_text('Nothing Playing');
            this._artistLabel.set_text('');
        }
    }

    _collapse() {
        this._log('Collapsing');

        // Hide text area and separator
        this._animateProp(this._textBox, 'opacity', 0);
        this._animateProp(this._separator, 'opacity', 0);

        if (this._isPlaying) {
            // Show em dash and widen slightly
            this._animateProp(this._widget, 'width', COLLAPSED_PLAYING_WIDTH);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);
            this._animateProp(this._waveformLabel, 'opacity', 255);
        } else {
            // Nothing playing — shrink to minimal
            this._animateProp(this._widget, 'width', COLLAPSED_IDLE_WIDTH);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);
            this._animateProp(this._waveformLabel, 'opacity', 0);
        }
    }

    // --- DBus ---

    _startWatching() {
        this._log('Starting DBus watch');
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
            'org.freedesktop.DBus',
            '/org/freedesktop/DBus',
            'org.freedesktop.DBus',
            'ListNames',
            null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    let reply = connection.call_finish(result);
                    let names = reply.deepUnpack()[0];
                    let players = names.filter(n => n.startsWith(MPRIS_BUS_PREFIX));
                    this._log(`Found players: ${players.join(', ') || 'none'}`);
                    players.forEach(name => this._watchPlayer(name));
                } catch (e) {
                    this._log(`_findExistingPlayers error: ${e}`);
                }
            }
        );
    }

    _onNameOwnerChanged(connection, sender, objectPath, interfaceName, signalName, parameters) {
        let [name, , newOwner] = parameters.deepUnpack();
        if (!name.startsWith(MPRIS_BUS_PREFIX)) return;

        if (newOwner !== '') {
            this._log(`New player appeared: ${name}`);
            this._watchPlayer(name);
        } else {
            this._log(`Player disappeared: ${name}`);
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
            this._log(`Skipping: ${busName}`);
            return;
        }

        this._log(`Watching: ${busName}`);
        this._currentPlayer = busName;

        if (this._propertiesWatcherId) {
            this._dbusConnection.signal_unsubscribe(this._propertiesWatcherId);
        }

        this._propertiesWatcherId = this._dbusConnection.signal_subscribe(
            busName,
            'org.freedesktop.DBus.Properties',
            'PropertiesChanged',
            MPRIS_OBJECT_PATH,
            null,
            Gio.DBusSignalFlags.NONE,
            this._onPropertiesChanged.bind(this)
        );

        this._readCurrentTrack(busName);
        this._readPlaybackStatus(busName);
    }

    _readCurrentTrack(busName) {
        this._dbusConnection.call(
            busName,
            MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Metadata']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    let reply = connection.call_finish(result);
                    let metadata = reply.deepUnpack()[0];
                    this._updateMetadata(metadata);
                } catch (e) {
                    this._log(`_readCurrentTrack error: ${e}`);
                }
            }
        );
    }

    _readPlaybackStatus(busName) {
        this._dbusConnection.call(
            busName,
            MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'PlaybackStatus']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    let reply = connection.call_finish(result);
                    let status = reply.deepUnpack()[0].unpack();
                    this._log(`PlaybackStatus: ${status}`);
                    this._handlePlaybackStatus(status);
                } catch (e) {
                    this._log(`_readPlaybackStatus error: ${e}`);
                }
            }
        );
    }

    _handlePlaybackStatus(status) {
        if (status === 'Playing') {
            this._isPlaying = true;
            this._isPaused = false;
        } else if (status === 'Paused') {
            this._isPlaying = false;
            this._isPaused = true;
        } else {
            // Stopped
            this._isPlaying = false;
            this._isPaused = false;
        }

        // Update display based on current hover state
        if (this._isHovered) {
            this._expand();
        } else {
            this._collapse();
        }
    }

    _onPropertiesChanged(connection, sender, objectPath, interfaceName, signalName, parameters) {
        let [, changedProps] = parameters.deepUnpack();

        if ('PlaybackStatus' in changedProps) {
            let status = changedProps['PlaybackStatus'].unpack();
            this._log(`PlaybackStatus changed: ${status}`);
            this._handlePlaybackStatus(status);
        }

        if ('Metadata' in changedProps) {
            this._updateMetadata(changedProps['Metadata']);
        }
    }

    _updateMetadata(metadata) {
        try {
            let unpacked = metadata.recursiveUnpack
                ? metadata.recursiveUnpack()
                : metadata;

            let trackUrl = unpacked['xesam:url'] ?? '';
            this._log(`Track URL: ${trackUrl}`);

            if (!trackUrl.includes('music.apple.com')) {
                this._log('Not Apple Music, ignoring');
                return;
            }

            this._lastTitle = unpacked['xesam:title'] ?? '';
            let artists = unpacked['xesam:artist'] ?? [];
            this._lastArtist = Array.isArray(artists)
                ? artists.join(', ')
                : String(artists);

            this._log(`Metadata updated: ${this._lastArtist} — ${this._lastTitle}`);

            // If expanded, update labels immediately
            if (this._isHovered) this._expand();

        } catch (e) {
            this._log(`_updateMetadata error: ${e}`);
        }
    }

    disable() {
        this._log('disable() called');

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
