import { useAtom } from "jotai";
import { LoadingStateStatus, opensky_loading_states, opensky_state_atom } from "./state";
import { useEffect, useRef, useState } from "react";
import { OPEN_SKY_STATES_PAYLOAD_COLUMNS, opensky_url, type OpenSkyStateItem, type OpenSkyStatesPayload } from "./api";
import { AircraftLayer } from "./map";
import maplibregl from 'maplibre-gl'
import styles from './App.module.css'
import { missing_case } from "./utils";

type AppProps = {
  map: maplibregl.Map;
}
function App({map}: AppProps) {
  const [aircrafts_on_screen, set_aircrafts_on_screen] = useState(
    new Set<OpenSkyStateItem['icao24']>()
  )
  const [opensky_state, set_opensky_state] = useAtom(opensky_state_atom)
  const aircrafts_layer_ref = useRef<AircraftLayer | null>(null)
  const latest_opensky_states_ref = useRef<OpenSkyStateItem[]>([])

  useEffect(function get_items_on_screen() {
    const handle_map_change = () => {
      if (aircrafts_layer_ref.current === null) return
      set_aircrafts_on_screen(aircrafts_layer_ref.current.items_in_bbox())
    }
    map.on("moveend", handle_map_change)
    map.on("zoomend", handle_map_change)
    return () => {
      map.off("moveend", handle_map_change)
      map.off("zoomend", handle_map_change)
    }
  }, [])

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
  }, [])

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
        <div className={styles['flights-container']}>
          {
            displayed_aircrafts.map(state => (
              <article role="button" tabIndex={0} key={state.icao24}>
                  <div>{state.icao24}</div>
                  <div>{state.callsign}</div>
                  <div>{state.origin_country}</div>
              </article>
            ))
          }
        </div>
      )
    }
    default: {
      missing_case(opensky_state)
    }
  }
}

export default App
