import { useAtom } from "jotai";
import { LoadingStateStatus, opensky_loading_states, opensky_state_atom } from "./state";
import { useEffect, useRef, useState } from "react";
import { OPEN_SKY_STATES_PAYLOAD_COLUMNS, opensky_url, type OpenSkyStateItem, type OpenSkyStatesPayload } from "./api";
import { AircraftLayer } from "./map";
import maplibregl from 'maplibre-gl'
import styles from './App.module.css'
import { missing_case } from "./utils";

const M_TO_FT = 3.28084
const MS_TO_KT = 1.94384

const heading_label = (deg: number) => {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO']
  return dirs[Math.round(deg / 45) % dirs.length]
}

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

type AircraftCardProps = { aircraft: OpenSkyStateItem; }
function AircraftCard({ aircraft }: AircraftCardProps) {
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
          <div className={styles.compass} aria-label={`Track ${Math.round(aircraft.true_track)} degrees`}>
            <i
              className={styles.needle}
              style={{ transform: `rotate(${aircraft.true_track}deg)` }}
            />
            <span className={styles['compass-track']}>
              {Math.round(aircraft.true_track)}°
            </span>
            <span className={styles['compass-dir']}>
              {heading_label(aircraft.true_track)}
            </span>
          </div>
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

type AppProps = { map: maplibregl.Map; }
function App({map}: AppProps) {
  const [aircrafts_on_screen, set_aircrafts_on_screen] = useState(
    new Set<OpenSkyStateItem['icao24']>()
  )
  const [
    selected_aircraft,
    set_selected_aircraft,
  ] = useState<OpenSkyStateItem['icao24'] | null>(null)
  const [opensky_state, set_opensky_state] = useAtom(opensky_state_atom)
  const aircrafts_layer_ref = useRef<AircraftLayer | null>(null)
  const latest_opensky_states_ref = useRef<OpenSkyStateItem[]>([])

  useEffect(function map_events() {
    const handle_map_change = () => {
      if (aircrafts_layer_ref.current === null) return
      set_aircrafts_on_screen(aircrafts_layer_ref.current.items_in_bbox())
    }
    map.on("moveend", handle_map_change)
    map.on("zoomend", handle_map_change)

    const handle_click = (ev: maplibregl.MapMouseEvent) => {
      if (aircrafts_layer_ref.current === null) return
      console.log(aircrafts_on_screen)
      const clicked_aircraft = aircrafts_layer_ref.current.get_clicked_aircraft(
        ev,
        aircrafts_on_screen,
      )
      set_selected_aircraft(clicked_aircraft)
    }
    map.on('click', handle_click)
    return () => {
      map.off("moveend", handle_map_change)
      map.off("zoomend", handle_map_change)
      map.off('click', handle_click)
    }
  }, [aircrafts_on_screen, map])

  useEffect(function handle_event_source() {
    const event_source = new EventSource(opensky_url('states'))
    event_source.onopen = (() => {
      set_opensky_state(opensky_loading_states.LOADING())
    })
    event_source.addEventListener("success", (event: MessageEvent<string>) => {
      const states = JSON.parse(event.data).states as OpenSkyStatesPayload['states']
      const parsed_data = states.map(raw_state => (
        Object.fromEntries(raw_state.map((value, index) => [
          OPEN_SKY_STATES_PAYLOAD_COLUMNS[index],
          value
        ]))
      )) as OpenSkyStateItem[]
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
      const displayed_aircrafts = opensky_state.payload.filter(state => (
        aircrafts_on_screen.has(state.icao24)
      ))

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
          <div className={styles['flights-container']}>
            {displayed_aircrafts.length === 0 ? (
              <p className={styles.empty}>
                No aircraft in view. Pan or zoom the map to track traffic.
              </p>
            ) : (
              displayed_aircrafts.map(state => (
                <AircraftCard key={state.icao24} aircraft={state} />
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
