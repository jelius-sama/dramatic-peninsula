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

export default class FunNotch extends Extension {

    _log(message) {
        try {
            let file = Gio.File.new_for_path(LOG_FILE);
            let timestamp = new Date().toISOString();
            let line = `[${timestamp}] ${message}\n`;

            // APPEND_ONLY so we don't overwrite previous logs
            let stream = file.append_to(
                Gio.FileCreateFlags.NONE,
                null
            );
            stream.write(line, null);
            stream.close(null);
        } catch (e) {
            // silently fail if we can't write logs
        }
    }

    enable() {
        this._log('enable() called');

        // Outer container — horizontal rectangle, centered on screen
        this._widget = new St.BoxLayout({
            style: `
                background-color: black;
                border-radius: 12px;
                padding: 8px 16px;
                width: 400px;
                height: 48px;
            `,
            reactive: true,
        });

        // Left side — reserved for future image/icon
        // Empty for now but takes up space to push text right
        this._leftSlot = new St.Bin({
            style: 'width: 40px;',
        });

        // Right side — text container
        this._textBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.END,  // align content to the right
        });

        // Song title
        this._titleLabel = new St.Label({
            text: 'Nothing Playing',
            style: 'color: white; font-size: 13px;',
            x_align: Clutter.ActorAlign.END,
        });

        // Artist name — slightly smaller and dimmer
        this._artistLabel = new St.Label({
            text: '',
            style: 'color: #aaaaaa; font-size: 11px;',
            x_align: Clutter.ActorAlign.END,
        });

        this._textBox.add_child(this._titleLabel);
        this._textBox.add_child(this._artistLabel);

        this._widget.add_child(this._leftSlot);
        this._widget.add_child(this._textBox);

        // Center on screen using constraints
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

        Main.layoutManager.addTopChrome(this._widget);

        this._startWatching();
    }

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
            this._titleLabel.set_text('Nothing Playing');
            this._artistLabel.set_text('');

            if (this._propertiesWatcherId) {
                this._dbusConnection.signal_unsubscribe(this._propertiesWatcherId);
                this._propertiesWatcherId = null;
            }
        }
    }

    _watchPlayer(busName) {
        // We only care about Firefox
        if (!busName.toLowerCase().includes('firefox')) {
            this._log(`Skipping non-firefox player: ${busName}`);
            return;
        }

        this._log(`Watching Firefox player: ${busName}`);
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
    }

    _readCurrentTrack(busName) {
        this._dbusConnection.call(
            busName,
            MPRIS_OBJECT_PATH,
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', [
                'org.mpris.MediaPlayer2.Player',
                'Metadata'
            ]),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (connection, result) => {
                try {
                    let reply = connection.call_finish(result);
                    let metadata = reply.deepUnpack()[0];
                    this._updateLabels(metadata);
                } catch (e) {
                    this._log(`_readCurrentTrack error: ${e}`);
                }
            }
        );
    }

    _onPropertiesChanged(connection, sender, objectPath, interfaceName, signalName, parameters) {
        let [, changedProps] = parameters.deepUnpack();
        if ('Metadata' in changedProps) {
            this._updateLabels(changedProps['Metadata']);
        }
    }

    _updateLabels(metadata) {
        try {
            let unpacked = metadata.recursiveUnpack
                ? metadata.recursiveUnpack()
                : metadata;

            this._log(`Raw metadata keys: ${Object.keys(unpacked).join(', ')}`);

            // Check if the track URL is from Apple Music
            let trackUrl = unpacked['xesam:url'] ?? '';
            this._log(`Track URL: ${trackUrl}`);

            if (!trackUrl.includes('music.apple.com')) {
                this._log('Not Apple Music, ignoring');
                this._titleLabel.set_text('Nothing Playing');
                this._artistLabel.set_text('');
                return;
            }

            let title = unpacked['xesam:title'] ?? '';
            let artists = unpacked['xesam:artist'] ?? [];
            let artist = Array.isArray(artists) ? artists.join(', ') : String(artists);

            this._log(`Now playing: ${artist} — ${title}`);

            this._titleLabel.set_text(title || 'Unknown Title');
            this._artistLabel.set_text(artist || '');

        } catch (e) {
            this._log(`_updateLabels error: ${e}`);
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
