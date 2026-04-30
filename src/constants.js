import Clutter from 'gi://Clutter';

// ─── Sizes ─────────────────────────────────────────────────────────────────────
export const COLLAPSED_IDLE_WIDTH = 160;
export const COLLAPSED_PLAYING_WIDTH = 310;
export const EXPANDED_WIDTH = 520;
export const COLLAPSED_HEIGHT = 42;
export const EXPANDED_HEIGHT = 162;

// ─── Animation ────────────────────────────────────────────────────────────────
export const ANIM_DURATION = 280;
export const ANIM_MODE = Clutter.AnimationMode.EASE_OUT_QUINT;

// ─── Waveform ─────────────────────────────────────────────────────────────────
export const WAVE_TICK_MS = 40;
export const WAVE_PERIOD = 750;
export const WAVE_COUNT = 3;
export const WAVE_BAR_W = 3;
export const WAVE_MIN_H = [3, 4, 3];
export const WAVE_MAX_H = [12, 18, 14];
export const WAVE_PHASES = [0, 140, 260];
export const WAVE_REST_H = [6, 11, 7];

// ─── Timeline poll interval ────────────────────────────────────────────────────
export const TIMELINE_TICK_MS = 1000;

export const MPRIS_BUS_PREFIX = 'org.mpris.MediaPlayer2';
export const MPRIS_OBJECT_PATH = '/org/mpris/MediaPlayer2';
export const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
export const LOG_FILE = '/tmp/fun-notch.log';
