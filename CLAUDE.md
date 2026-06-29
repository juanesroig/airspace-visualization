# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start the Vite dev server (the app expects a backend on `http://localhost:5000`, see Backend dependency below).
- `npm run build` — type-check with `tsc -b` (project references) then `vite build`.
- `npm run lint` — run ESLint over the repo.
- `npm run preview` — serve the production build.

There is no test runner configured.

## Backend dependency

The frontend is useless on its own. `src/api.ts` hardcodes `http://localhost:5000/api/opensky/<slug>`, and `App.tsx` opens a Server-Sent Events stream against `opensky_url('states')`. A separate backend (not in this repo) must proxy the [OpenSky Network](https://openskynetwork.github.io/opensky-api/) states API and push it over SSE with `success`/`error` named events. The SSE `success` event carries `{ states: OpenSkyStatePayloadTuple[] }`, where each state is a positional array decoded against `OPEN_SKY_STATES_PAYLOAD_COLUMNS`.

The basemap uses a hardcoded MapTiler style URL/key in `main.tsx`. `.env`'s `VITE_MAPBOX_ACCESS_TOKEN` is leftover scaffolding and is not currently read.

## Architecture

This is a React 19 + Vite + TypeScript app that renders live air traffic on a 3D globe. The data flow is: backend SSE → `App.tsx` → `AircraftLayer` (the rendering engine).

**Two overlaid DOM layers (`index.html`).** `#map` holds the MapLibre globe; `#root` holds the React UI (the flight-cards panel) on top of it. The MapLibre `Map` instance is created in `main.tsx` and passed into `<App map={map} />` as a prop — React does not own the map, it drives it.

**`src/map.ts` — `AircraftLayer`** is the heart of the project and the most subtle file. It registers **two MapLibre layers** that swap at `ZOOM_THRESHOLD` (7):
- A `custom` WebGL layer that shares MapLibre's GL context with a Three.js scene, rendering one cloned glTF airplane model (`/airplane.glb`) per aircraft. Only renders when zoomed in past the threshold.
- A `symbol` layer (2D sprite from `/airplane.svg`, `maxzoom: ZOOM_THRESHOLD`) backed by a GeoJSON source, used when zoomed out.

  Both are kept in sync from a single `Map<icao24, AircraftMapData>`. Aircraft positions are **interpolated every frame** in the custom layer's `render` callback: each update from the backend sets an origin (reported lon/lat) and a `project_position`-computed destination (dead-reckoned `DELTA_MS` ahead from heading + velocity), and `progress` is advanced by frame delta time and `lerp`'d. `update_geojson_src` repaints the symbol layer from the same interpolated positions.

  Picking is mode-dependent (`detect_mouse_on_aircraft`): a Three.js `Raycaster` against the 3D models when zoomed in, `map.queryRenderedFeatures` against the symbol layer when zoomed out. Aircraft color (default / hovered / selected) is mutated in place per-object via cloned Three materials and the GeoJSON `color` property.

**`src/App.tsx`** owns UI state (hovered/selected aircraft, which aircraft are in the viewport bbox, lazy-loaded card count) and wires MapLibre events (`moveend`/`zoomend`/`click`/`mousemove`) to the layer. Hover/selection is bidirectional: hovering a card recolors the map model and vice versa, coordinated through `AircraftLayer.change_aircraft_color`. The viewport list comes from `AircraftLayer.items_in_bbox()`, recomputed on map move and on each data update. Cards render in batches of `CARD_BATCH_SIZE` via scroll-based lazy loading.

**`src/state.ts`** holds the Jotai atom for OpenSky load status, built on a generic discriminated-union `LoadingState` helper (`make_loading_states`). `App.tsx`'s render is a `switch` over `LoadingStateStatus`; `missing_case` (in `utils.ts`) enforces exhaustiveness at the type level.

**`src/api.ts`** decodes the OpenSky positional-array wire format. `OPEN_SKY_STATES_PAYLOAD_COLUMNS` is the source of truth for the column order — its order must match the backend payload exactly, and `OpenSkyStatePayloadTuple` is derived from it via the `ValuesAsTuple` mapped type. The `Result` / `OpenSkyApi` helpers exist but the live path uses SSE, not these fetch helpers.

**`src/utils.ts`** holds the math: `lerp`/`unlerp`/`remap` (used for interpolation and screen→NDC mapping in raycasting) and `project_position` (great-circle dead reckoning).

## Conventions

- Identifiers use `snake_case` (functions, variables, even some local helpers) rather than the usual JS `camelCase`. Match the surrounding style.
- Styling is CSS Modules (`App.module.css`) plus design-system CSS custom properties in `index.css`; `main.tsx` reads those tokens to tint the globe sky so the map and UI stay visually in sync.
- Hover/cursor handling is intentionally **not** debounced for responsiveness, even though a `debounce` helper exists for use elsewhere.
