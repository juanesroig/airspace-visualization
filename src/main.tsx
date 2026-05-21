import './index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/mapbox-gl.css'

const mapbox_access_token = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN

if (!mapbox_access_token) {
  throw new Error('Missing VITE_MAPBOX_ACCESS_TOKEN in .env')
}

mapboxgl.accessToken = mapbox_access_token
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/juanesroig/cmokylad7001601qy9o130ywy',
  projection: 'mercator',
  zoom: 2.3,
  center: [30, 15],
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App map={map} />
  </StrictMode>,
)
