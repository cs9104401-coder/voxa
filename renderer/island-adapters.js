'use strict';

/* Voxa island data adapters (Stage 2).
   The Home tab widgets never touch main-process state directly: each widget
   reads exactly one adapter, and the Stage 5-8 wiring (real SMTC media, real
   weather/telemetry) swaps these mock implementations without touching the
   overlay markup, CSS or the state machine.
   DATA RULES until those swaps land:
   - getMedia() returns preview-only metadata; `preview: true` makes the card
     show its small Preview badge. Nothing here is presented as real playback.
   - getWeather() returns `tempC: null` — the card must render "--" and never
     invent a city or a forecast.
   - getTimeOfDay() is the one real source in Stage 2: the user's local clock
     drives the gradient choice, the Day/Evening/Night title and the arc dot. */

let mockPlaying = false;

function getMedia() {
  // MOCK (Stage 5 swaps this): fixed preview sample, no live source attached.
  return {
    preview: true,
    title: 'Preview track',
    artist: 'Sample artist',
    album: 'Preview album',
    playing: mockPlaying,
    position: 47,
    duration: 214
  };
}

function mediaAction(action) {
  // Preview-local transport: flips the mock flag only — no IPC, no real player.
  if (action === 'toggle') mockPlaying = !mockPlaying;
  else if (action === 'next' || action === 'previous') mockPlaying = false;
  return getMedia();
}

function getWeather() {
  // MOCK (Stages 6-7 swap this): no temperature, no city, no forecast data.
  return { preview: true, tempC: null, city: '' };
}

function getTimeOfDay(now = new Date()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const phase = minutes >= 20 * 60 || minutes < 5 * 60 ? 'night' : minutes >= 17 * 60 ? 'evening' : 'day';
  const label = phase === 'night' ? 'Night' : phase === 'evening' ? 'Evening' : 'Day';
  return { minutes, phase, label };
}

window.islandAdapters = { getMedia, mediaAction, getWeather, getTimeOfDay };
