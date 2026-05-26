import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import maplibregl from 'maplibre-gl'
import type { OpenSkyStateItem } from "./api"

const AIRCRAFTS_ = 'aircrafts_'
const AIRCRAFT_MODEL_URL = '/airplane.obj'

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
  layer_params: maplibregl.CustomLayerInterface
  map: maplibregl.Map
  model_template: THREE.Object3D | null = null
  private model_template_loading: Promise<THREE.Object3D> | null = null

  constructor(map: maplibregl.Map) {
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
      render: (_gl, args) => {
        this.camera.projectionMatrix = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix)
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
    const model_matrix = this.map.transform.getMatrixForModel(
      [state.longitude, state.latitude],
      Math.max(state.geo_altitude ?? 0, 0),
    )

    const heading_rad = THREE.MathUtils.degToRad(state.true_track ?? 0)

    const north_normalization = Math.PI / 2
    const direction_rotation_matrix = new THREE.Matrix4().makeRotationY(north_normalization - heading_rad)
    const normalization_rotation_matrix = new THREE.Matrix4().makeRotationX(Math.PI/2)

    const AIRCRAFT_MODEL_SCALE_AT_WORLD_VIEW = 1
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
      const icao24 = state.icao24.trim()
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
