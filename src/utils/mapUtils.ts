import axios from 'axios';
import { logger } from './logger';

const GOOGLE_MAPS_API_KEY =
  process.env.GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_API_KEY ||
  process.env.GMAPS_API_KEY ||
  process.env.GOOGLE_DIRECTIONS_API_KEY;

const toRad = (degrees: number) => degrees * (Math.PI / 180);

export const calculateDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number => {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const decodePolyline = (encoded: string): Array<{ latitude: number; longitude: number }> => {
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;
  const coordinates: Array<{ latitude: number; longitude: number }> = [];

  while (index < len) {
    let b: number;
    let shift = 0;
    let result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    shift = 0;
    result = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coordinates.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }

  return coordinates;
};

const encodePolyline = (points: Array<{ latitude: number; longitude: number }>): string => {
  let lastLat = 0;
  let lastLng = 0;
  let result = '';

  const encodeValue = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      result += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    result += String.fromCharCode(v + 63);
  };

  for (const p of points) {
    const lat = Math.round(p.latitude * 1e5);
    const lng = Math.round(p.longitude * 1e5);
    encodeValue(lat - lastLat);
    encodeValue(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }

  return result;
};

const requireGoogleKey = () => {
  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error('GOOGLE_MAPS_API_KEY is not configured');
  }
};

export const getRoute = async (
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number }
): Promise<{
  distance: number;
  duration: number;
  durationInTraffic: number;
  polyline: string;
  decodedPolyline: Array<{ latitude: number; longitude: number }>;
  routeSource: 'google' | 'fallback';
  fallbackReason: string | null;
}> => {
  type RouteResult = {
    distance: number;
    duration: number;
    durationInTraffic: number;
    polyline: string;
    decodedPolyline: Array<{ latitude: number; longitude: number }>;
    routeSource: 'google' | 'fallback';
    fallbackReason: string | null;
  };

  const straightLineKm = calculateDistance(origin.latitude, origin.longitude, destination.latitude, destination.longitude);
  const straightLineMeters = Math.max(1, Math.round(straightLineKm * 1000));
  const fallback = (reason?: string): RouteResult => {
    if (reason) {
      logger.warn('[getRoute] Using fallback route', {
        reason,
        origin: `${origin.latitude},${origin.longitude}`,
        destination: `${destination.latitude},${destination.longitude}`,
      });
    }
    const durationSeconds = Math.max(60, Math.round((straightLineKm / 30) * 3600));
    const polyline = encodePolyline([origin, destination]);
    return {
      distance: straightLineMeters,
      duration: durationSeconds,
      durationInTraffic: durationSeconds,
      polyline,
      decodedPolyline: [origin, destination],
      routeSource: 'fallback',
      fallbackReason: reason || 'Unknown',
    };
  };

  if (!GOOGLE_MAPS_API_KEY) {
    return fallback('No Google Maps API key');
  }

  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin: `${origin.latitude},${origin.longitude}`,
        destination: `${destination.latitude},${destination.longitude}`,
        mode: 'driving',
        alternatives: true,
        departure_time: 'now',
        traffic_model: 'best_guess',
        key: GOOGLE_MAPS_API_KEY,
      },
      timeout: 15000,
    });

    const data = response.data;
    if (!data || data.status !== 'OK' || !data.routes?.length) {
      return fallback(`Google API status: ${data?.status || 'no data'}`);
    }

    const candidates = (data.routes as any[])
      .map((r) => {
        const leg = r?.legs?.[0];
        const distance = leg?.distance?.value;
        const duration = leg?.duration?.value;
        const durationInTraffic = leg?.duration_in_traffic?.value || duration;
        const poly = r?.overview_polyline?.points;

        if (
          typeof distance !== 'number' ||
          typeof duration !== 'number' ||
          typeof durationInTraffic !== 'number' ||
          typeof poly !== 'string' ||
          !poly
        ) {
          return null;
        }

        return { distance, duration, durationInTraffic, poly };
      })
      .filter(Boolean) as Array<{ distance: number; duration: number; durationInTraffic: number; poly: string }>;

    if (!candidates.length) {
      return fallback('No valid routes in Google response');
    }

    // Reject absurdly long routes (> 5x straight-line distance)
    // Indian roads can be 3-4x straight-line due to one-ways, flyovers, diversions
    const maxReasonableMeters = Math.max(10000, straightLineMeters * 5);
    const reasonableCandidates = candidates.filter(c => c.distance <= maxReasonableMeters);
    const finalCandidates = reasonableCandidates.length ? reasonableCandidates : candidates;

    if (!reasonableCandidates.length) {
      logger.warn('[getRoute] All Google routes exceed 5x straight-line. Using shortest anyway.', {
        shortestGoogleMeters: Math.min(...candidates.map((c) => c.distance)),
        straightLineMeters,
      });
    }

    // Pick the shortest-distance route
    const bestDistance = Math.min(...finalCandidates.map((c) => c.distance));
    // Allow routes within 10% of shortest distance
    const nearShortest = finalCandidates.filter((c) => c.distance <= bestDistance * 1.1);

    const chosen = (nearShortest.length ? nearShortest : finalCandidates)
      .slice()
      .sort((a, b) => {
        // Prefer shortest distance first
        if (a.distance !== b.distance) return a.distance - b.distance;
        // Tiebreak by fastest travel time
        return a.durationInTraffic - b.durationInTraffic;
      })[0];

    const poly = chosen.poly;

    return {
      distance: chosen.distance,
      duration: chosen.duration,
      durationInTraffic: chosen.durationInTraffic,
      polyline: poly,
      decodedPolyline: decodePolyline(poly),
      routeSource: 'google',
      fallbackReason: null,
    };
  } catch (err: any) {
    return fallback(`Exception: ${err?.message || err}`);
  }
};

export const calculateETA = async (
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number }
): Promise<number> => {
  try {
    requireGoogleKey();

    const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
      params: {
        origins: `${origin.latitude},${origin.longitude}`,
        destinations: `${destination.latitude},${destination.longitude}`,
        mode: 'driving',
        departure_time: 'now',
        traffic_model: 'best_guess',
        key: GOOGLE_MAPS_API_KEY,
      },
      timeout: 15000,
    });

    const data = response.data;
    if (!data || data.status !== 'OK') {
      throw new Error('Distance Matrix API error');
    }

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== 'OK') {
      throw new Error('Distance Matrix element unavailable');
    }

    const durationInTraffic = element.duration_in_traffic?.value || element.duration?.value;
    if (!durationInTraffic || typeof durationInTraffic !== 'number') {
      throw new Error('Distance Matrix duration missing');
    }

    return Math.max(1, Math.ceil(durationInTraffic / 60));
  } catch (_error) {
    const distanceKm = calculateDistance(
      origin.latitude,
      origin.longitude,
      destination.latitude,
      destination.longitude
    );

    return Math.max(1, Math.ceil((distanceKm / 30) * 60));
  }
};

export const geocodeAddress = async (
  address: string
): Promise<{ latitude: number; longitude: number; formattedAddress: string }> => {
  requireGoogleKey();

  const trimmed = address?.trim();
  if (!trimmed) {
    throw new Error('Address is required');
  }

  const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: {
      address: trimmed,
      key: GOOGLE_MAPS_API_KEY,
    },
    timeout: 15000,
  });

  const data = response.data;
  if (!data || data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Geocoding API error: ${data?.status || 'UNKNOWN'}`);
  }

  const result = data.results[0];
  const loc = result?.geometry?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    throw new Error('Geocoding API returned invalid location');
  }

  return {
    latitude: loc.lat,
    longitude: loc.lng,
    formattedAddress: result.formatted_address || trimmed,
  };
};

export const reverseGeocode = async (latitude: number, longitude: number): Promise<string> => {
  requireGoogleKey();

  const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
    params: {
      latlng: `${latitude},${longitude}`,
      key: GOOGLE_MAPS_API_KEY,
    },
    timeout: 15000,
  });

  const data = response.data;
  if (!data || data.status !== 'OK' || !data.results?.length) {
    throw new Error(`Reverse Geocoding API error: ${data?.status || 'UNKNOWN'}`);
  }

  const result = data.results[0];
  const formatted = result?.formatted_address;
  if (!formatted || typeof formatted !== 'string') {
    throw new Error('Reverse Geocoding API returned invalid address');
  }

  return formatted;
};

export default {
  calculateDistance,
  getRoute,
  calculateETA,
  geocodeAddress,
  reverseGeocode,
};
