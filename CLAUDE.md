# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server (the app expects a backend on `http://localhost:5000`, see Backend dependency below).
- `npm run build` — type-check with `tsc -b` (project references) then `vite build`.
- `npm run lint` — run ESLint over the repo.
- `npm run preview` — serve the production build.

There is no test runner configured.

## Backend dependency

The frontend is useless on its own. `src/api.ts` builds `<VITE_API_URL>/api/<slug>` (base from the `VITE_API_URL` env var, defaulting to `http://localhost:5000` for local dev), and `App.tsx` opens a Server-Sent Events stream against `api_url('states')`. A separate backend (not in this repo) aggregates several air traffic sources and pushes them over SSE with `success`/`error` named events. The SSE `success` event carries a bare `AircraftState[]` — no wrapping object, no decoding. Units on the wire: `alt` in meters, `speed` in km/h, `v_speed` in m/s, `dir` in degrees clockwise from north; aircraft are keyed by `hex`. Only `hex`/`lat`/`lng`/`updated`/`status`/`type` are guaranteed, `lat`/`lng` can be null, and `speed` is absent on over a third of a live sample — `update_aircrafts` skips records without a finite position and defaults the rest, because a NaN coordinate makes MapLibre throw `Invalid LngLat object`. `aircraft_speed` (in `api.ts`) fills the missing speeds: airborne aircraft get a hardcoded median for their altitude band so they keep moving, flagged `estimated` so the cards can mark them with a `~`; anything not airborne gets `null` rather than an invented speed.

The basemap uses a hardcoded MapTiler style URL/key in `main.tsx`. The only env var the app reads is `VITE_API_URL` (see `.env.example`); `.env`'s `VITE_MAPBOX_ACCESS_TOKEN` is leftover scaffolding and is not read.

## Architecture

This is a React 19 + Vite + TypeScript app that renders live air traffic on a 3D globe. The data flow is: backend SSE → `App.tsx` → `WebGLCustomLayer` (the rendering engine). There is no Three.js: aircraft are drawn with raw WebGL2.

**Two overlaid DOM layers (`index.html`).** `#map` holds the MapLibre globe; `#root` holds the React UI (the flight-cards panel) on top of it. The MapLibre `Map` instance is created in `main.tsx` and passed into `<App map={map} />` as a prop — React does not own the map, it drives it.

**`src/webgl.ts` — `WebGLCustomLayer`** is the heart of the project and the most subtle file. It is a single MapLibre `custom` layer (`renderingMode: '3d'`) that shares MapLibre's WebGL2 context and draws every aircraft with **one instanced draw call** (`drawArraysInstanced`) of the mesh in `src/aircraft.ts` (vertices generated from `public/airplane.glb`, not loaded at runtime).
- Per-instance data lives in two `Float32Array`s uploaded only when dirty: `instance_data` (`lng`/`lat`/`dir` in radians, `alt` in m, speed in m/s, and the timestamp of the update) and `color_data` (RGBA). `update_aircrafts` rebuilds both plus the `hex → offset` maps and `hex_by_instance` on every SSE update.
- **Motion is dead-reckoned in the vertex shader**, not on the CPU: it advances each aircraft along its heading by `speed * (u_time - update_time)` (clamped to `MAX_DT`) and places it on the globe with rotations, then applies MapLibre's `defaultProjectionData.mainMatrix`. The layer calls `triggerRepaint()` every frame.
- Attribute locations are fixed in the shader with `layout(location = N)` (`A_*_LOC`), so the color and picking programs share them.

  **Picking is GPU color picking.** The same vertex shader outputs `flat v_pick_color` = `gl_InstanceID + 1` packed into RGB (0 means no aircraft). `pick(point)` converts CSS px to drawing-buffer px (ratio `canvas.width / clientWidth`, Y flipped), queues a request and returns a Promise. On the next `render`, `run_picking_pass` draws once into an offscreen RGBA8 + depth renderbuffer FBO (`ensure_picking_framebuffer`, resized lazily) with blending disabled, then `readPixels` one pixel per queued request and decodes it through `hex_by_instance`. **Picking only works inside `render`**: the globe matrix only exists there, and it relies on MapLibre having set 3D depth mode before calling `render` and calling `setDirty()` afterwards, which is why the pass saves/restores no GL state. Never draw or bind GL state from outside `render` — MapLibre's state cache and VAOs would be corrupted. Changing `renderingMode` to `'2d'` would make depth read-only and silently break picking.

  Selection is shown by recoloring the instance (`select_aircraft`, which also `flyTo`s it). There is no hover color on the globe yet.

**`src/App.tsx`** owns UI state (hovered/selected aircraft, which aircraft are in the viewport bbox, lazy-loaded card count) and wires MapLibre events to the layer. `click`/`mousemove` call `pick()`; since it resolves a frame later, each handler numbers its requests and ignores any answer that is not the latest. Hovering or selecting a card goes through the same `update_hovered_aircraft` / `update_selected_aircraft`. The viewport list is recomputed by `refresh_aircrafts_on_screen` (`map.getBounds()` over the latest states) on `moveend`/`zoomend` and on each data update. Cards render in batches of `CARD_BATCH_SIZE` via scroll-based lazy loading. The SSE stream is closed after `INACTIVE_DISCONNECT_MS` with the tab hidden.

**`src/api.ts`** types the wire format — states arrive as `AircraftState` objects and need no decoding — and compensates for its gaps via `aircraft_speed`. The `Result` / `Api` helpers exist but the live path uses SSE, not these fetch helpers.

**`src/utils.ts`** holds small helpers (`deg_to_rad`/`rad_to_deg`, `is_finite_number`, `debounce`) plus the traffic load status types: a generic discriminated-union `LoadingState` helper (`make_loading_states`). `App.tsx`'s render is a `switch` over `LoadingStateStatus`; `missing_case` enforces exhaustiveness at the type level.

## Conventions

- Identifiers use `snake_case` (functions, variables, even some local helpers) rather than the usual JS `camelCase`. Match the surrounding style.
- Styling is CSS Modules (`App.module.css`) plus design-system CSS custom properties in `index.css`; `main.tsx` reads those tokens to tint the globe sky so the map and UI stay visually in sync.
- Hover/cursor handling is intentionally **not** debounced for responsiveness, even though a `debounce` helper exists for use elsewhere.
