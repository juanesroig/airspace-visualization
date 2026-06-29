export enum LoadingStateStatus {
  not_started = "NOT_STARTED",
  loading = "LOADING",
  error = "ERROR",
  success = "SUCCESS",
}

export type LoadingState<P, E> =
  | {status: LoadingStateStatus.not_started}
  | {status: LoadingStateStatus.loading}
  | {status: LoadingStateStatus.error; error: E;}
  | {status: LoadingStateStatus.success; payload: P;}

export const make_loading_states = <P, E>() => ({
  NOT_STARTED: () => ({status: LoadingStateStatus.not_started} as const),
  LOADING: () => ({status: LoadingStateStatus.loading} as const),
  ERROR: (error: E) => ({status: LoadingStateStatus.error, error} as const),
  SUCCESS: (payload: P) => ({
    status: LoadingStateStatus.success,
    payload,
  } as const),
})

export type InferLoadingState<T> = T extends ReturnType<typeof make_loading_states<infer P, infer E>>
  ? LoadingState<P, E>
  : never
export function missing_case(missing: never) {
  throw new TypeError("Missing case on switch case", missing)
}
export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function unlerp(a: number, b:number, t: number) {
  return (t - a) / (b - a)
}
export function remap(a: number, b: number, c: number, d: number, v: number) {
  return lerp(c, d, unlerp(a, b, v))
}

export function debounce<Args extends unknown[]>(
  fn: (...args: Args) => void,
  delay_ms: number,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined

  function debounced(...args: Args) {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), delay_ms)
  }

  debounced.cancel = () => clearTimeout(timeout)

  return debounced
}

export function deg_to_rad(deg: number) {
  return deg * Math.PI / 180
}

export function rad_to_deg(rad: number) {
  return rad * 180 / Math.PI
}

const EARTH_RADIUS = 6_371_000
export function project_position(
  lon: number,
  lat: number,
  heading_deg: number,
  speed: number, // m/s
  delta_seconds: number,
) {
  const d = speed * delta_seconds
  const delta_rad = d / EARTH_RADIUS
  const lat_rad = deg_to_rad(lat)
  const lon_rad = deg_to_rad(lon)
  const heading_rad = deg_to_rad(heading_deg)
  const destination_lat_rad = Math.asin(
    Math.sin(lat_rad) * Math.cos(delta_rad)
      + Math.cos(lat_rad) * Math.sin(delta_rad) * Math.cos(heading_rad)
  )
  const destination_lon_rad = lon_rad + Math.atan2(
    Math.sin(heading_rad) * Math.sin(delta_rad) * Math.cos(lat_rad),
    Math.cos(delta_rad) - Math.sin(lat_rad) * Math.sin(destination_lat_rad)
  )

  return [rad_to_deg(destination_lon_rad), rad_to_deg(destination_lat_rad)]
}
