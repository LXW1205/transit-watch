import { useEffect, useRef } from 'react';
import * as L from 'leaflet';
import { formatAge } from '../format';
import type { LiveVehicle } from '../types';

export interface MapStop {
  stopId: string;
  name: string;
  lat: number;
  lng: number;
  etaMin: number | null;
}

interface RouteMapProps {
  shape: [number, number][];
  stops: MapStop[];
  vehicles: LiveVehicle[];
  /** Selected GTFS direction; vehicles matched to it are drawn prominent. */
  directionId: number;
  /** Route + direction. Changing it refits the view; polls do not move the map. */
  fitKey: string;
}

const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const BUS_EMOJI = '🚌';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => HTML_ESCAPES[ch] ?? ch);
}

function themeColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * Leaflet map for one direction. The map, its layers and all markers are created
 * once; polling only moves markers and rewrites tooltips in place.
 */
export function RouteMap({ shape, stops, vehicles, directionId, fitKey }: RouteMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const shapeLayerRef = useRef<L.LayerGroup | null>(null);
  const stopLayersRef = useRef(new Map<string, L.CircleMarker>());
  const vehicleLayersRef = useRef(new Map<string, L.Marker>());
  const fittedRef = useRef<string>('');
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  // Map lifecycle: one map per mounted container. Leaflet's default marker icon
  // is never used (it 404s under bundlers); stops are circle markers and buses
  // get a divIcon carrying the emoji.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const map = L.map(host, { zoomControl: true, attributionControl: true });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    map.setView([3.1, 101.6], 12);
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      shapeLayerRef.current = null;
      stopLayersRef.current.clear();
      vehicleLayersRef.current.clear();
      fittedRef.current = '';
    };
  }, []);

  // Route line. Rebuilt only when the geometry changes (i.e. on direction switch).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    shapeLayerRef.current?.remove();
    shapeLayerRef.current = null;
    if (shape.length < 2) return;

    // A casing sits under the line so it stays readable where it crosses water,
    // parks or roads — cheaper and calmer than giving the line a second colour.
    shapeLayerRef.current = L.layerGroup([
      L.polyline(shape, {
        color: themeColor('--map-casing', '#ffffff'),
        weight: 9,
        opacity: 0.7,
        lineJoin: 'round',
        lineCap: 'round',
        interactive: false,
      }),
      L.polyline(shape, {
        color: themeColor('--map-route', '#0f766e'),
        weight: 4,
        opacity: 0.95,
        lineJoin: 'round',
        lineCap: 'round',
        interactive: false,
      }),
    ]).addTo(map);
  }, [shape]);

  // Fit the view once per route+direction, falling back to the stops when the
  // server publishes no shape.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (fittedRef.current === fitKey) return;
    fittedRef.current = fitKey;

    const points: L.LatLngExpression[] =
      shape.length >= 2
        ? shape
        : stopsRef.current.map(stop => [stop.lat, stop.lng] as L.LatLngExpression);

    if (points.length === 0) return;
    const bounds = L.latLngBounds(points);
    if (!bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }, [fitKey, shape]);

  // Stop markers, keyed by stopId and updated in place.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const routeColor = themeColor('--map-route', '#0f766e');
    const stopRing = themeColor('--map-stop-ring', '#8a93a0');
    const layers = stopLayersRef.current;
    const seen = new Set<string>();

    for (const stop of stops) {
      seen.add(stop.stopId);
      const served = stop.etaMin !== null;

      let marker = layers.get(stop.stopId);
      if (!marker) {
        marker = L.circleMarker([stop.lat, stop.lng], {
          radius: 4,
          weight: 1.4,
          color: stopRing,
          opacity: 0.95,
          fillColor: '#ffffff',
          fillOpacity: 1,
        }).addTo(map);
        layers.set(stop.stopId, marker);
      }

      marker.setLatLng([stop.lat, stop.lng]);
      marker.setStyle({
        radius: served ? 5 : 4,
        weight: served ? 2 : 1.4,
        color: served ? routeColor : stopRing,
        fillColor: '#ffffff',
      });

      const label = served
        ? `<strong>${escapeHtml(stop.name)}</strong><br>${stop.etaMin} min`
        : `<strong>${escapeHtml(stop.name)}</strong><br>no live ETA`;
      if (marker.getTooltip()) marker.setTooltipContent(label);
      else marker.bindTooltip(label, { direction: 'top', className: 'map-tip' });
    }

    for (const [stopId, marker] of layers) {
      if (seen.has(stopId)) continue;
      marker.remove();
      layers.delete(stopId);
    }
  }, [stops]);

  // Live vehicles, keyed by bus number and moved in place on every poll.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const layers = vehicleLayersRef.current;
    const seen = new Set<string>();

    for (const vehicle of vehicles) {
      seen.add(vehicle.busNo);
      const matches = vehicle.directionId === directionId;
      const unknown = vehicle.directionId === null;

      let marker = layers.get(vehicle.busNo);
      if (!marker) {
        marker = L.marker([vehicle.lat, vehicle.lng], {
          icon: L.divIcon({
            className: 'bus-marker-wrap',
            html:
              `<span class="bus-marker" role="img" aria-label="bus ${escapeHtml(vehicle.busNo)}">` +
              `${BUS_EMOJI}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          }),
          keyboard: false,
        }).addTo(map);
        layers.set(vehicle.busNo, marker);
      }

      marker.setLatLng([vehicle.lat, vehicle.lng]);
      // A bus matched to the shown direction reads solid; an unmatched or stale
      // one is ghosted rather than hidden, so a failed match never hides a bus.
      marker.setOpacity(!vehicle.live ? 0.35 : matches ? 1 : unknown ? 0.8 : 0.4);
      marker.setZIndexOffset(matches ? 1000 : unknown ? 500 : 0);

      const next = vehicle.nextStop
        ? `Next ${escapeHtml(vehicle.nextStop.name)}${
            vehicle.nextStop.etaMin !== null ? ` in ${vehicle.nextStop.etaMin} min` : ''
          }`
        : 'No upcoming stop yet';
      const label =
        `<strong>${escapeHtml(vehicle.busNo)}</strong><br>` +
        `${escapeHtml(vehicle.status.replace(/_/g, ' '))} · ` +
        `${vehicle.speedKmh !== null ? `${vehicle.speedKmh} km/h` : 'speed n/a'}<br>` +
        `${next}<br>` +
        `<span class="map-tip-muted">dir ${escapeHtml(vehicle.direction ?? 'unknown')} · ${formatAge(
          vehicle.ageS,
        )}${vehicle.live ? '' : ' · not live'}</span>`;

      if (marker.getTooltip()) marker.setTooltipContent(label);
      else marker.bindTooltip(label, { direction: 'top', className: 'map-tip' });
    }

    for (const [busNo, marker] of layers) {
      if (seen.has(busNo)) continue;
      marker.remove();
      layers.delete(busNo);
    }
  }, [vehicles, directionId]);

  return (
    <div className="map-shell">
      <div className="map-host" ref={hostRef} />
      <div className="map-caption" aria-hidden="true">
        <span className="legend-dot legend-dot--stop" /> stop
        <span className="legend-bus">{BUS_EMOJI}</span> live bus
        <span className="legend-bus legend-bus--dim">{BUS_EMOJI}</span> other direction
      </div>
      {shape.length < 2 ? (
        <p className="map-note">No route shape published for this direction.</p>
      ) : null}
    </div>
  );
}
