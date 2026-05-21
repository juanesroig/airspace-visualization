import { atom } from "jotai";
import type { OpenSkyStateItem } from "./api";

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

export const opensky_loading_states = make_loading_states<OpenSkyStateItem[], string>()
export type OpenSkyState = InferLoadingState<typeof opensky_loading_states>

export const opensky_state_atom = atom<OpenSkyState>(
  opensky_loading_states.NOT_STARTED()
)

export type AircraftMapState = {
  latitude: number;
  longitude: number;
  altitude: number;
  speed: number;
  rendered: boolean;
}
