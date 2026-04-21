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
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class FunNotch extends Extension {
    enable() {
        this._widget = new St.BoxLayout({
            style: 'background-color: black; padding: 10px; width: 200px; height: 200px;',
            reactive: true,
        });

        this._label = new St.Label({
            text: 'Hello World',
            style: 'color: white; font-size: 24px; text-align: center;'
        });

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

        this._widget.add_child(this._label);
        Main.layoutManager.addTopChrome(this._widget);
    }

    disable() {
        if (this._widget) {
            Main.layoutManager.removeTopChrome(this._widget);
            this._widget.destroy();
            this._widget = null;
        }
    }
}
