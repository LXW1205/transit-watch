import { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, type LatLng, type Region } from 'react-native-maps';

import { useTheme } from '../../theme';
import type { Coordinate, LiveVehicle } from '../../types';

export interface MapStop {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  etaMin: number | null;
}

interface RouteMapProps {
  shape: Coordinate[];
  stops: MapStop[];
  vehicles: LiveVehicle[];
  /** Selected GTFS direction; vehicles matched to it are drawn prominent. */
  directionId: number;
  /** Route + direction. Changing it refits the view; polls do not move the map. */
  fitKey: string;
}

const BUS_EMOJI = '🚌';
// How the glyph is drawn: Noto's bus faces west (left). Rotation is applied as
// bearing - this, so a bearing of 0 (north) makes the bus face up. The web app
// uses the same constant, so both clients orient the bus identically.
const BUS_EMOJI_FACING_DEG = 270;

const EDGE_PADDING = { top: 28, right: 28, bottom: 28, left: 28 };

/** Kuala Lumpur, used only when a direction publishes neither a shape nor stops. */
const FALLBACK_REGION: Region = {
  latitude: 3.1,
  longitude: 101.6,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

function regionFor(points: LatLng[]): Region {
  if (points.length === 0) return FALLBACK_REGION;

  let minLat = points[0].latitude;
  let maxLat = points[0].latitude;
  let minLng = points[0].longitude;
  let maxLng = points[0].longitude;
  for (const point of points) {
    if (point.latitude < minLat) minLat = point.latitude;
    if (point.latitude > maxLat) maxLat = point.latitude;
    if (point.longitude < minLng) minLng = point.longitude;
    if (point.longitude > maxLng) maxLng = point.longitude;
  }

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    // A little air around the bounding box; a degenerate box still gets a floor.
    latitudeDelta: Math.max((maxLat - minLat) * 1.4, 0.01),
    longitudeDelta: Math.max((maxLng - minLng) * 1.4, 0.01),
  };
}

function vehicleOpacity(vehicle: LiveVehicle, directionId: number): number {
  // A bus matched to the shown direction reads solid; an unmatched or stale one
  // is ghosted rather than hidden, so a failed match never hides a bus.
  if (!vehicle.live) return 0.35;
  if (vehicle.directionId === directionId) return 1;
  return vehicle.directionId === null ? 0.8 : 0.4;
}

/** One direction's geometry, its stops and the live buses on top of them. */
export function RouteMap({ shape, stops, vehicles, directionId, fitKey }: RouteMapProps) {
  const theme = useTheme();
  const mapRef = useRef<MapView | null>(null);
  const readyRef = useRef(false);
  const fittedRef = useRef('');

  // The contract's coordinates are `[lat, lng]` tuples; the map wants objects.
  // Memoised on their source so a live poll does not hand the native map a new
  // geometry every 15 s.
  const shapePoints = useMemo<LatLng[]>(
    () => shape.map(([latitude, longitude]) => ({ latitude, longitude })),
    [shape],
  );
  const stopPoints = useMemo<LatLng[]>(
    () => stops.map((stop) => ({ latitude: stop.lat, longitude: stop.lng })),
    [stops],
  );
  // Without a shape, the stops are the only geometry there is.
  const points = shape.length >= 2 ? shapePoints : stopPoints;

  // The map opens already framing the route, so it is never a blank square while
  // the first fit is pending.
  const initialRegion = useMemo(() => regionFor(points), [points]);

  const fit = useCallback(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || points.length === 0) return;
    map.fitToCoordinates(points, { edgePadding: EDGE_PADDING, animated: false });
  }, [points]);

  // Fit once per route+direction. A live poll must not yank the user's view back.
  useEffect(() => {
    if (!readyRef.current || fittedRef.current === fitKey) return;
    fittedRef.current = fitKey;
    fit();
  }, [fit, fitKey]);

  const handleMapReady = () => {
    readyRef.current = true;
    fittedRef.current = fitKey;
    // Android can report itself ready before the view has laid out, and a fit at
    // zero size is silently dropped; one frame later it has real bounds.
    requestAnimationFrame(fit);
  };

  return (
    <MapView
      ref={mapRef}
      style={styles.map}
      initialRegion={initialRegion}
      onMapReady={handleMapReady}
      toolbarEnabled={false}
      moveOnMarkerPress={false}
      pitchEnabled={false}
      showsCompass={false}
    >
      {shape.length >= 2 ? (
        <>
          {/* Casing under the line keeps it readable over water, parks and roads. */}
          <Polyline
            coordinates={points}
            strokeColor={theme.surface}
            strokeWidth={8}
            lineCap="round"
            lineJoin="round"
          />
          <Polyline
            coordinates={points}
            strokeColor={theme.route}
            strokeWidth={4}
            lineCap="round"
            lineJoin="round"
          />
        </>
      ) : null}

      {stops.map((stop) => {
        const served = stop.etaMin !== null;
        return (
          <Marker
            key={stop.stopId}
            coordinate={{ latitude: stop.lat, longitude: stop.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={served ? 2 : 1}
            // Stop dots never change once drawn, so freezing the snapshot is free.
            tracksViewChanges={false}
            accessibilityLabel={stop.name}
          >
            <View
              style={{
                width: served ? 12 : 9,
                height: served ? 12 : 9,
                borderRadius: 999,
                borderWidth: served ? 2.5 : 1.5,
                borderColor: served ? theme.route : theme.muted,
                backgroundColor: theme.surface,
              }}
            />
          </Marker>
        );
      })}

      {vehicles.map((vehicle) => {
        const rotation = vehicle.bearing === null ? 0 : vehicle.bearing - BUS_EMOJI_FACING_DEG;
        return (
          <Marker
            key={vehicle.busNo}
            coordinate={{ latitude: vehicle.lat, longitude: vehicle.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            zIndex={vehicle.directionId === directionId ? 3 : 1}
            opacity={vehicleOpacity(vehicle, directionId)}
            accessibilityLabel={`Bus ${vehicle.busNo}`}
          >
            {/* The wrapper is a fixed square so the glyph turns about its centre.
                Buses keep the default `tracksViewChanges` because the glyph itself
                changes with the bearing; a frozen snapshot would pin the first
                heading on screen for the life of the map. */}
            <View style={styles.busWrap}>
              <Text style={[styles.bus, { transform: [{ rotate: `${rotation}deg` }] }]}>
                {BUS_EMOJI}
              </Text>
            </View>
          </Marker>
        );
      })}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  busWrap: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  bus: { fontSize: 22 },
});
