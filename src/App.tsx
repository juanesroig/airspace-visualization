import { useCallback, useEffect, useRef, useState } from "react";
import {
  OPEN_SKY_STATES_PAYLOAD_COLUMNS,
  OpenSkyApi,
  decode_tuple,
  opensky_url,
  type OpenSkyStateItem,
  type OpenSkyStatesPayload,
} from "./api";
import { AircraftLayer, AIRCRAFT_COLOR, AIRCRAFT_HOVERED, AIRCRAFT_SELECTED } from "./map";
import maplibregl from 'maplibre-gl'
import styles from './App.module.css'
import {
    deg_to_rad,
  LoadingStateStatus,
  make_loading_states,
  missing_case,
  type InferLoadingState,
} from "./utils";

const M_TO_FT = 3.28084
const MS_TO_KT = 1.94384
const CARD_BATCH_SIZE = 20

const integer = (n: number) => Math.round(n).toLocaleString('en-US')

const category_label = (category: number): string | null => {
  switch (category) {
    case 2: return 'Light'
    case 3: return 'Small'
    case 4: return 'Large'
    case 5: return 'Heavy / high vortex'
    case 6: return 'Heavy'
    case 7: return 'High performance'
    case 16:
    case 17:
    case 18: return 'Ground vehicle'
    default: return null
  }
}

type CompassProps = {
  head: number;
}

const COMPASS = {
  center: 50,
  ring_radius: 47,
  tick_outer: 46,
  tick_inner: 41,
  tick_inner_cardinal: 38,
  cardinal_radius: 31,
  needle_tip: 37,
  needle_base: 17,
  needle_half_width: 4.5,
  value_baseline: 52,
} as const

const COMPASS_TICKS = Array.from({ length: 12 }, (_, i) => i * 30)
const COMPASS_CARDINALS = [
  { label: 'N', angle: 0 },
  { label: 'E', angle: 90 },
  { label: 'S', angle: 180 },
  { label: 'W', angle: 270 },
]

const compass_point = (angle: number, radius: number) => {
  const rad = deg_to_rad(angle)
  return {
    x: COMPASS.center + radius * Math.sin(rad),
    y: COMPASS.center - radius * Math.cos(rad),
  }
}

const COMPASS_NEEDLE_POINTS = [
  `${COMPASS.center},${COMPASS.center - COMPASS.needle_tip}`,
  `${COMPASS.center - COMPASS.needle_half_width},${COMPASS.center - COMPASS.needle_base}`,
  `${COMPASS.center + COMPASS.needle_half_width},${COMPASS.center - COMPASS.needle_base}`,
].join(' ')

function Compass({ head }: CompassProps) {
  return (
    <svg
      className={styles.compass}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Track ${Math.round(head)} degrees`}
    >
      <circle
        className={styles['compass-ring']}
        cx={COMPASS.center}
        cy={COMPASS.center}
        r={COMPASS.ring_radius}
      />

      {COMPASS_TICKS.map(angle => {
        const is_cardinal = angle % 90 === 0
        const inner = compass_point(
          angle,
          is_cardinal ? COMPASS.tick_inner_cardinal : COMPASS.tick_inner,
        )
        const outer = compass_point(angle, COMPASS.tick_outer)
        return (
          <line
            key={angle}
            className={is_cardinal ? styles['compass-tick-major'] : styles['compass-tick']}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
          />
        )
      })}

      {COMPASS_CARDINALS.map(({ label, angle }) => {
        const p = compass_point(angle, COMPASS.cardinal_radius)
        return (
          <text
            key={label}
            className={label === 'N' ? styles['compass-north'] : styles['compass-cardinal']}
            x={p.x}
            y={p.y}
            textAnchor="middle"
            dominantBaseline="central"
          >
            {label}
          </text>
        )
      })}
      <polygon
        className={styles['compass-needle']}
        points={COMPASS_NEEDLE_POINTS}
        transform={`rotate(${head} ${COMPASS.center} ${COMPASS.center})`}
      />
      <text
        className={styles['compass-value']}
        x={COMPASS.center}
        y={COMPASS.value_baseline}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {Math.round(head)}°
      </text>
    </svg>
  )
}

type MetricProps = { label: string; value: string; unit: string; tone?: string; }
function Metric({ label, value, unit, tone }: MetricProps) {
  return (
    <div className={styles.metric}>
      <span className={styles['metric-label']}>{label}</span>
      <span className={styles['metric-value']} data-tone={tone}>
        {value}
        <span className={styles['metric-unit']}>{unit}</span>
      </span>
    </div>
  )
}

type AircraftCardProps = {
  aircraft: OpenSkyStateItem;
  selected: boolean;
  hovered: boolean;
  on_hover: (icao24: OpenSkyStateItem['icao24'] | null) => void;
  on_select: (icao24: OpenSkyStateItem['icao24']) => void;
}
function AircraftCard({ aircraft, selected, hovered, on_hover, on_select }: AircraftCardProps) {
  const altitude = aircraft.geo_altitude ?? aircraft.baro_altitude
  const category = category_label(aircraft.category)

  const vs = aircraft.vertical_rate
  const vs_tone = vs === null || Math.abs(vs) < 0.5
    ? 'level'
    : vs > 0 ? 'climb' : 'descent'
  const vs_arrow = vs_tone === 'climb' ? '▲' : vs_tone === 'descent' ? '▼' : '—'

  return (
    <article
      className={styles['aircraft-card']}
      data-onground={aircraft.on_ground}
      data-selected={selected}
      data-hovered={hovered}
      onMouseEnter={() => on_hover(aircraft.icao24)}
      onMouseLeave={() => on_hover(null)}
      onClick={() => on_select(aircraft.icao24)}
    >
      <header className={styles['card-head']}>
        <div className={styles['card-id']}>
          <span className={styles.status} data-onground={aircraft.on_ground}>
            <span className={styles['status-dot']} />
            {aircraft.on_ground ? 'On ground' : 'Airborne'}
          </span>
          <h2 className={styles.callsign}>
            {aircraft.callsign?.trim() || 'Unknown'}
          </h2>
          <p className={styles['card-sub']}>
            <span className={styles.icao}>{aircraft.icao24.toUpperCase()}</span>
            <span className={styles.dot}>·</span>
            {aircraft.origin_country}
          </p>
        </div>

        {aircraft.true_track !== null && (
          <Compass head={aircraft.true_track} />
        )}
      </header>

      <div className={styles.telemetry}>
        <Metric
          label="ALT"
          value={altitude !== null ? integer(altitude * M_TO_FT) : '—'}
          unit="ft"
        />
        <Metric
          label="GS"
          value={aircraft.velocity !== null ? integer(aircraft.velocity * MS_TO_KT) : '—'}
          unit="kt"
        />
        <Metric
          label="V/S"
          value={vs !== null ? `${vs_arrow} ${integer(Math.abs(vs * M_TO_FT * 60))}` : '—'}
          unit="fpm"
          tone={vs_tone}
        />
      </div>

      <footer className={styles.tags}>
        {aircraft.squawk && (
          <span className={styles.tag}>
            <span className={styles['tag-key']}>SQ</span>{aircraft.squawk}
          </span>
        )}
        {category && <span className={styles.tag}>{category}</span>}
      </footer>
    </article>
  )
}

const opensky_loading_states = make_loading_states<OpenSkyStateItem[], string>()
type OpenSkyState = InferLoadingState<typeof opensky_loading_states>

type AppProps = { map: maplibregl.Map; }
function App({map}: AppProps) {
  const [aircrafts_on_screen, set_aircrafts_on_screen] = useState(
    new Set<OpenSkyStateItem['icao24']>()
  )
  const [
    hovered_aircraft,
    set_hovered_aircraft,
  ] = useState<OpenSkyStateItem['icao24'] | null>(null)
  const [
    selected_aircraft,
    set_selected_aircraft,
  ] = useState<OpenSkyStateItem['icao24'] | null>(null)
  const [max_displayed_cards, set_max_displayed_cards] = useState(CARD_BATCH_SIZE)
  const [opensky_state, set_opensky_state] = useState<OpenSkyState>(
    opensky_loading_states.NOT_STARTED()
  )
  const aircrafts_layer_ref = useRef<AircraftLayer | null>(null)
  const latest_opensky_states_ref = useRef<OpenSkyStateItem[]>([])
  const flights_container_ref = useRef<HTMLDivElement | null>(null)

  const update_hovered_aircraft = useCallback(
    (hovered: OpenSkyStateItem['icao24'] | null) => {
      const layer = aircrafts_layer_ref.current
      set_hovered_aircraft(previous_hovered => {
        if (previous_hovered === hovered || layer === null) {
          return hovered
        }
        if (previous_hovered !== null && previous_hovered !== selected_aircraft) {
          layer.change_aircraft_color(previous_hovered, AIRCRAFT_COLOR)
        }
        if (hovered !== null && hovered !== selected_aircraft) {
          layer.change_aircraft_color(hovered, AIRCRAFT_HOVERED)
        }
        return hovered
      })
      map.getCanvas().style.cursor = hovered !== null ? "pointer" : ""
    },
    [map, selected_aircraft]
  )

  const update_selected_aircraft = useCallback(
    (selected: OpenSkyStateItem['icao24'] | null) => {
      const layer = aircrafts_layer_ref.current
      if (layer === null) return
      set_selected_aircraft(previous_selected => {
        if (previous_selected !== null) {
          layer.change_aircraft_color(
            previous_selected,
            previous_selected === hovered_aircraft ? AIRCRAFT_HOVERED : AIRCRAFT_COLOR,
          )
        }
        if (selected !== null) {
          layer.change_aircraft_color(selected, AIRCRAFT_SELECTED)
          const position = layer.aircraft_position(selected)
          if (position !== null) {
            map.flyTo({ center: position, zoom: 9 })
          }
          flights_container_ref.current?.scrollTo({ top: 0, behavior: 'smooth' })
        }
        return selected
      })
      if (selected !== null) {
        void OpenSkyApi.get_tracks(selected).then(result => {
          if (result.success) {
            aircrafts_layer_ref.current?.update_tracks([result.payload])
          } else {
            console.error('failed to fetch tracks', selected, result.error)
          }
        })
      } else {
        layer.clear_tracks()
      }
    },
    [hovered_aircraft, map]
  )

  const handle_scroll = (ev: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, clientHeight, scrollHeight } = ev.currentTarget
    if (scrollTop + clientHeight >= scrollHeight - 1) {
      set_max_displayed_cards(previous => previous + CARD_BATCH_SIZE)
    }
  }

  useEffect(function map_change_events() {
    const handle_map_change = () => {
      if (aircrafts_layer_ref.current === null) return
      set_aircrafts_on_screen(aircrafts_layer_ref.current.items_in_bbox())
    }
    map.on("moveend", handle_map_change)
    map.on("zoomend", handle_map_change)
    return () => {
      map.off('moveend', handle_map_change)
      map.off('zoomend', handle_map_change)
    }
  }, [map])

  useEffect(function click_events() {
    const handle_click = (ev: maplibregl.MapMouseEvent) => {
      if (aircrafts_layer_ref.current === null) return
      const clicked_aircraft = aircrafts_layer_ref.current.detect_mouse_on_aircraft(
        ev,
        aircrafts_on_screen,
      )
      update_selected_aircraft(clicked_aircraft)
    }
    map.on('click', handle_click)
    return () => {
      map.off('click', handle_click)
    }
  }, [aircrafts_on_screen, map, update_selected_aircraft])

  useEffect(function hover_events() {
    const handle_mouseover = (ev: maplibregl.MapMouseEvent) => {
      if (aircrafts_layer_ref.current === null) return
      const hovered_aircraft = aircrafts_layer_ref.current.detect_mouse_on_aircraft(
        ev,
        aircrafts_on_screen,
      )
      update_hovered_aircraft(hovered_aircraft)
    }
    map.on('mousemove', handle_mouseover)
    return () => {
      map.off('mousemove', handle_mouseover)
    }
  }, [aircrafts_on_screen, map, update_hovered_aircraft])

  useEffect(function handle_event_source() {
    const event_source = new EventSource(opensky_url('states'))
    event_source.onopen = (() => {
      set_opensky_state(opensky_loading_states.LOADING())
    })
    event_source.addEventListener("success", (event: MessageEvent<string>) => {
      const states = JSON.parse(event.data).states as OpenSkyStatesPayload['states']
      const parsed_data = states.map(raw_state =>
        decode_tuple<OpenSkyStateItem>(raw_state, OPEN_SKY_STATES_PAYLOAD_COLUMNS)
      )
      latest_opensky_states_ref.current = parsed_data
      set_opensky_state(opensky_loading_states.SUCCESS(parsed_data))
      if (aircrafts_layer_ref.current !== null) {
        aircrafts_layer_ref.current.update_aircrafts(parsed_data)
        set_aircrafts_on_screen(aircrafts_layer_ref.current.items_in_bbox())
      }
    })
    event_source.addEventListener("error", (event) => {
      console.error("sse error", event)
    })
    return () => {
      event_source.close()
    }
  }, [set_opensky_state])

  useEffect(function load_aircrafts_layer() {
    const load_layer = () => {
      aircrafts_layer_ref.current = new AircraftLayer(map)
      aircrafts_layer_ref.current.init()
      if (latest_opensky_states_ref.current.length > 0) {
        void aircrafts_layer_ref.current.update_aircrafts(latest_opensky_states_ref.current)
      }
    }

    if (map.loaded()) {
      load_layer()
      return
    }

    map.on('load', load_layer)
    return () => {
      map.off('load', load_layer)
    }
  }, [map])

  switch (opensky_state.status) {
    case LoadingStateStatus.not_started: {
      return
    }
    case LoadingStateStatus.loading: {
      return (
        <div>
          Loading...
          {/* TODO: */}
        </div>
      )
    }
    case LoadingStateStatus.error: {
      return (
        <div>
          Error page
          {/* TODO: */}
        </div>
      )
    }
    case LoadingStateStatus.success:  {
      const displayed_aircrafts = opensky_state.payload
        .filter(state => aircrafts_on_screen.has(state.icao24))
        .sort((a, b) => {
          if (a.icao24 === selected_aircraft) return -1
          if (b.icao24 === selected_aircraft) return 1
          return 0
        })
      const lazy_loaded_aircrafts = displayed_aircrafts.toSpliced(max_displayed_cards)

      return (
        <section className={styles.panel}>
          <header className={styles['panel-head']}>
            <span className={styles['panel-pulse']} />
            <h1 className={styles['panel-title']}>Live traffic</h1>
            <span className={styles['panel-count']}>
              {displayed_aircrafts.length}
              <span className={styles['panel-count-label']}>in view</span>
            </span>
          </header>
          <div
            ref={flights_container_ref}
            className={styles['flights-container']}
            onScroll={handle_scroll}
          >
            {displayed_aircrafts.length === 0 ? (
              <p className={styles.empty}>
                No aircraft in view. Pan or zoom the map to track traffic.
              </p>
            ) : (
              lazy_loaded_aircrafts.map(state => (
                <AircraftCard
                  key={state.icao24}
                  aircraft={state}
                  selected={selected_aircraft === state.icao24}
                  hovered={hovered_aircraft === state.icao24}
                  on_hover={update_hovered_aircraft}
                  on_select={update_selected_aircraft}
                />
              ))
            )}
          </div>
        </section>
      )
    }
    default: {
      missing_case(opensky_state)
    }
  }
}

export default App
