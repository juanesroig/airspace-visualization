import './index.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import maplibregl from 'maplibre-gl'

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://api.maptiler.com/maps/hybrid-v4-dark/style.json?key=xRFctPYdIXy6WuSSlKCV', // style URL
  center: [0, 0],
  zoom: 1,
});

map.on('style.load', () => {
  map.setProjection({ type: 'globe' })
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App map={map} />
  </StrictMode>,
)
