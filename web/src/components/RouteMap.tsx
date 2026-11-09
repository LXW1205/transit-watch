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
  const shapeLayerRef = useRef<L.Polyline | null>(null);
  const stopLayersRef = useRef(new Map<string, L.CircleMarker>());
  const vehicleLayersRef = useRef(new Map<string, L.CircleMarker>());
  const fittedRef = useRef<string>('');
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  // Map lifecycle: one map per mounted container. Default marker icons are never
  // used (they 404 under bundlers); every marker below is a circle marker.
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

    shapeLayerRef.current = L.polyline(shape, {
      color: themeColor('--accent', '#1f5fbf'),
      weight: 5,
      opacity: 0.9,
      lineJoin: 'round',
      lineCap: 'round',
    }).addTo(map);
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

    const accent = themeColor('--accent', '#1f5fbf');
    const layers = stopLayersRef.current;
    const seen = new Set<string>();

    for (const stop of stops) {
      seen.add(stop.stopId);
      const served = stop.etaMin !== null;

      let marker = layers.get(stop.stopId);
      if (!marker) {
        marker = L.circleMarker([stop.lat, stop.lng], {
          radius: 4.5,
          weight: 1.5,
          color: themeColor('--muted', '#626773'),
          opacity: 0.9,
          fillColor: themeColor('--surface', '#ffffff'),
          fillOpacity: 1,
        }).addTo(map);
        layers.set(stop.stopId, marker);
      }

      marker.setLatLng([stop.lat, stop.lng]);
      marker.setStyle({
        radius: served ? 5.5 : 4.5,
        fillColor: served ? accent : themeColor('--surface', '#ffffff'),
        color: served ? accent : themeColor('--muted', '#626773'),
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

    const accent = themeColor('--accent', '#1f5fbf');
    const dim = themeColor('--muted', '#626773');
    const layers = vehicleLayersRef.current;
    const seen = new Set<string>();

    for (const vehicle of vehicles) {
      seen.add(vehicle.busNo);
      const matches = vehicle.directionId === directionId;
      const unknown = vehicle.directionId === null;
      const radius = matches ? 8 : unknown ? 7 : 6;

      let marker = layers.get(vehicle.busNo);
      if (!marker) {
        marker = L.circleMarker([vehicle.lat, vehicle.lng], {
          radius,
          weight: 2,
          color: themeColor('--surface', '#ffffff'),
          fillColor: accent,
          fillOpacity: 1,
        }).addTo(map);
        layers.set(vehicle.busNo, marker);
      }

      marker.setLatLng([vehicle.lat, vehicle.lng]);
      marker.setStyle({
        radius,
        fillColor: matches || unknown ? accent : dim,
        color: themeColor('--surface', '#ffffff'),
        fillOpacity: vehicle.live ? (matches ? 0.95 : 0.55) : 0.3,
      });
      if (matches) marker.bringToFront();

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
        <span className="legend-dot legend-dot--bus" /> live bus
        <span className="legend-dot legend-dot--bus-dim" /> other direction
      </div>
      {shape.length < 2 ? (
        <p className="map-note">No route shape published for this direction.</p>
      ) : null}
    </div>
  );
}
