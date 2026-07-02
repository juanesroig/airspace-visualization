import './index.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import maplibregl from 'maplibre-gl'

// Pull colors from the design-system tokens so the globe stays in sync
// with index.css. Falls back to the token values if a var is missing.
const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://api.maptiler.com/maps/hybrid-v4-dark/style.json?key=xRFctPYdIXy6WuSSlKCV',
  center: [14.42053, 46.55908],
  pitch: 45,
  zoom: 4.5,
});

map.on('style.load', () => {
  map.setProjection({ type: 'globe' })

  // Tint the space/atmosphere around the globe with the design system,
  // replacing MapLibre's default white sky.
  map.setSky({
    'sky-color': token('--bg', 'rgb(7, 11, 16)'),             // the "space"
    'horizon-color': token('--surface-3', 'rgb(28, 39, 54)'), // horizon band
    'fog-color': token('--surface-1', 'rgb(13, 19, 27)'),     // haze over terrain
    'sky-horizon-blend': 0.6,
    'horizon-fog-blend': 0.5,
    'fog-ground-blend': 0.5,
    'atmosphere-blend': 0.8,                                   // atmospheric halo
  })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App map={map} />
  </StrictMode>,
)
