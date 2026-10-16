import maplibregl, { type CustomRenderMethodInput } from 'maplibre-gl'
import { deg_to_rad, is_finite_number, rad_to_deg } from './utils'
import { aircraft_speed, type AircraftState } from './api'
import { AIRCRAFT_OBJECT, AIRCRAFT_VERTEX_COUNT } from './aircraft'

const KMH_TO_MS = 1 / 3.6
const MARKER_SIZE_METERS = 5000

const INSTANCE_FLOATS = 6
const COLOR_FLOATS = 4
const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT
const A_MOTION_OFFSET = 4 * Float32Array.BYTES_PER_ELEMENT

const DEFAULT_COLOR_RGBA = [1.0, 1.0, 1.0, 0.85]
const SELECTED_COLOR_RGBA = [0.14, 0.38, 0.92, 0.85]

// Fixed in the shader so the color and picking programs share attribute locations
const A_POSITION_LOC = 0
const A_STATE_LOC = 1
const A_MOTION_LOC = 2
const A_COLOR_LOC = 3

const VERTEX_SHADER_SRC = `#version 300 es

  layout(location = ${A_POSITION_LOC}) in vec3 a_position;
  layout(location = ${A_STATE_LOC}) in vec4 a_state;
  layout(location = ${A_MOTION_LOC}) in vec2 a_motion;
  layout(location = ${A_COLOR_LOC}) in vec4 a_color;

  out vec4 v_color;
  flat out vec4 v_pick_color;

  uniform float u_time;
  uniform mat4 u_globe_matrix;

  const float R = 6371008.8;
  const float MAX_DT = 30.0;
  const float HALF_SIZE = ${(MARKER_SIZE_METERS / 2).toFixed(1)};

  mat3 rot_x(float a) {
    float c=cos(a), s=sin(a);
    return mat3(1,0,0, 0,c,s, 0,-s,c);
  }

  mat3 rot_y(float a) {
    float c=cos(a), s=sin(a);
    return mat3(c,0,-s, 0,1,0, s,0,c);
  }

  mat3 rot_z(float a) {
    float c=cos(a), s=sin(a);
    return mat3(c,s,0, -s,c,0, 0,0,1);
  }

  void main() {
    float dt = clamp(u_time - a_motion.y, 0.0, MAX_DT);
    float theta = a_motion.x * dt / R;

    vec3 m = a_position * HALF_SIZE;
    vec3 p = vec3(m.xy / R, 1.0 + (a_state.w + m.z) / R);
    p = rot_x(-theta)      * p;
    p = rot_z(-a_state.z)  * p;
    p = rot_x(-a_state.y)  * p;
    p = rot_y( a_state.x)  * p;

    gl_Position = u_globe_matrix * vec4(p, 1.0);
    v_color = a_color;

    // 0 is reserved for "no aircraft", so instance ids start at 1
    uint id = uint(gl_InstanceID) + 1u;
    v_pick_color = vec4(
      float(id & 0xFFu),
      float((id >> 8) & 0xFFu),
      float((id >> 16) & 0xFFu),
      255.0
    ) / 255.0;
  }
`

const FRAGMENT_SHADER_SRC = `#version 300 es
  precision highp float;

  in vec4 v_color;

  out vec4 fragColor;

  void main() {
    fragColor = v_color;
  }
`

const PICKING_FRAGMENT_SHADER_SRC = `#version 300 es
  precision highp float;

  flat in vec4 v_pick_color;

  out vec4 fragColor;

  void main() {
    fragColor = v_pick_color;
  }
`

const create_shader = (gl: WebGL2RenderingContext, type: GLenum, source: string) => {
  const shader = gl.createShader(type)
  if (shader === null) {
    return null
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  const success = gl.getShaderParameter(shader, gl.COMPILE_STATUS)
  if (!success) {
    console.error('Shader compile failed:', gl.getShaderInfoLog(shader))
    gl.deleteShader(shader)
    return null
  }
  return shader
}

type ProgramInfo = {
  program: WebGLProgram
  u_time: WebGLUniformLocation
  u_globe_matrix: WebGLUniformLocation
}

const create_program = (
  gl: WebGL2RenderingContext,
  vertex_shader: WebGLShader,
  fragment_shader: WebGLShader,
): ProgramInfo | null => {
  const program = gl.createProgram()
  gl.attachShader(program, vertex_shader)
  gl.attachShader(program, fragment_shader)
  gl.linkProgram(program)

  const success = gl.getProgramParameter(program, gl.LINK_STATUS)
  if (!success) {
    console.error('Error linking program:', gl.getProgramInfoLog(program))
    gl.deleteProgram(program)
    return null
  }

  const u_time = gl.getUniformLocation(program, 'u_time')
  const u_globe_matrix = gl.getUniformLocation(program, 'u_globe_matrix')
  if (u_time === null || u_globe_matrix === null) {
    console.error('Missing uniforms in program')
    gl.deleteProgram(program)
    return null
  }
  return { program, u_time, u_globe_matrix }
}

type PickingTarget = {
  framebuffer: WebGLFramebuffer
  color: WebGLRenderbuffer
  depth: WebGLRenderbuffer
  width: number
  height: number
}

// x/y in drawing buffer pixels, origin at the bottom-left like WebGL
type PickRequest = {
  x: number
  y: number
  resolve: (hex: AircraftState['hex'] | null) => void
}

type IndicesByHex = Record<AircraftState['hex'], number>
export class WebGLCustomLayer {
  map: maplibregl.Map
  custom_layer_params: maplibregl.CustomLayerInterface
  color_program: ProgramInfo | null = null
  picking_program: ProgramInfo | null = null
  buffer: WebGLBuffer | null = null
  instance_buffer: WebGLBuffer | null = null
  color_buffer: WebGLBuffer | null = null
  private picking_target: PickingTarget | null = null
  private pending_picks: PickRequest[] = []
  private instance_index_by_hex: IndicesByHex = {}
  private color_index_by_hex: IndicesByHex = {}
  private hex_by_instance: AircraftState['hex'][] = []
  private instance_data = new Float32Array(0)
  private color_data = new Float32Array(0)
  private instances_dirty = false
  private colors_dirty = false
  private selected_hex: AircraftState['hex'] | null = null
  private aircraft_count = 0

  constructor(map: maplibregl.MapLibreMap) {
    this.map = map
    this.custom_layer_params = {
      id: 'custom_webgl_layer',
      type: 'custom',
      renderingMode: '3d',
      onAdd: (_map, gl) => {
        if (!(gl instanceof WebGL2RenderingContext)) {
          console.error('WebGL2 is required')
          return
        }

        const vertex_shader = create_shader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC)
        const fragment_shader = create_shader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)
        const picking_fragment_shader = create_shader(gl, gl.FRAGMENT_SHADER, PICKING_FRAGMENT_SHADER_SRC)

        if (vertex_shader === null || fragment_shader === null || picking_fragment_shader === null) {
          console.error("Couldn't create shaders")
          return
        }

        // Both programs share the same vertex shader
        this.color_program = create_program(gl, vertex_shader, fragment_shader)
        this.picking_program = create_program(gl, vertex_shader, picking_fragment_shader)

        // Linked programs keep their own copy, the shader objects are no longer needed
        gl.deleteShader(vertex_shader)
        gl.deleteShader(fragment_shader)
        gl.deleteShader(picking_fragment_shader)

        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, AIRCRAFT_OBJECT, gl.STATIC_DRAW);

        this.instance_buffer = gl.createBuffer();
        this.color_buffer = gl.createBuffer();
      },
      onRemove: (_map, gl) => {
        gl.deleteProgram(this.color_program?.program ?? null)
        gl.deleteProgram(this.picking_program?.program ?? null)
        gl.deleteBuffer(this.buffer)
        gl.deleteBuffer(this.instance_buffer)
        gl.deleteBuffer(this.color_buffer)
        this.color_program = null
        this.picking_program = null
        this.buffer = null
        this.instance_buffer = null
        this.color_buffer = null

        if (this.picking_target !== null) {
          gl.deleteFramebuffer(this.picking_target.framebuffer)
          gl.deleteRenderbuffer(this.picking_target.color)
          gl.deleteRenderbuffer(this.picking_target.depth)
          this.picking_target = null
        }

        for (const request of this.pending_picks) {
          request.resolve(null)
        }
        this.pending_picks = []

        // The buffers created on the next onAdd start empty, so re-upload on the next render
        this.instances_dirty = true
        this.colors_dirty = true
      },
      render: (gl, args) => {
        if (!(gl instanceof WebGL2RenderingContext)) {
          return
        }
        if (this.color_program === null) {
          return
        }
        gl.useProgram(this.color_program.program)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(A_POSITION_LOC);
        gl.vertexAttribPointer(A_POSITION_LOC, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instance_buffer);
        if (this.instances_dirty) {
          gl.bufferData(gl.ARRAY_BUFFER, this.instance_data, gl.DYNAMIC_DRAW);
          this.instances_dirty = false
        }
        gl.enableVertexAttribArray(A_STATE_LOC);
        gl.vertexAttribPointer(A_STATE_LOC, 4, gl.FLOAT, false, INSTANCE_STRIDE, 0);
        gl.vertexAttribDivisor(A_STATE_LOC, 1);
        gl.enableVertexAttribArray(A_MOTION_LOC);
        gl.vertexAttribPointer(A_MOTION_LOC, 2, gl.FLOAT, false, INSTANCE_STRIDE, A_MOTION_OFFSET);
        gl.vertexAttribDivisor(A_MOTION_LOC, 1);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.color_buffer);
        if (this.colors_dirty) {
          gl.bufferData(gl.ARRAY_BUFFER, this.color_data, gl.DYNAMIC_DRAW);
          this.colors_dirty = false
        }
        gl.enableVertexAttribArray(A_COLOR_LOC);
        gl.vertexAttribPointer(A_COLOR_LOC, 4, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(A_COLOR_LOC, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.uniformMatrix4fv(
          this.color_program.u_globe_matrix,
          false,
          args.defaultProjectionData.mainMatrix,
        )

        const time = performance.now() / 1000
        gl.uniform1f(this.color_program.u_time, time)

        gl.drawArraysInstanced(gl.TRIANGLES, 0, AIRCRAFT_VERTEX_COUNT, this.aircraft_count);

        if (this.pending_picks.length > 0) {
          this.run_picking_pass(gl, args.defaultProjectionData.mainMatrix, time)
        }

        gl.vertexAttribDivisor(A_STATE_LOC, 0);
        gl.vertexAttribDivisor(A_MOTION_LOC, 0);
        gl.vertexAttribDivisor(A_COLOR_LOC, 0);

        this.map.triggerRepaint()
      }
    }
  }

  init() {
    const layer = this.map.getLayer(this.custom_layer_params.id)
    if (layer === undefined) {
      this.map.addLayer(this.custom_layer_params)
    }
  }

  clear() {
    const layer = this.map.getLayer(this.custom_layer_params.id)
    if (layer !== undefined) {
      this.map.removeLayer(layer.id)
    }
  }

  pick(point: maplibregl.Point): Promise<AircraftState['hex'] | null> {
    const canvas = this.map.getCanvas()
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
      return Promise.resolve(null)
    }

    const x = Math.floor(point.x * canvas.width / canvas.clientWidth)
    const y = canvas.height - 1 - Math.floor(point.y * canvas.height / canvas.clientHeight)

    return new Promise((resolve) => {
      this.pending_picks.push({ x, y, resolve })
      this.map.triggerRepaint()
    })
  }

  private ensure_picking_framebuffer(gl: WebGL2RenderingContext): PickingTarget | null {
    const width = gl.drawingBufferWidth
    const height = gl.drawingBufferHeight
    if (width === 0 || height === 0) {
      return null
    }

    const target = this.picking_target
    if (target !== null && target.width === width && target.height === height) {
      return target
    }

    // Only called from render(), MapLibre rebinds its own framebuffer/renderbuffer afterwards
    const framebuffer = target?.framebuffer ?? gl.createFramebuffer()
    const color = target?.color ?? gl.createRenderbuffer()
    const depth = target?.depth ?? gl.createRenderbuffer()

    gl.bindRenderbuffer(gl.RENDERBUFFER, color)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, width, height)
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth)
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, width, height)

    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color)
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth)
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER)

    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.error('Picking framebuffer incomplete:', status)
      gl.deleteFramebuffer(framebuffer)
      gl.deleteRenderbuffer(color)
      gl.deleteRenderbuffer(depth)
      this.picking_target = null
      return null
    }

    this.picking_target = { framebuffer, color, depth, width, height }
    return this.picking_target
  }

  private run_picking_pass(
    gl: WebGL2RenderingContext,
    matrix: CustomRenderMethodInput['defaultProjectionData']['mainMatrix'],
    time: number,
  ) {
    const requests = this.pending_picks
    this.pending_picks = []

    const target = this.ensure_picking_framebuffer(gl)
    if (this.picking_program === null || target === null) {
      for (const request of requests) {
        request.resolve(null)
      }
      return
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
    gl.viewport(0, 0, target.width, target.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.disable(gl.BLEND)

    gl.useProgram(this.picking_program.program)
    gl.uniformMatrix4fv(this.picking_program.u_globe_matrix, false, matrix)
    gl.uniform1f(this.picking_program.u_time, time)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, AIRCRAFT_VERTEX_COUNT, this.aircraft_count)

    const pixel = new Uint8Array(4)
    for (const request of requests) {
      const is_mouse_out_screen = request.x < 0 || request.x >= target.width
          || request.y < 0 || request.y >= target.height
      if (is_mouse_out_screen) {
        request.resolve(null)
        continue
      }
      gl.readPixels(request.x, request.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
      const id = pixel[0] | (pixel[1] << 8) | (pixel[2] << 16)
      request.resolve(id === 0 ? null : this.hex_by_instance[id - 1] ?? null)
    }
  }

  private set_aircraft_color(hex: AircraftState['hex'], rgba: number[]) {
    const color_index = this.color_index_by_hex[hex]
    if (color_index === undefined) return
    for (let idx = 0; idx < COLOR_FLOATS; idx++) {
      this.color_data[color_index + idx] = rgba[idx]
    }
    this.colors_dirty = true
  }

  select_aircraft(hex: AircraftState['hex'] | null) {
    if (this.selected_hex !== null) {
      this.set_aircraft_color(this.selected_hex, DEFAULT_COLOR_RGBA)
    }
    this.selected_hex = hex
    if (hex === null) return

    this.set_aircraft_color(hex, SELECTED_COLOR_RGBA)
    const instance_index = this.instance_index_by_hex[hex]
    if (instance_index === undefined) return
    const lon = rad_to_deg(this.instance_data[instance_index])
    const lat = rad_to_deg(this.instance_data[instance_index + 1])
    this.map.flyTo({zoom: 9, center: [lon, lat]})
  }

  update_aircrafts(states: AircraftState[]) {
    if (this.instance_data.length < states.length * INSTANCE_FLOATS) {
      this.instance_data = new Float32Array(states.length * INSTANCE_FLOATS)
    }
    if (this.color_data.length < states.length * COLOR_FLOATS) {
      this.color_data = new Float32Array(states.length * COLOR_FLOATS)
    }

    const t0 = performance.now() / 1000

    this.instance_index_by_hex = {}
    this.color_index_by_hex = {}

    let count = 0
    for (const state of states) {
      if (!is_finite_number(state.lat) || !is_finite_number(state.lng)) {
        continue
      }
      this.hex_by_instance[count] = state.hex
      const instance_offset = count * INSTANCE_FLOATS
      this.instance_index_by_hex[state.hex] = instance_offset
      this.instance_data[instance_offset] = deg_to_rad(state.lng)
      this.instance_data[instance_offset + 1] = deg_to_rad(state.lat)
      this.instance_data[instance_offset + 2] = deg_to_rad(state.dir ?? 0)
      this.instance_data[instance_offset + 3] = state.alt ?? 0
      this.instance_data[instance_offset + 4] = (aircraft_speed(state)?.kmh ?? 0) * KMH_TO_MS
      this.instance_data[instance_offset + 5] = t0

      const color_offset = count * COLOR_FLOATS
      this.color_index_by_hex[state.hex] = color_offset
      const color = state.hex === this.selected_hex ? SELECTED_COLOR_RGBA : DEFAULT_COLOR_RGBA
      for (let idx = 0; idx < COLOR_FLOATS; idx++) {
        this.color_data[color_offset + idx] = color[idx]
      }
      count++
    }

    // Drop instances left over from a previous, larger update
    this.hex_by_instance.length = count
    this.aircraft_count = count
    this.instances_dirty = true
    this.colors_dirty = true
    this.map.triggerRepaint()
  }
}
