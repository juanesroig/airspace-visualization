import { useAtom } from "jotai";
import { opensky_loading_states, opensky_state_atom } from "./state";
import { useEffect, useRef } from "react";
import { OPEN_SKY_STATES_PAYLOAD_COLUMNS, opensky_url, type OpenSkyStateItem, type OpenSkyStatesPayload } from "./api";
import { AircraftLayer } from "./map";

type AppProps = {
  map: mapboxgl.Map;
}
function App({map}: AppProps) {
  const [opensky_state, set_opensky_state] = useAtom(opensky_state_atom)
  const aircrafts_layer_ref = useRef<AircraftLayer | null>(null)
  const latest_opensky_states_ref = useRef<OpenSkyStateItem[]>([])

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
        void aircrafts_layer_ref.current.update_aircrafts(parsed_data)
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

  console.log(opensky_state)

  return (
    <div></div>
  )
}

export default App
