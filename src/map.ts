import * as THREE from 'three'
import maplibregl, { GeoJSONSource } from 'maplibre-gl'
import type { OpenSkyStateItem, OpenSkyTrack } from "./api"
import { deg_to_rad, project_position, remap } from './utils'
import { lerp } from 'three/src/math/MathUtils.js'
import { GLTFLoader, Line2, LineGeometry, LineMaterial } from 'three/examples/jsm/Addons.js'

const AIRCRAFTS_ = 'aircrafts_'
const AIRCRAFTS_SRC = AIRCRAFTS_ + 'src'
const TRACK_LINE_WIDTH = 3
const AIRCRAFT_MODEL_URL = '/airplane.glb'
const AIRCRAFT_SPRITE_URL = '/airplane.svg'
const AIRCRAFT_SPRITE_SIZE = 512
const ZOOM_THRESHOLD = 7
const DELTA_MS = 18_000

export const AIRCRAFT_COLOR = '#ffffff'
export const AIRCRAFT_HOVERED = '#5b9cf0'
export const AIRCRAFT_SELECTED = '#2563eb'

export const TRACK_COLOR_START = '#1d4ed8'
export const TRACK_COLOR_END = '#60a5fa'

const create_layer_id = (suffix: string) => {
  if (globalThis.crypto?.randomUUID) {
    return AIRCRAFTS_ + globalThis.crypto.randomUUID() + suffix
  }

  const random_suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  return AIRCRAFTS_ + random_suffix
}

type TrackLine = {
  line: Line2;
  waypoints: Array<[lon: number, lat: number, altitude: number]>;
}

type AircraftTrack = {
  icao24: OpenSkyStateItem['icao24'];
  lines: TrackLine[];
}

type AircraftMapData = {
  object: THREE.Object3D;
  altitude: number;
  heading_deg: number;
  origin_lon: number;
  origin_lat: number;
  destination_lon: number;
  destination_lat: number;
  updated_at: number;
  progress: number;
  color: string;
}

export class AircraftLayer  {
  camera = new THREE.Camera()
  scene = new THREE.Scene()
  track_scene = new THREE.Scene()
  loader = new GLTFLoader()
  renderer: THREE.WebGLRenderer = {} as THREE.WebGLRenderer
  aircrafts = new Map<string, AircraftMapData>()
  custom_layer_params: maplibregl.CustomLayerInterface
  track_layer_params: maplibregl.CustomLayerInterface
  symbol_layer_params: maplibregl.SymbolLayerSpecification
  track: AircraftTrack | null = null
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
        this.ensure_renderer(current_map.getCanvas(), gl)
        this.add_lights()
        this.load_model_template()
      },
      render: (_gl, args) => {
        const now = performance.now()
        const dt = now - this.last_frame
        this.last_frame = now

        if (this.map.getZoom() < ZOOM_THRESHOLD) return

        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix)

        const bounds = this.map.getBounds()
        const tracked_icao24 = this.track?.icao24

        for (const aircraft of this.aircrafts.values()) {
          aircraft.progress = Math.min(aircraft.progress + dt / DELTA_MS, 1)
          const new_lon = lerp(aircraft.origin_lon, aircraft.destination_lon, aircraft.progress)
          const new_lat = lerp(aircraft.origin_lat, aircraft.destination_lat, aircraft.progress)
          const is_tracked = aircraft.object.userData.icao24 === tracked_icao24
          if (!is_tracked && !bounds.contains([new_lon, new_lat])) {
            continue
          }
          this.update_aircraft_object_position(
            aircraft.object,
            new_lon,
            new_lat,
            aircraft.altitude,
            aircraft.heading_deg,
          )
        }

        this.renderer.resetState()
        this.renderer.render(this.scene, this.camera)
        this.map.triggerRepaint()
      }
    }
    this.track_layer_params = {
      id: create_layer_id('track'),
      type: 'custom',
      renderingMode: '3d',
      onAdd: (current_map, gl) => {
        this.ensure_renderer(current_map.getCanvas(), gl)
      },
      render: (_gl, args) => {
        if (this.track === null) return
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix)
        this.update_track_geometry()
        this.renderer.resetState()
        this.renderer.render(this.track_scene, this.camera)
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
        'icon-color': ['get', 'color'],
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
            coordinates: [state.origin_lon, state.origin_lat],
          },
          properties: {
            name: icao24,
            altitude: state.altitude,
            true_track: state.heading_deg,
            color: state.color,
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

  private build_track_line(
    waypoints: [lon: number, lat: number, altitude: number][],
  ): Line2 {
    const start = new THREE.Color(TRACK_COLOR_START)
    const end = new THREE.Color(TRACK_COLOR_END)
    const colors: number[] = []
    for (let i = 0; i < waypoints.length; i++) {
      const t = i / (waypoints.length - 1)
      const color = start.clone().lerp(end, t)
      colors.push(color.r, color.g, color.b)
    }

    const geometry = new LineGeometry()
    geometry.setPositions(new Array(waypoints.length * 3).fill(0))
    geometry.setColors(colors)

    const material = new LineMaterial({
      linewidth: TRACK_LINE_WIDTH,
      vertexColors: true,
      worldUnits: false,
    })

    const line = new Line2(geometry, material)
    line.matrixAutoUpdate = false
    line.frustumCulled = false
    return line
  }

  private update_track_geometry() {
    if (this.track === null) {
      return
    }

    const canvas = this.map.getCanvas()
    const model_matrix = new THREE.Matrix4()
    const world_position = new THREE.Vector3()

    for (const { line, waypoints } of this.track.lines) {
      const positions: number[] = []
      for (const [lon, lat, altitude] of waypoints) {
        model_matrix.fromArray(
          this.map.transform.getMatrixForModel([lon, lat], Math.max(altitude, 0)),
        )
        world_position.setFromMatrixPosition(model_matrix)
        positions.push(world_position.x, world_position.y, world_position.z)
      }
      line.geometry.setPositions(positions);
      line.material.resolution.set(canvas.width, canvas.height)
    }
  }

  public update_tracks(tracks: OpenSkyTrack[]) {
    this.clear_tracks()

    if (tracks.length === 0) {
      return
    }

    const lines: TrackLine[] = []

    for (const track of tracks) {
      const waypoints: [lon: number, lat: number, altitude: number][] = []
      for (const waypoint of track.path) {
        if (waypoint.longitude !== null && waypoint.latitude !== null) {
          waypoints.push([waypoint.longitude, waypoint.latitude, waypoint.baro_altitude ?? 0])
        }
      }

      if (waypoints.length < 2) {
        continue
      }

      waypoints.push([...waypoints[waypoints.length - 1]])

      const line = this.build_track_line(waypoints)
      this.track_scene.add(line)
      lines.push({ line, waypoints })
    }

    this.track = { icao24: tracks[0].icao24, lines }
    this.map.triggerRepaint()
  }

  public clear_tracks() {
    if (this.track === null) {
      return
    }
    for (const { line } of this.track.lines) {
      this.track_scene.remove(line)
      line.geometry.dispose()
      line.material.dispose()
    }
    this.track = null
    this.map.triggerRepaint()
  }

  private ensure_renderer(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext | WebGLRenderingContext) {
    if (this.renderer instanceof THREE.WebGLRenderer) {
      return
    }
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl,
      antialias: true,
    })
    this.renderer.autoClear = false
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

    if (this.track === null || aircraft_object.userData.icao24 !== this.track.icao24) {
      return
    }
    for (const { waypoints } of this.track.lines) {
      if (waypoints.length > 0) {
        waypoints[waypoints.length - 1] = [x, y, z]
      }
    }
  }

  private clone_aircraft_object(template: THREE.Object3D) {
    const object = template.clone(true)
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        node.material = Array.isArray(node.material)
          ? node.material.map(material => material.clone())
          : node.material.clone()
      }
    })
    return object
  }

  private apply_object_color(object: THREE.Object3D, color: string) {
    const three_color = new THREE.Color(color)
    object.traverse(node => {
      if (node instanceof THREE.Mesh) {
        const materials = Array.isArray(node.material) ? node.material : [node.material]
        for (const material of materials) {
          if ('color' in material && material.color instanceof THREE.Color) {
            material.color.copy(three_color)
          }
        }
      }
    })
  }

  public change_aircraft_color(
    icao24: OpenSkyStateItem['icao24'],
    color: string,
  ) {
    const aircraft = this.aircrafts.get(icao24)
    if (aircraft === undefined) {
      return
    }
    aircraft.color = color
    this.apply_object_color(aircraft.object, color)
    this.update_geojson_src()
    this.map.triggerRepaint()
  }

  private load_sprite_image(): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = AIRCRAFT_SPRITE_SIZE
        canvas.height = AIRCRAFT_SPRITE_SIZE
        const ctx = canvas.getContext('2d')
        if (ctx === null) {
          reject(new Error('Could not get 2D canvas context for aircraft sprite'))
          return
        }
        ctx.drawImage(image, 0, 0, AIRCRAFT_SPRITE_SIZE, AIRCRAFT_SPRITE_SIZE)
        resolve(ctx.getImageData(0, 0, AIRCRAFT_SPRITE_SIZE, AIRCRAFT_SPRITE_SIZE))
      }
      image.onerror = () => reject(new Error('Could not load aircraft sprite SVG'))
      image.src = AIRCRAFT_SPRITE_URL
    })
  }

  init() {
    this.map.addLayer(this.track_layer_params)
    this.map.addLayer(this.custom_layer_params)
    this.load_sprite_image().then(image_data => {
      this.map.addSource(AIRCRAFTS_SRC, this.aircrafts_to_geojson())
      this.map.addImage('airplane', image_data)
      this.map.addLayer(this.symbol_layer_params, this.track_layer_params.id)
    }).catch(error => {
      console.error('Could not initialize aircraft sprite', error)
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

      const existing = this.aircrafts.get(icao24)
      let aircraft_object = existing?.object
      const color = existing?.color ?? AIRCRAFT_COLOR
      if (aircraft_object === undefined) {
        aircraft_object = this.clone_aircraft_object(this.model_template)
        aircraft_object.userData.icao24 = icao24
        this.apply_object_color(aircraft_object, color)
        this.scene.add(aircraft_object)
      }
      const [destination_lon, destination_lat] = project_position(
        state.longitude,
        state.latitude,
        state.true_track ?? 0,
        state.velocity ?? 0,
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
        color,
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

  public aircraft_position(
    icao24: OpenSkyStateItem['icao24'],
  ): [lon: number, lat: number] | null {
    const aircraft = this.aircrafts.get(icao24)
    if (aircraft === undefined) {
      return null
    }
    return [
      lerp(aircraft.origin_lon, aircraft.destination_lon, aircraft.progress),
      lerp(aircraft.origin_lat, aircraft.destination_lat, aircraft.progress),
    ]
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

  public detect_mouse_on_aircraft(
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
