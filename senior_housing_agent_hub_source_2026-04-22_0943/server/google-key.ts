export function googleMapsApiKey() {
  return process.env.API_KEY_2 ?? process.env.GOOGLE_MAPS_API_KEY ?? "";
}

export function googleMapsKeyLabel() {
  if (process.env.API_KEY_2) return "API_KEY_2";
  if (process.env.GOOGLE_MAPS_API_KEY) return "GOOGLE_MAPS_API_KEY";
  return "API_KEY_2 or GOOGLE_MAPS_API_KEY";
}
