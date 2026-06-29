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
