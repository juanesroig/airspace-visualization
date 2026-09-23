import { is_finite_number } from './utils'

const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:5000').replace(/\/+$/, '')

export const api_url = (slug: string, ...params: string[]) => {
  const path = [slug, ...params].map(encodeURIComponent).join('/')
  return `${API_BASE}/api/${path}`
}

type RSuccess<T> = {
  success: true;
  payload: T;
}

type RError<T> = {
  success: false;
  error: T;
}

export const Result = {
  ok<T>(payload: T): RSuccess<T> {
    return {
      success: true,
      payload,
    }
  },
  fail<T>(error: T): RError<T> {
    return {
      success: false,
      error,
    }
  }
}

const get_data = async <T>(
  url: string
): Promise<RSuccess<T> | RError<string>> => {
  try {
    const response = await fetch(url)

    if (!response.ok) {
      return Result.fail(response.statusText)
    }

    const payload = await response.json()
    return Result.ok<T>(payload)
  } catch (error) {
    return Result.fail(
      error instanceof Error
        ? error.message
        : "Unknown error"
    )
  }
}

export type AircraftState = {
  hex: string;
  reg_number?: string | null;
  flag?: string | null;
  lat: number | null;
  lng: number | null;
  alt?: number | null;
  dir?: number | null;
  speed?: number | null;
  v_speed?: number | null;
  squawk?: string | null;
  flight_number?: string | null;
  flight_icao?: string | null;
  flight_iata?: string | null;
  dep_icao?: string | null;
  dep_iata?: string | null;
  arr_icao?: string | null;
  arr_iata?: string | null;
  airline_icao?: string | null;
  airline_iata?: string | null;
  aircraft_icao?: string | null;
  updated: number;
  status: string;
  // Which source the record came from, e.g. `adsb`.
  type: string;
}

export type StatesPayload = AircraftState[]

export const AIRBORNE_STATUS = 'en-route'

const ESTIMATED_SPEED_BY_ALTITUDE_KMH = [
  { below_alt: 1_000, kmh: 272 },
  { below_alt: 3_000, kmh: 451 },
  { below_alt: 6_000, kmh: 622 },
  { below_alt: 9_000, kmh: 764 },
  { below_alt: Infinity, kmh: 858 },
] as const

const ESTIMATED_SPEED_KMH = 813

export type AircraftSpeed = {
  kmh: number;
  estimated: boolean;
}

export const aircraft_speed = (state: AircraftState): AircraftSpeed | null => {
  if (is_finite_number(state.speed)) {
    return { kmh: state.speed, estimated: false }
  }
  if (state.status !== AIRBORNE_STATUS) {
    return null
  }
  const alt = state.alt
  if (!is_finite_number(alt)) {
    return { kmh: ESTIMATED_SPEED_KMH, estimated: true }
  }
  const band = ESTIMATED_SPEED_BY_ALTITUDE_KMH.find(({ below_alt }) => alt < below_alt)
  return { kmh: band?.kmh ?? ESTIMATED_SPEED_KMH, estimated: true }
}

export const Api = {
  get_all_states: async () => {
    return await get_data<StatesPayload>(api_url('states'))
  },
}
