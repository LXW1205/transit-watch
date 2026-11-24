/**
 * Expo config.
 *
 * app.json holds the static settings; this layer exists only to inject the Google
 * Maps key when one is available. react-native-maps needs **no key in Expo Go**
 * (Expo ships one), but a standalone/EAS build on Android renders a grey grid
 * without it.
 *
 * Set GOOGLE_MAPS_API_KEY in the environment (or an EAS secret) before building:
 *   GOOGLE_MAPS_API_KEY=... npx eas build --platform android
 */
const mapsKey = process.env.GOOGLE_MAPS_API_KEY;

module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...(config.plugins ?? []),
    ...(mapsKey
      ? [['react-native-maps', { androidGoogleMapsApiKey: mapsKey, iosGoogleMapsApiKey: mapsKey }]]
      : []),
  ],
});
