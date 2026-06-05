export function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

export function unlerp(a: number, b:number, t: number) {
  return (t - a) / (b - a)
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
