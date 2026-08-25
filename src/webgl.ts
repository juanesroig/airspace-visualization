import maplibregl from 'maplibre-gl'
import { deg_to_rad } from './utils'
import type { OpenSkyStateItem } from './api'

const EARTH_RADIUS_METERS = 6371008.8

const MARKER_SIZE_METERS = 5000
const MARKER_VERTICES = new Float32Array([
  -(MARKER_SIZE_METERS/2) / 2, 0,
  (MARKER_SIZE_METERS/2) / 2, 0,
  0, MARKER_SIZE_METERS,
])

const VERTEX_SHADER_SRC = `#version 300 es

  in vec2 a_position;
  uniform mat4 u_model_matrix;
  uniform mat4 u_globe_matrix;

  void main() {
    vec4 globe_position = u_model_matrix * vec4(a_position, 0.0, 1.0);
    gl_Position = u_globe_matrix * globe_position;
  }
`

const FRAGMENT_SHADER_SRC = `#version 300 es
  precision highp float;

  out vec4 fragColor;

  void main() {
    fragColor = vec4(1.0, 1.0, 1.0, 0.75);
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
  u_model_matrix: WebGLUniformLocation | null = null
  u_globe_matrix: WebGLUniformLocation | null = null
  buffer: WebGLBuffer | null = null
  matrices = new Float32Array(0)
  aircraft_count = 0
  aircrafts = new Set<string>()

  private scratch_matrix = new Float64Array(16)
  private scratch_operand = new Float64Array(16)

  private m4 = {
    translation(out: Float64Array, tx: number, ty: number, tz: number) {
      out[0]  = 1;  out[1]  = 0;  out[2]  = 0;  out[3]  = 0;
      out[4]  = 0;  out[5]  = 1;  out[6]  = 0;  out[7]  = 0;
      out[8]  = 0;  out[9]  = 0;  out[10] = 1;  out[11] = 0;
      out[12] = tx; out[13] = ty; out[14] = tz; out[15] = 1;
    },
    x_rotation(out: Float64Array, angle_rad: number) {
      const cos = Math.cos(angle_rad);
      const sin = Math.sin(angle_rad);
      out[0]  = 1; out[1]  = 0;    out[2]  = 0;   out[3]  = 0;
      out[4]  = 0; out[5]  = cos;  out[6]  = sin; out[7]  = 0;
      out[8]  = 0; out[9]  = -sin; out[10] = cos; out[11] = 0;
      out[12] = 0; out[13] = 0;    out[14] = 0;   out[15] = 1;
    },
    y_rotation(out: Float64Array, angle_rad: number) {
      const cos = Math.cos(angle_rad);
      const sin = Math.sin(angle_rad);
      out[0]  = cos; out[1]  = 0; out[2]  = -sin; out[3]  = 0;
      out[4]  = 0;   out[5]  = 1; out[6]  = 0;    out[7]  = 0;
      out[8]  = sin; out[9]  = 0; out[10] = cos;  out[11] = 0;
      out[12] = 0;   out[13] = 0; out[14] = 0;    out[15] = 1;
    },
    z_rotation(out: Float64Array, angle_rad: number) {
      const cos = Math.cos(angle_rad);
      const sin = Math.sin(angle_rad);
      out[0]  = cos;  out[1]  = sin; out[2]  = 0; out[3]  = 0;
      out[4]  = -sin; out[5]  = cos; out[6]  = 0; out[7]  = 0;
      out[8]  = 0;    out[9]  = 0;   out[10] = 1; out[11] = 0;
      out[12] = 0;    out[13] = 0;   out[14] = 0; out[15] = 1;
    },
    scaling(out: Float64Array, sx: number, sy: number, sz: number) {
      out[0]  = sx; out[1]  = 0;  out[2]  = 0;  out[3]  = 0;
      out[4]  = 0;  out[5]  = sy; out[6]  = 0;  out[7]  = 0;
      out[8]  = 0;  out[9]  = 0;  out[10] = sz; out[11] = 0;
      out[12] = 0;  out[13] = 0;  out[14] = 0;  out[15] = 1;
    },
    multiply(out: Float64Array, a: Float64Array, b: Float64Array) {
      const b00 = b[0 * 4 + 0];
      const b01 = b[0 * 4 + 1];
      const b02 = b[0 * 4 + 2];
      const b03 = b[0 * 4 + 3];
      const b10 = b[1 * 4 + 0];
      const b11 = b[1 * 4 + 1];
      const b12 = b[1 * 4 + 2];
      const b13 = b[1 * 4 + 3];
      const b20 = b[2 * 4 + 0];
      const b21 = b[2 * 4 + 1];
      const b22 = b[2 * 4 + 2];
      const b23 = b[2 * 4 + 3];
      const b30 = b[3 * 4 + 0];
      const b31 = b[3 * 4 + 1];
      const b32 = b[3 * 4 + 2];
      const b33 = b[3 * 4 + 3];
      const a00 = a[0 * 4 + 0];
      const a01 = a[0 * 4 + 1];
      const a02 = a[0 * 4 + 2];
      const a03 = a[0 * 4 + 3];
      const a10 = a[1 * 4 + 0];
      const a11 = a[1 * 4 + 1];
      const a12 = a[1 * 4 + 2];
      const a13 = a[1 * 4 + 3];
      const a20 = a[2 * 4 + 0];
      const a21 = a[2 * 4 + 1];
      const a22 = a[2 * 4 + 2];
      const a23 = a[2 * 4 + 3];
      const a30 = a[3 * 4 + 0];
      const a31 = a[3 * 4 + 1];
      const a32 = a[3 * 4 + 2];
      const a33 = a[3 * 4 + 3];
      out[0]  = b00 * a00 + b01 * a10 + b02 * a20 + b03 * a30;
      out[1]  = b00 * a01 + b01 * a11 + b02 * a21 + b03 * a31;
      out[2]  = b00 * a02 + b01 * a12 + b02 * a22 + b03 * a32;
      out[3]  = b00 * a03 + b01 * a13 + b02 * a23 + b03 * a33;
      out[4]  = b10 * a00 + b11 * a10 + b12 * a20 + b13 * a30;
      out[5]  = b10 * a01 + b11 * a11 + b12 * a21 + b13 * a31;
      out[6]  = b10 * a02 + b11 * a12 + b12 * a22 + b13 * a32;
      out[7]  = b10 * a03 + b11 * a13 + b12 * a23 + b13 * a33;
      out[8]  = b20 * a00 + b21 * a10 + b22 * a20 + b23 * a30;
      out[9]  = b20 * a01 + b21 * a11 + b22 * a21 + b23 * a31;
      out[10] = b20 * a02 + b21 * a12 + b22 * a22 + b23 * a32;
      out[11] = b20 * a03 + b21 * a13 + b22 * a23 + b23 * a33;
      out[12] = b30 * a00 + b31 * a10 + b32 * a20 + b33 * a30;
      out[13] = b30 * a01 + b31 * a11 + b32 * a21 + b33 * a31;
      out[14] = b30 * a02 + b31 * a12 + b32 * a22 + b33 * a32;
      out[15] = b30 * a03 + b31 * a13 + b32 * a23 + b33 * a33;
    },
  }

  private write_globe_projection_matrix(
    index: number,
    lon: number,
    lat: number,
    alt_m: number,
    true_track_deg: number,
  ) {
    const scale = 1 / EARTH_RADIUS_METERS
    const result = this.scratch_matrix
    const operand = this.scratch_operand

    this.m4.y_rotation(result, deg_to_rad(lon))
    this.m4.x_rotation(operand, deg_to_rad(-lat))
    this.m4.multiply(result, result, operand)
    this.m4.z_rotation(operand, deg_to_rad(-true_track_deg))
    this.m4.multiply(result, result, operand)
    this.m4.translation(operand, 0, 0, 1 + alt_m / EARTH_RADIUS_METERS)
    this.m4.multiply(result, result, operand)
    this.m4.scaling(operand, scale, scale, scale)
    this.m4.multiply(result, result, operand)

    this.matrices.set(result, index * 16)
  }

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
        this.u_model_matrix = gl.getUniformLocation(this.program, 'u_model_matrix')
        this.u_globe_matrix = gl.getUniformLocation(this.program, 'u_globe_matrix')

        const success = gl.getProgramParameter(this.program, gl.LINK_STATUS)
        if (!success) {
          console.error('Error linking program:', gl.getProgramInfoLog(this.program))
        }

        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, MARKER_VERTICES, gl.STATIC_DRAW);
      },
      render: (gl, args) => {
        if (!(gl instanceof WebGL2RenderingContext)) {
          return
        }
        if (
          this.program === null
            || this.u_model_matrix === null
            || this.u_globe_matrix === null
            || this.a_pos === null
            || this.a_pos < 0
        ) {
          return
        }
        gl.useProgram(this.program)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.a_pos);
        gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, 0, 0);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.uniformMatrix4fv(
          this.u_globe_matrix,
          false,
          args.defaultProjectionData.mainMatrix,
        )

        for (let i = 0; i < this.aircraft_count; i++) {
          gl.uniformMatrix4fv(this.u_model_matrix, false, this.matrices, i * 16, 16)
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 3);
        }

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

  update_aircrafts(opensky_states: OpenSkyStateItem[]) {
    const count = opensky_states.length
    if (this.matrices.length < count * 16) {
      this.matrices = new Float32Array(count * 16)
    }
    this.aircraft_count = count

    for (let i = 0; i < count; i++) {
      const { longitude, latitude, geo_altitude, true_track } = opensky_states[i]
      this.write_globe_projection_matrix(
        i,
        longitude,
        latitude,
        geo_altitude ?? 0,
        true_track ?? 0,
      )
    }

    this.map.triggerRepaint()
  }
}
