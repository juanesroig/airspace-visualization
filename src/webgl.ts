import maplibregl from 'maplibre-gl'
import { deg_to_rad, is_finite_number } from './utils'
import { aircraft_speed, type AircraftState } from './api'
import { AIRCRAFT_OBJECT, AIRCRAFT_VERTEX_COUNT } from './aircraft'

const KMH_TO_MS = 1 / 3.6
const MARKER_SIZE_METERS = 5000

const INSTANCE_FLOATS = 6
const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT
const A_MOTION_OFFSET = 4 * Float32Array.BYTES_PER_ELEMENT

const VERTEX_SHADER_SRC = `#version 300 es

  in vec3 a_position;
  in vec4 a_state;
  in vec2 a_motion;

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
  }
`

const FRAGMENT_SHADER_SRC = `#version 300 es
  precision highp float;

  out vec4 fragColor;

  void main() {
    fragColor = vec4(1.0, 1.0, 1.0, 0.85);
  }
`

export class WebGLCustomLayer {
  map: maplibregl.Map
  gl: WebGL2RenderingContext | null = null
  vertex_shader: WebGLShader | null = null
  fragment_shader: WebGLShader | null = null
  program: WebGLProgram | null = null
  custom_layer_params: maplibregl.CustomLayerInterface
  a_pos: GLint | null = null
  a_state: GLint | null = null
  a_motion: GLint | null = null
  u_time: WebGLUniformLocation | null = null
  u_globe_matrix: WebGLUniformLocation | null = null
  buffer: WebGLBuffer | null = null
  instance_buffer: WebGLBuffer | null = null
  private instance_data = new Float32Array(0)
  private instances_dirty = false
  private aircraft_count = 0

  constructor(map: maplibregl.MapLibreMap) {
    this.map = map
    this.custom_layer_params = {
      id: 'custom_webgl_layer',
      type: 'custom',
      renderingMode: '3d',
      onAdd: (_map, gl) => {
        const create_shader = (type: GLenum, source: string) => {
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

        const vertex_shader = create_shader(gl.VERTEX_SHADER, VERTEX_SHADER_SRC)
        const fragment_shader = create_shader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC)

        if (vertex_shader === null || fragment_shader === null) {
          console.error("Couldn't create shaders")
          return
        }
        this.vertex_shader = vertex_shader
        this.fragment_shader = fragment_shader

        this.program = gl.createProgram()
        gl.attachShader(this.program, this.vertex_shader)
        gl.attachShader(this.program, this.fragment_shader)
        gl.linkProgram(this.program)

        this.a_pos = gl.getAttribLocation(this.program, 'a_position')
        this.a_state = gl.getAttribLocation(this.program, 'a_state')
        this.a_motion = gl.getAttribLocation(this.program, 'a_motion')
        this.u_time = gl.getUniformLocation(this.program, 'u_time')
        this.u_globe_matrix = gl.getUniformLocation(this.program, 'u_globe_matrix')

        const success = gl.getProgramParameter(this.program, gl.LINK_STATUS)
        if (!success) {
          console.error('Error linking program:', gl.getProgramInfoLog(this.program))
        }

        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, AIRCRAFT_OBJECT, gl.STATIC_DRAW);

        this.instance_buffer = gl.createBuffer();
      },
      render: (gl, args) => {
        if (!(gl instanceof WebGL2RenderingContext)) {
          return
        }
        if (
          this.program === null
            || this.u_time === null
            || this.u_globe_matrix === null
            || this.a_pos === null
            || this.a_pos < 0
            || this.a_state === null
            || this.a_state < 0
            || this.a_motion === null
            || this.a_motion < 0
        ) {
          return
        }
        gl.useProgram(this.program)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a_pos);
        gl.vertexAttribPointer(this.a_pos, 3, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.instance_buffer);
        if (this.instances_dirty) {
          gl.bufferData(gl.ARRAY_BUFFER, this.instance_data, gl.DYNAMIC_DRAW);
          this.instances_dirty = false
        }
        gl.enableVertexAttribArray(this.a_state);
        gl.vertexAttribPointer(this.a_state, 4, gl.FLOAT, false, INSTANCE_STRIDE, 0);
        gl.vertexAttribDivisor(this.a_state, 1);
        gl.enableVertexAttribArray(this.a_motion);
        gl.vertexAttribPointer(this.a_motion, 2, gl.FLOAT, false, INSTANCE_STRIDE, A_MOTION_OFFSET);
        gl.vertexAttribDivisor(this.a_motion, 1);

        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.uniformMatrix4fv(
          this.u_globe_matrix,
          false,
          args.defaultProjectionData.mainMatrix,
        )

        gl.uniform1f(this.u_time, performance.now() / 1000)

        gl.drawArraysInstanced(gl.TRIANGLES, 0, AIRCRAFT_VERTEX_COUNT, this.aircraft_count);

        gl.vertexAttribDivisor(this.a_state, 0);
        gl.vertexAttribDivisor(this.a_motion, 0);

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

  update_aircrafts(states: AircraftState[]) {
    if (this.instance_data.length < states.length * INSTANCE_FLOATS) {
      this.instance_data = new Float32Array(states.length * INSTANCE_FLOATS)
    }

    const t0 = performance.now() / 1000

    let count = 0
    for (const state of states) {
      if (!is_finite_number(state.lat) || !is_finite_number(state.lng)) {
        continue
      }
      const offset = count * INSTANCE_FLOATS
      this.instance_data[offset + 0] = deg_to_rad(state.lng)
      this.instance_data[offset + 1] = deg_to_rad(state.lat)
      this.instance_data[offset + 2] = deg_to_rad(state.dir ?? 0)
      this.instance_data[offset + 3] = state.alt ?? 0
      this.instance_data[offset + 4] = (aircraft_speed(state)?.kmh ?? 0) * KMH_TO_MS
      this.instance_data[offset + 5] = t0
      count++
    }

    this.aircraft_count = count
    this.instances_dirty = true
    this.map.triggerRepaint()
  }
}
