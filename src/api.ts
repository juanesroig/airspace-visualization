const API_BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:5000').replace(/\/+$/, '')

export const opensky_url = (slug: string, ...params: string[]) => {
  const path = [slug, ...params].map(encodeURIComponent).join('/')
  return `${API_BASE}/api/opensky/${path}`
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

export const OPEN_SKY_STATES_PAYLOAD_COLUMNS = [
  "icao24",
  "callsign",
  "origin_country",
  "time_position",
  "last_contact",
  "longitude",
  "latitude",
  "baro_altitude",
  "on_ground",
  "velocity",
  "true_track",
  "vertical_rate",
  "sensors",
  "geo_altitude",
  "squawk",
  "spi",
  "position_source",
  "category",
] as const

export type OpenSkyStateItem = {
  icao24: string;
  callsign: string | null;
  origin_country: string;
  time_position: number | null;
  last_contact: number;
  longitude: number;
  latitude: number;
  baro_altitude: number | null;
  on_ground: boolean;
  velocity: number | null;
  true_track: number | null;
  vertical_rate: number | null;
  sensors: number[] | null;
  geo_altitude: number | null;
  squawk: string | null;
  spi: boolean;
  position_source: number;
  category: number;
}

type ValuesAsTuple<T, K extends readonly (keyof T)[]> = {
  [I in keyof K]: K[I] extends keyof T ? T[K[I]] : never;
};

export const decode_tuple = <T>(
  tuple: readonly unknown[],
  columns: readonly (keyof T)[],
): T => {
  return Object.fromEntries(
    columns.map((column, index) => [column, tuple[index]])
  ) as T
}

export type OpenSkyStatePayloadTuple = ValuesAsTuple<
  OpenSkyStateItem,
  typeof OPEN_SKY_STATES_PAYLOAD_COLUMNS
>
 
export type OpenSkyStatesPayload = {
  time: number;
  states: OpenSkyStatePayloadTuple[];
}

export const OPEN_SKY_TRACK_WAYPOINT_COLUMNS = [
  "time",
  "latitude",
  "longitude",
  "baro_altitude",
  "true_track",
  "on_ground",
] as const

export type OpenSkyTrackWaypointItem = {
  time: number;
  latitude: number | null;
  longitude: number | null;
  baro_altitude: number | null;
  true_track: number | null;
  on_ground: boolean;
}

export type OpenSkyTrackWaypoint = ValuesAsTuple<
  OpenSkyTrackWaypointItem,
  typeof OPEN_SKY_TRACK_WAYPOINT_COLUMNS
>

// Wire format: `path` arrives as positional waypoint tuples.
export type OpenSkyTracksPayload = {
  icao24: string;
  startTime: number;
  endTime: number;
  callsign: string | null;
  path: OpenSkyTrackWaypoint[];
}

// Decoded form: `path` waypoints turned into objects.
export type OpenSkyTrack = Omit<OpenSkyTracksPayload, 'path'> & {
  path: OpenSkyTrackWaypointItem[];
}

export const OpenSkyApi = {
  get_all_states: async () => {
    return await get_data<OpenSkyStatesPayload>(opensky_url('states'))
  },
  get_tracks: async (icao24: string) => {
    const result = await get_data<OpenSkyTracksPayload>(opensky_url('tracks', icao24))
    if (!result.success) return result
    const track: OpenSkyTrack = {
      ...result.payload,
      path: result.payload.path.map(waypoint =>
        decode_tuple<OpenSkyTrackWaypointItem>(waypoint, OPEN_SKY_TRACK_WAYPOINT_COLUMNS)
      ),
    }
    return Result.ok(track)
  }
}
