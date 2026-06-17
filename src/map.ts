import * as THREE from 'three'
import maplibregl, { GeoJSONSource } from 'maplibre-gl'
import type { OpenSkyStateItem } from "./api"
import { deg_to_rad, project_position, remap } from './utils'
import { lerp } from 'three/src/math/MathUtils.js'
import { GLTFLoader } from 'three/examples/jsm/Addons.js'

const AIRCRAFTS_ = 'aircrafts_'
const AIRCRAFTS_SRC = AIRCRAFTS_ + 'src'
const AIRCRAFT_MODEL_URL = '/airplane.glb'
const AIRCRAFT_SPRITE_URL = '/airplane.png'
const ZOOM_THRESHOLD = 7
const DELTA_MS = 18_000

const create_layer_id = (suffix: string) => {
  if (globalThis.crypto?.randomUUID) {
    return AIRCRAFTS_ + globalThis.crypto.randomUUID() + suffix
  }

  const random_suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  return AIRCRAFTS_ + random_suffix
}

type AircraftMapData = {
  object: THREE.Object3D;
  // TODO: Add values for linear interpolation
  altitude: number;
  heading_deg: number;
  origin_lon: number;
  origin_lat: number;
  destination_lon: number;
  destination_lat: number;
  updated_at: number;
  progress: number;
}

export class AircraftLayer  {
  camera = new THREE.Camera()
  scene = new THREE.Scene()
  loader = new GLTFLoader()
  renderer: THREE.WebGLRenderer = {} as THREE.WebGLRenderer
  aircrafts = new Map<string, AircraftMapData>()
  custom_layer_params: maplibregl.CustomLayerInterface
  symbol_layer_params: maplibregl.SymbolLayerSpecification
  map: maplibregl.Map
  model_template: THREE.Object3D | null = null
  private model_template_loading: Promise<THREE.Object3D> | null = null
  last_frame = performance.now()

  constructor(map: maplibregl.Map) {
    this.custom_layer_params = {
      id: create_layer_id('3d'),
      type: 'custom',
      renderingMode: '3d',
      onAdd: (current_map, gl) => {
        this.renderer = new THREE.WebGLRenderer({
          canvas: current_map.getCanvas(),
          context: gl,
          antialias: true,
        })
        this.renderer.autoClear = false
        this.add_lights()
        this.load_model_template()
      },
      render: (_gl, args) => {
        const now = performance.now()
        const dt = now - this.last_frame
        this.last_frame = now
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix)

        for (const [id, aircraft] of this.aircrafts.entries()) {
          const progress = aircraft.progress + dt / DELTA_MS
          // TODO: If progress > 1, recompute new destination coords
          const new_lon = lerp(aircraft.origin_lon, aircraft.destination_lon, progress)
          const new_lat = lerp(aircraft.origin_lat, aircraft.destination_lat, progress)
          this.update_aircraft_object_position(
            aircraft.object,
            new_lon,
            new_lat,
            aircraft.altitude,
            aircraft.heading_deg,
          )
          this.aircrafts.set(id, {...aircraft, progress})
        }

        this.update_geojson_src()
        this.renderer.resetState()

        if (this.map.getZoom() < ZOOM_THRESHOLD) return
        this.renderer.render(this.scene, this.camera)
        this.map.triggerRepaint()
      }
    }
    this.symbol_layer_params = {
      id: create_layer_id('symbol'),
      type: 'symbol',
      source: AIRCRAFTS_SRC,
      layout: {
        'icon-size': 0.015,
        'icon-image': 'airplane',
        'visibility': 'visible',
        'icon-rotation-alignment': 'map',
        'icon-rotate': ['get', 'true_track'],
        'icon-allow-overlap': true,
      },
      paint: {
        'icon-color': '#ffffff',
      },
      maxzoom: ZOOM_THRESHOLD,
    }
    this.map = map
  }

  private aircrafts_to_geojson() {
    const geojson: maplibregl.GeoJSONSourceSpecification = {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: Array.from(this.aircrafts.entries()).map(([icao24, state]) => ({
          type: 'Feature',
          geometry:  {
            type: 'Point',
            coordinates: [
              lerp(state.origin_lon, state.destination_lon, state.progress),
              lerp(state.origin_lat, state.destination_lat, state.progress)
            ],
          },
          properties: {
            name: icao24,
            altitude: state.altitude,
            true_track: state.heading_deg,
          }
        }))
      }
    }
    return geojson
  }

  private update_geojson_src() {
    const source = this.map.getSource(AIRCRAFTS_SRC)
    if (source !== undefined && source.type === "geojson") {
      const geojson = this.aircrafts_to_geojson();
      (source as GeoJSONSource).setData(geojson.data)
    }
  }

  private add_lights() {
    const ambient_light = new THREE.AmbientLight(0xffffff, 0.65)
    const directional_light = new THREE.DirectionalLight(0xffffff, 1.1)
    directional_light.position.set(0, -70, 100)
    this.scene.add(ambient_light)
    this.scene.add(directional_light)
  }

  private async load_model_template() {
    if (this.model_template !== null) {
      return
    }

    if (this.model_template_loading !== null) {
      await this.model_template_loading
      return
    }

    this.model_template_loading = new Promise((resolve, reject) => {
      this.loader.load(
        AIRCRAFT_MODEL_URL,
        gltf => {
          gltf.scene.traverse(node => {
            if (node instanceof THREE.Mesh) {
              node.castShadow = false
              node.receiveShadow = false
            }
          })
          this.model_template = gltf.scene
          resolve(gltf.scene)
        },
        undefined,
        error => {
          console.error('Could not load aircraft model', error)
          reject(error)
        }
      )
    })

    try {
      await this.model_template_loading
    } finally {
      this.model_template_loading = null
    }
  }

  private update_aircraft_object_position(
    aircraft_object: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    rotation_deg: number,
  ) {
    const model_matrix = this.map.transform.getMatrixForModel(
      [x, y],
      Math.max(z, 0),
    )
    const heading_rad = deg_to_rad(rotation_deg)
    const north_normalization = Math.PI
    const direction_rotation_matrix = new THREE.Matrix4().makeRotationY(north_normalization - heading_rad)
    const normalization_rotation_matrix = new THREE.Matrix4().makeRotationX(Math.PI/2)

    const AIRCRAFT_MODEL_SCALE_AT_WORLD_VIEW = 90
    const scale_matrix = new THREE.Matrix4().makeScale(
      AIRCRAFT_MODEL_SCALE_AT_WORLD_VIEW,
      AIRCRAFT_MODEL_SCALE_AT_WORLD_VIEW,
      AIRCRAFT_MODEL_SCALE_AT_WORLD_VIEW,
    )

    const aircraft_matrix = new THREE.Matrix4()
      .fromArray(model_matrix)
      .multiply(scale_matrix)
      .multiply(direction_rotation_matrix)
      .multiply(normalization_rotation_matrix)

    aircraft_object.matrixAutoUpdate = false
    aircraft_object.matrix.copy(aircraft_matrix)
    aircraft_object.updateMatrixWorld(true)
  }

  init() {
    this.map.addLayer(this.custom_layer_params)
    this.map.loadImage(AIRCRAFT_SPRITE_URL).then(image => {
      this.map.addSource(AIRCRAFTS_SRC, this.aircrafts_to_geojson())
      this.map.addImage('airplane', image.data)
      this.map.addLayer(this.symbol_layer_params)
    })
  }

  async update_aircrafts(opensky_states: OpenSkyStateItem[]) {
    try {
      await this.load_model_template()
    } catch {
      return
    }

    if (this.model_template === null) {
      return
    }

    const active_icao24 = new Set<string>()

    for (const state of opensky_states) {
      const icao24 = state.icao24.trim()
      active_icao24.add(icao24)

      let aircraft_object = this.aircrafts.get(icao24)?.object
      if (aircraft_object === undefined) {
        aircraft_object = this.model_template.clone(true)
        aircraft_object.userData.icao24 = icao24
        this.scene.add(aircraft_object)
      }
      const [destination_lon, destination_lat] = project_position(
        state.longitude,
        state.latitude,
        state.true_track ?? 0, // FIXME:
        state.velocity ?? 0, // FIXME:
        DELTA_MS / 1000,
      )
      const aircraft_map_data = {
        object: aircraft_object,
        origin_lon: state.longitude,
        origin_lat: state.latitude,
        destination_lon,
        destination_lat,
        updated_at: performance.now(),
        altitude: state.geo_altitude ?? 0,
        heading_deg: state.true_track ?? 0,
        progress: 0,
      }
      this.aircrafts.set(icao24, aircraft_map_data)

      this.update_aircraft_object_position(
        aircraft_map_data.object,
        state.longitude,
        state.latitude,
        state.geo_altitude ?? 0,
        state.true_track ?? 0,
      )
    }

    for (const [icao24, aircraft_map_data] of this.aircrafts) {
      if (active_icao24.has(icao24)) {
        continue
      }

      this.scene.remove(aircraft_map_data.object)
      this.aircrafts.delete(icao24)
    }

    this.update_geojson_src()
    this.map.triggerRepaint()
  }

  public items_in_bbox() {
    const bounds = this.map.getBounds()
    const result = new Set<OpenSkyStateItem['icao24']>()

    for (const [aicraft_id, aircraft_data] of this.aircrafts.entries()) {
      const new_lon = lerp(
        aircraft_data.origin_lon,
        aircraft_data.destination_lon,
        aircraft_data.progress,
      )
      const new_lat = lerp(
        aircraft_data.origin_lat,
        aircraft_data.destination_lat,
        aircraft_data.progress,
      )
      if (bounds.contains([new_lon, new_lat])) {
        result.add(aicraft_id)
      }
    }
    return result
  }

  private objects_for_ids(ids: Set<OpenSkyStateItem['icao24']>) {
    const objects: THREE.Object3D[] = []
    for (const icao24 of ids) {
      const aircraft = this.aircrafts.get(icao24)
      if (aircraft !== undefined) {
        objects.push(aircraft.object)
      }
    }
    return objects
  }

  public get_clicked_aircraft(
    ev: maplibregl.MapMouseEvent,
    candidate_ids?: Set<OpenSkyStateItem['icao24']>,
  ) {
    if (this.map.getZoom() > ZOOM_THRESHOLD) {
      const rect = this.map.getCanvas().getBoundingClientRect();
      const px = ev.originalEvent.clientX - rect.left;
      const py = ev.originalEvent.clientY - rect.top;

      const ndx = remap(0, rect.width, -1, 1, px);
      const ndy = remap(0, rect.height, 1, -1, py);

      const inverse_projection = this.camera.projectionMatrix.clone().invert()

      const near = new THREE.Vector3(ndx, ndy, -1).applyMatrix4(inverse_projection)
      const far = new THREE.Vector3(ndx, ndy, 1).applyMatrix4(inverse_projection)
      const direction = far.clone().sub(near).normalize()

      const raycaster = new THREE.Raycaster();
      raycaster.set(near, direction);

      const targets = candidate_ids !== undefined
        ? this.objects_for_ids(candidate_ids)
        : this.scene.children
      const intersections = raycaster.intersectObjects(targets, true);
      if (intersections.length === 0) {
        return null
      }

      for (const intersection of intersections) {
        let node: THREE.Object3D | null = intersection.object
        while (node !== null) {
          const icao24 = node.userData.icao24 as OpenSkyStateItem['icao24'] | undefined
          if (icao24 !== undefined) {
            return icao24
          }
          node = node.parent
        }
      }

      return null
    } else {
      const features = this.map.queryRenderedFeatures(ev.point)
      if (features.length === 0) {
        return null
      }
      const [aircraft] = features
      return aircraft.properties.name as OpenSkyStateItem['icao24']
    }
  }
}
