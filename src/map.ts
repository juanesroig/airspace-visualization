import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import {
    MercatorCoordinate,
  type CustomLayerInterface,
  type Map as MapboxMap,
} from "mapbox-gl"
import type { OpenSkyStateItem } from "./api"

const AIRCRAFTS_ = 'aircrafts_'
const AIRCRAFT_MODEL_URL = '/airplane.obj'
const AIRCRAFT_MODEL_SCALE = 0.5

const create_layer_id = () => {
  if (globalThis.crypto?.randomUUID) {
    return AIRCRAFTS_ + globalThis.crypto.randomUUID()
  }

  const random_suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  return AIRCRAFTS_ + random_suffix
}

type AircraftMapData = {
  object: THREE.Object3D
  // TODO: Add values for linear interpolation
}

export class AircraftLayer  {
  camera = new THREE.Camera()
  scene = new THREE.Scene()
  loader = new OBJLoader()
  renderer: THREE.WebGLRenderer = {} as THREE.WebGLRenderer
  aircrafts = new Map<string, AircraftMapData>()
  layer_params: CustomLayerInterface
  map: MapboxMap
  model_template: THREE.Object3D | null = null
  private model_template_loading: Promise<THREE.Object3D> | null = null

  constructor(map: MapboxMap) {
    this.layer_params = {
      id: create_layer_id(),
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
      render: (_gl, matrix) => {
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix)
        this.renderer.resetState()
        this.renderer.render(this.scene, this.camera)
        this.map.triggerRepaint()
      }
    }
    this.map = map
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
        object => {
          object.traverse(node => {
            if (node instanceof THREE.Mesh) {
              node.castShadow = false
              node.receiveShadow = false
            }
          })
          this.model_template = object
          resolve(object)
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
    state: OpenSkyStateItem,
  ) {
    if (state.latitude === null || state.longitude === null) {
      return
    }

    const mercator_coordinate = MercatorCoordinate.fromLngLat(
      [state.longitude, state.latitude],
      Math.max(state.geo_altitude ?? 0, 0)
    )
    const mercator_scale = mercator_coordinate.meterInMercatorCoordinateUnits()
    const scaled_size = mercator_scale * AIRCRAFT_MODEL_SCALE

    aircraft_object.position.set(
      mercator_coordinate.x,
      mercator_coordinate.y,
      mercator_coordinate.z,
    )
    aircraft_object.scale.set(scaled_size, scaled_size, scaled_size)
  }

  init() {
    this.map.addLayer(this.layer_params)
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
      const icao24 = state.icao24?.trim()
      if (!icao24) {
        continue
      }
      active_icao24.add(icao24)

      let aircraft_map_data = this.aircrafts.get(icao24)
      if (!aircraft_map_data) {
        const aircraft_object = this.model_template.clone(true)
        aircraft_map_data = { object: aircraft_object }
        this.aircrafts.set(icao24, aircraft_map_data)
        this.scene.add(aircraft_object)
      }

      this.update_aircraft_object_position(aircraft_map_data.object, state)
    }

    for (const [icao24, aircraft_map_data] of this.aircrafts) {
      if (active_icao24.has(icao24)) {
        continue
      }

      this.scene.remove(aircraft_map_data.object)
      this.aircrafts.delete(icao24)
    }

    this.map.triggerRepaint()
  }
}
