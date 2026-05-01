// src/ui.js
//
// Owns all expand / collapse / sync UI state.
// Receives plain data from Player via callbacks — no DBus here.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';

import {
    COLLAPSED_IDLE_WIDTH,
    COLLAPSED_PLAYING_WIDTH,
    EXPANDED_WIDTH,
    COLLAPSED_HEIGHT,
    EXPANDED_HEIGHT,
    ANIM_DURATION,
    ANIM_MODE,
    LOG_FILE,
} from './constants.js';

export class NotchUI {
    constructor(widget, actors) {
        // widget — the outer St.Widget pill
        // actors — all named child actors built in extension.js _buildUI()
        this._widget = widget;
        this._a = actors; // short alias

        this._isPlaying = false;
        this._isPaused = false;
        this._isHovered = false;
        this._lastTitle = '';
        this._lastArtUrl = '';
    }

    _log(msg) {
        try {
            let f = Gio.File.new_for_path(LOG_FILE);
            let ts = new Date().toISOString();
            let s = f.append_to(Gio.FileCreateFlags.NONE, null);
            s.write(`[${ts}] [UI] ${msg}\n`, null);
            s.close(null);
        } catch (e) { console.error(e); }
    }

    // ── State setters (called by Player callbacks) ─────────────────────────────

    setPlaying() {
        this._isPlaying = true;
        this._isPaused = false;
        this._refresh();
    }

    setPaused() {
        this._isPlaying = false;
        this._isPaused = false; // collapsed same as idle — hides in notch
        this._refresh();
    }

    setHovered(hovered) {
        this._isHovered = hovered;
        this._refresh();
    }

    setMetadata({ title, artist, artUrl }) {
        this._lastTitle = title;
        if (artUrl) this._loadAlbumArt(artUrl);
        else this._showArtPlaceholder();
        this._refresh();
    }

    setVolume(frac) {
        let px = Math.round(frac * 58);
        this._a.volFill.style = `
            width: ${px}px;
            height: 8px;
            border-radius: 4px;
            background-color: rgba(255,255,255,0.35);
        `;
    }

    setPosition(positionMicros, lengthMicros) {
        // positionMicros === null means timeline not supported — hide progress row
        if (positionMicros === null) {
            this._a.progressRow.opacity = 0;
            return;
        }

        let frac = lengthMicros > 0
            ? Math.max(0, Math.min(1, positionMicros / lengthMicros))
            : 0;
        let trackW = this._a.progressTrack.get_width() || 200;
        let fillPx = Math.round(frac * trackW);

        this._a.progressFill.style = `
            width: ${fillPx}px;
            height: 8px;
            border-radius: 4px;
            background-color: rgba(255,255,255,0.50);
        `;
        this._a.timeElapsed.set_text(this._formatTime(positionMicros));
        this._a.timeTotal.set_text(this._formatTime(lengthMicros));
    }

    disconnect() {
        this._isPlaying = false;
        this._isPaused = false;
        this._lastTitle = '';
        this._showArtPlaceholder();
        this._refresh();
    }

    // ── Internal refresh — single source of truth for expand/collapse ──────────

    _refresh() {
        if (this._isHovered) this._expand();
        else this._collapse();
    }

    // ── Expand ────────────────────────────────────────────────────────────────

    _expand() {
        this._widget.style = this._pillStyle(EXPANDED_WIDTH, EXPANDED_HEIGHT);
        this._animateProp(this._widget, 'width', EXPANDED_WIDTH);
        this._animateProp(this._widget, 'height', EXPANDED_HEIGHT);

        this._animateProp(this._a.collapsedLayer, 'opacity', 0);
        this._animateProp(this._a.expandedLayer, 'opacity', 255);

        // Button glyph + text dimming based on state
        if (this._isPlaying) {
            this._a.btnPlayPause.label = '⏸';
            this._a.expandedTitle.style = 'color: white; font-size: 13px; font-weight: bold;';
            this._a.expandedArtist.style = 'color: rgba(255,255,255,0.42); font-size: 11px;';
        } else {
            this._a.btnPlayPause.label = '▶';
            this._a.expandedTitle.style = 'color: rgba(255,255,255,0.28); font-size: 13px; font-weight: bold;';
            this._a.expandedArtist.style = 'color: rgba(255,255,255,0.16); font-size: 11px;';
        }

        let hasTrack = this._isPlaying || !!this._lastTitle;
        this._a.expandedTitle.set_text(
            this._lastTitle || (hasTrack ? 'Unknown Title' : 'Nothing Playing')
        );
        this._a.expandedArtist.set_text('');
    }

    // ── Collapse ──────────────────────────────────────────────────────────────

    _collapse() {
        this._animateProp(this._a.expandedLayer, 'opacity', 0);

        if (this._isPlaying) {
            // Playing: wider pill with waveform
            this._widget.style = this._pillStyle(COLLAPSED_PLAYING_WIDTH, COLLAPSED_HEIGHT);
            this._animateProp(this._widget, 'width', COLLAPSED_PLAYING_WIDTH);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);
            this._syncCollapsedPlaying();
            this._animateProp(this._a.collapsedLayer, 'opacity', 255);
        } else {
            // Idle or paused: small pill hidden inside notch
            this._widget.style = this._pillStyle(COLLAPSED_IDLE_WIDTH, COLLAPSED_HEIGHT);
            this._animateProp(this._widget, 'width', COLLAPSED_IDLE_WIDTH);
            this._animateProp(this._widget, 'height', COLLAPSED_HEIGHT);
            this._syncCollapsedIdle();
            this._animateProp(this._a.collapsedLayer, 'opacity', 255);
        }
    }

    _syncCollapsedIdle() {
        this._a.collapsedLayer.remove_all_children();
        this._a.collapsedLayer.style = 'spacing: 0px; padding: 0 14px;';
        this._a.idleDot.x_expand = true;
        this._a.collapsedLayer.add_child(this._a.idleDot);
    }

    _syncCollapsedPlaying() {
        this._a.collapsedLayer.remove_all_children();
        this._a.collapsedLayer.style = 'spacing: 8px; padding: 0 14px;';
        this._a.idleDot.x_expand = false;
        this._a.collapsedLayer.add_child(this._a.waveBox);
        this._a.collapsedLayer.add_child(this._a.collapsedTitle);
        this._a.collapsedTitle.set_text(''); // no title in collapsed playing state
    }

    // ── Album art ─────────────────────────────────────────────────────────────

    _loadAlbumArt(artUrl) {
        if (artUrl === this._lastArtUrl) return;
        this._lastArtUrl = artUrl;
        this._log(`Loading art: ${artUrl}`);

        try {
            let file = Gio.File.new_for_uri(artUrl);
            let path = file.get_path();
            if (!path) { this._showArtPlaceholder(); return; }

            let pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 90, 90, false);
            if (!pixbuf) { this._showArtPlaceholder(); return; }

            let coglCtx = global.stage.context.get_backend().get_cogl_context();
            let image = St.ImageContent.new_with_preferred_size(90, 90);
            image.set_bytes(
                coglCtx,
                pixbuf.get_pixels(),
                pixbuf.get_has_alpha()
                    ? Cogl.PixelFormat.RGBA_8888
                    : Cogl.PixelFormat.RGB_888,
                pixbuf.get_width(),
                pixbuf.get_height(),
                pixbuf.get_rowstride()
            );

            this._a.artTexture.set_content(image);
            this._a.artTexture.set_content_scaling_filters(
                Clutter.ScalingFilter.TRILINEAR,
                Clutter.ScalingFilter.LINEAR
            );
            this._a.artTexture.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);

            this._a.artLabel.opacity = 0;
            this._a.artTexture.opacity = 255;
            this._log('Art loaded');
        } catch (e) {
            this._log(`Art load failed: ${e}`);
            this._showArtPlaceholder();
        }
    }

    _showArtPlaceholder() {
        this._lastArtUrl = '';
        this._a.artTexture.opacity = 0;
        this._a.artLabel.opacity = 255;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _animateProp(actor, prop, value) {
        actor.set_easing_duration(ANIM_DURATION);
        actor.set_easing_mode(ANIM_MODE);
        actor[prop] = value;
    }

    _pillStyle(w, h) {
        return `
            background-color: #0c0c0c;
            border-radius: 0 0 22px 22px;
            width: ${w}px;
            height: ${h}px;
        `;
    }

    _formatTime(microseconds) {
        let secs = Math.floor((microseconds || 0) / 1_000_000);
        let m = Math.floor(secs / 60);
        let s = secs % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }
}
