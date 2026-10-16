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
export const is_finite_number = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function missing_case(missing: never) {
  throw new TypeError("Missing case on switch case", missing)
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
