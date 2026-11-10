/**
 * Response shapes for the frozen server contract in `docs/API.md`.
 * Keep these in sync with that document; the server is built against it in parallel.
 */

export interface ApiErrorBody {
  error: { reason: string; detail: string };
}

/** `[lat, lng]`, WGS84 — Leaflet order, as the contract specifies. */
export type Coordinate = [number, number];

export interface RouteSummary {
  name: string;
  routeId: string;
  headsigns: string[];
  stopCount: number;
  tripCount: number;
}

export interface RoutesResponse {
  routes: RouteSummary[];
  default: string[];
}

export interface Stop {
  seq: number;
  stopId: string;
  name: string;
  lat: number;
  lng: number;
}

export interface Trip {
  tripId: string;
  firstDeparture: string;
  lastArrival: string;
  serviceId: string;
  /** Not guaranteed: the server may name the service (weekday/weekend) when it can. */
  serviceLabel?: string;
}

export interface Direction {
  id: number;
  headsign: string;
  shape: Coordinate[];
  stops: Stop[];
  trips: Trip[];
}

export interface RouteDetail {
  name: string;
  routeId: string;
  directions: Direction[];
}

export interface LiveStop extends Stop {
  etaMin: number | null;
  nextAt: string | null;
}

export interface NextStop {
  seq: number;
  stopId: string;
  name: string;
  etaMin: number | null;
}

export interface LiveVehicle {
  busNo: string;
  /** Raw kiosk route code, e.g. `T5040`. */
  route: string;
  /** Raw kiosk direction, opaque (`"00" | "01" | "02"`). The live server can send null. */
  direction: string | null;
  lat: number;
  lng: number;
  speedKmh: number | null;
  gpsTime: string;
  ageS: number;
  live: boolean;
  status: 'on_trip' | 'off_trip' | 'contingency' | (string & {});
  directionId: number | null;
  progress: number | null;
  /**
   * Heading of travel in degrees clockwise from north, taken from the route
   * geometry. Null when the vehicle could not be matched to the shape.
   */
  bearing: number | null;
  nextStop: NextStop | null;
}

export interface LiveDirection {
  id: number;
  headsign: string;
  stops: LiveStop[];
}

export interface LiveResponse {
  route: string;
  updatedAt: string;
  stale: boolean;
  vehicles: LiveVehicle[];
  directions: LiveDirection[];
}

export interface Flight {
  price: number;
  stops: string;
  airline: string;
  depAirport: string;
  depTime: string;
  depDate: string;
  arrAirport: string;
  arrTime: string;
  arrDate?: string;
  duration: string;
  roundTrip: boolean;
}

export interface FlightPriceChange {
  previous_price: number;
  delta: number;
  previous_fetched_at: string;
}

export interface FlightResult {
  outbound: string;
  ret?: string | null;
  /** Exact Google Flights search that produced this date's fares (provenance link). */
  url: string;
  cards: number;
  parsed: number;
  cheapest: Flight;
  change: FlightPriceChange | null;
  flights: Flight[];
}

export interface FlightsResponse {
  ok: boolean;
  cached: boolean;
  fetchedAt: string;
  route: string;
  trip: string;
  dates: string[];
  sweptDays: number;
  cheapestOverall: Pick<Flight, 'price' | 'stops' | 'airline'> | null;
  cheapestDate: string;
  summary: string;
  results: FlightResult[];
  /** Present only for a cached fallback served after a failed refresh. */
  stale?: boolean;
}
