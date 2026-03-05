export type NormalizedTripType = 'ONE_WAY' | 'ROUND_TRIP' | 'OUTSTATION';

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

const ONE_WAY_TIME_BUFFER_MINUTES_FOR_1HR = 30;
const ONE_WAY_DISTANCE_BUFFER_KM = 0;

const PRICING_TIME_ZONE = process.env.PRICING_TIME_ZONE && process.env.PRICING_TIME_ZONE.trim()
  ? process.env.PRICING_TIME_ZONE.trim()
  : 'Asia/Kolkata';

const getHourInTimeZone = (d: Date, timeZone: string): number => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const hourPart = parts.find((p) => p.type === 'hour')?.value;
    const h = hourPart ? Number(hourPart) : NaN;
    return Number.isFinite(h) ? h : d.getHours();
  } catch {
    return d.getHours();
  }
};

const isNightTime = (d: Date) => {
  const h = getHourInTimeZone(d, PRICING_TIME_ZONE);
  return h >= 22 || h < 6;
};

const endsInNightWindow = (endTime: Date) => isNightTime(endTime);

const getOneWayCharge = (distanceKm: number): number => {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;

  const km = Math.max(0, distanceKm);

  const kmInSlab0 = Math.max(0, Math.min(km, 10)); // [0,10]
  const kmInSlab1 = Math.max(0, Math.min(km, 20) - 10); // (10,20]
  const kmInSlab2 = Math.max(0, Math.min(km, 35) - 20); // (20,35]
  const kmInSlab3 = Math.max(0, km - 35); // >35

  const charge = kmInSlab0 * 3 + kmInSlab1 * 3.5 + kmInSlab2 * 5.7 + kmInSlab3 * 6.3;
  return Math.max(0, Math.round(charge));
};

const getLocalPackage = (hours: number) => {
  const h = clamp(Math.round(hours), 1, 8);
  const priceByHour: Record<number, number> = {
    1: 309,
    2: 374,
    3: 502,
    4: 631,
    5: 759,
    6: 899,
    7: 1019,
    8: 1149,
  };

  return { hours: h, price: priceByHour[h] ?? 300 };
};

export const normalizeTripType = (value: unknown): NormalizedTripType => {
  const v = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (v === 'ROUND_TRIP') return 'ROUND_TRIP';
  if (v === 'OUTSTATION') return 'OUTSTATION';
  return 'ONE_WAY';
};

export const computeFare = (params: {
  tripType: NormalizedTripType;
  distanceMeters: number;
  durationSeconds: number;
  requestedHours?: number;
  startTime?: Date;
  includedKmLimit?: number;
  includedMinutesLimit?: number;
  isEstimate?: boolean;
  roundTripDistanceFromPickupKm?: number;
  outstationTripType?: 'ROUND_TRIP' | 'ONE_WAY';
  outstationDistanceFromPickupKm?: number;
  outstationPlannedDistanceKm?: number;
}): { total: number; breakdown: Record<string, unknown> } => {
  const km = Math.max(0, params.distanceMeters / 1000);
  const minutes = Math.max(0, params.durationSeconds / 60);

  const taxesFee = 50;

  const actualHours = Math.max(1, Math.ceil(minutes / 60));
  const selectedHoursRaw = Number.isFinite(params.requestedHours as number) ? Number(params.requestedHours) : undefined;
  const selectedHours = selectedHoursRaw !== undefined ? Math.max(1, selectedHoursRaw) : actualHours;

  const startTime = params.startTime instanceof Date ? params.startTime : new Date();
  const baseEndTimeSeconds = Math.max(0, Math.round(params.durationSeconds));
  const estimateEndTimeSeconds =
    params.isEstimate && Number.isFinite(selectedHoursRaw as number)
      ? Math.max(baseEndTimeSeconds, Math.max(1, Math.round(selectedHours * 3600)))
      : baseEndTimeSeconds;
  const endTimeSeconds = estimateEndTimeSeconds;
  const endTime = new Date(startTime.getTime() + endTimeSeconds * 1000);
  const nightChargeRaw = endsInNightWindow(endTime) ? 200 : 0;
  const nightCharge = params.tripType === 'OUTSTATION' ? 0 : nightChargeRaw;

  if (params.tripType === 'OUTSTATION') {
    const outstationTripType = params.outstationTripType === 'ROUND_TRIP' ? 'ROUND_TRIP' : 'ONE_WAY';

    if (outstationTripType === 'ROUND_TRIP') {
      const taxesFee = 89;
      const extraHourRate = 60;

      const selectedHours = clamp(Math.round(selectedHoursRaw ?? actualHours), 12, 120);

      const priceByHour: Record<number, number> = {
        12: 1199,
        16: 1439,
        20: 1679,
        24: 1919,
        48: 3359,
        72: 4799,
        96: 6239,
        120: 7679,
      };

      const allowed = Object.keys(priceByHour)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);

      const nearest = allowed.reduce((best, h) => {
        if (Math.abs(h - selectedHours) < Math.abs(best - selectedHours)) return h;
        return best;
      }, allowed[0] ?? 12);

      const packageHours = nearest;
      const packagePrice = priceByHour[packageHours] ?? 1199;

      const extraHours = Math.max(0, actualHours - packageHours);
      const extraHourCharge = extraHours * extraHourRate;

      const extras = extraHourCharge;
      const subtotal = packagePrice + extras;
      const total = Math.max(0, Math.round(subtotal + nightCharge + taxesFee));

      return {
        total,
        breakdown: {
          tripType: params.tripType,
          outstationTripType,
          packageType: 'OUTSTATION_ROUND_TRIP',
          distanceKm: Math.round(km * 100) / 100,
          durationHours: actualHours,
          packageHours,
          packagePrice,
          extraHourRate,
          extraHours,
          extraHourCharge: Math.round(extraHourCharge),
          extras: Math.round(extras),
          subtotal: Math.round(subtotal),
          nightCharge,
          taxesFee,
          total,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
        },
      };
    }

    const taxesFee = 109;
    const extraHourRate = 99;
    const oneWayDistanceThresholdKm = 200;
    const oneWayDistanceRate = 6;

    const selectedHours = clamp(Math.round(selectedHoursRaw ?? actualHours), 12, 18);
    const priceByHour: Record<number, number> = {
      12: 1800,
      14: 1999,
      16: 2199,
      18: 2399,
    };

    const allowed = Object.keys(priceByHour)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    const nearest = allowed.reduce((best, h) => {
      if (Math.abs(h - selectedHours) < Math.abs(best - selectedHours)) return h;
      return best;
    }, allowed[0] ?? 12);

    const packageHours = nearest;
    const packagePrice = priceByHour[packageHours] ?? 1800;

    const plannedKmRaw =
      typeof params.outstationPlannedDistanceKm === 'number' && Number.isFinite(params.outstationPlannedDistanceKm)
        ? Math.max(0, params.outstationPlannedDistanceKm)
        : typeof params.includedKmLimit === 'number' && Number.isFinite(params.includedKmLimit)
          ? Math.max(0, params.includedKmLimit)
          : Math.max(0, km);

    const distanceFromPickupKm =
      typeof params.outstationDistanceFromPickupKm === 'number' && Number.isFinite(params.outstationDistanceFromPickupKm)
        ? Math.max(0, params.outstationDistanceFromPickupKm)
        : params.isEstimate
          ? plannedKmRaw
          : 0;

    const overThresholdKm = Math.max(0, distanceFromPickupKm - oneWayDistanceThresholdKm);
    const oneWayCharge = Math.max(0, Math.round(overThresholdKm * oneWayDistanceRate));

    const extraHours = Math.max(0, actualHours - packageHours);
    const extraHourCharge = extraHours * extraHourRate;

    const extras = extraHourCharge;
    const subtotal = packagePrice + oneWayCharge + extras;
    const total = Math.max(0, Math.round(subtotal + nightCharge + taxesFee));

    return {
      total,
      breakdown: {
        tripType: params.tripType,
        outstationTripType,
        packageType: 'OUTSTATION_ONE_WAY',
        distanceKm: Math.round(km * 100) / 100,
        durationHours: actualHours,
        packageHours,
        packagePrice,
        plannedDropDistanceKm: Math.round(plannedKmRaw * 100) / 100,
        oneWayCharge,
        oneWayDistanceThresholdKm,
        oneWayDistanceRate,
        extraHourRate,
        extraHours,
        extraHourCharge: Math.round(extraHourCharge),
        distanceFromPickupKm: Math.round(distanceFromPickupKm * 100) / 100,
        overThresholdKm: Math.round(overThresholdKm * 100) / 100,
        extras: Math.round(extras),
        subtotal: Math.round(subtotal),
        nightCharge,
        taxesFee,
        total,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      },
    };
  }

  if (params.tripType === 'ROUND_TRIP') {
    const extraMinuteRate = 2.15;
    const extraKmRate = 7.5;
    const freeRadiusKm = 2;

    const getRoundTripPackagePrice = (hours: number): { hours: number; price: number } => {
      const h = Math.max(1, Math.round(hours));

      const points: Array<{ h: number; p: number }> = [
        { h: 1, p: 279 },
        { h: 2, p: 299 },
        { h: 4, p: 489 },
        { h: 6, p: 699 },
        { h: 8, p: 889 },
        { h: 12, p: 1239 },
      ];

      const exact = points.find((pt) => pt.h === h);
      if (exact) return { hours: h, price: exact.p };

      const lower = [...points].reverse().find((pt) => pt.h < h) ?? points[0];
      const upper = points.find((pt) => pt.h > h) ?? points[points.length - 1];
      if (lower.h === upper.h) return { hours: h, price: upper.p };

      const t = (h - lower.h) / (upper.h - lower.h);
      const price = lower.p + t * (upper.p - lower.p);
      return { hours: h, price: Math.round(price) };
    };

    const pkg = getRoundTripPackagePrice(selectedHours);
    const packageHours = pkg.hours;
    const packagePrice = pkg.price;

    const timeBufferMinutes = packageHours === 1 ? ONE_WAY_TIME_BUFFER_MINUTES_FOR_1HR : 0;
    const includedMinutesLimit =
      typeof params.includedMinutesLimit === 'number' && Number.isFinite(params.includedMinutesLimit)
        ? Math.max(0, params.includedMinutesLimit)
        : packageHours * 60 + timeBufferMinutes;

    const extraMinutes = Math.max(0, Math.ceil(minutes - includedMinutesLimit));
    const extraMinuteCharge = extraMinutes * extraMinuteRate;

    const distanceFromPickupKm =
      typeof params.roundTripDistanceFromPickupKm === 'number' && Number.isFinite(params.roundTripDistanceFromPickupKm)
        ? Math.max(0, params.roundTripDistanceFromPickupKm)
        : 0;
    const extraReturnKm = Math.max(0, distanceFromPickupKm - freeRadiusKm);
    const extraReturnKmCharge = extraReturnKm * extraKmRate;

    const extras = extraMinuteCharge + extraReturnKmCharge;
    const subtotal = packagePrice + extras;
    const total = Math.max(0, Math.round(subtotal + nightCharge + taxesFee));

    return {
      total,
      breakdown: {
        tripType: params.tripType,
        packageType: 'ROUND_TRIP_PAY_AS_YOU_GO',
        distanceKm: Math.round(km * 100) / 100,
        durationHours: selectedHours,
        packageHours,
        packagePrice,
        subtotal: Math.round(subtotal),
        nightCharge,
        timeBufferMinutes,
        includedMinutesLimit: Math.round(includedMinutesLimit),
        extraMinuteRate,
        extraMinutes,
        extraMinuteCharge: Math.round(extraMinuteCharge * 100) / 100,
        freeRadiusKm,
        distanceFromPickupKm: Math.round(distanceFromPickupKm * 100) / 100,
        extraKmRate,
        extraReturnKm: Math.round(extraReturnKm * 100) / 100,
        extraReturnKmCharge: Math.round(extraReturnKmCharge * 100) / 100,
        extras: Math.round(extras * 100) / 100,
        taxesFee,
        total,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      },
    };
  }

  const selected = getLocalPackage(selectedHours);

  const extraKmRate = 7.5;
  const extraMinuteRate = 2.15;

  const baseIncludedMinutes = selected.hours * 60;
  const bufferMinutes = selected.hours === 1 ? ONE_WAY_TIME_BUFFER_MINUTES_FOR_1HR : 0;
  const includedMinutesLimit =
    typeof params.includedMinutesLimit === 'number' && Number.isFinite(params.includedMinutesLimit)
      ? Math.max(0, params.includedMinutesLimit)
      : baseIncludedMinutes + bufferMinutes;

  const includedKmLimit =
    typeof params.includedKmLimit === 'number' && Number.isFinite(params.includedKmLimit)
      ? Math.max(0, params.includedKmLimit)
      : Math.max(0, km);

  const oneWayCharge = getOneWayCharge(includedKmLimit);

  const extraMinutes = Math.max(0, Math.ceil(minutes - includedMinutesLimit));
  const extraKm = Math.max(0, km - includedKmLimit);

  const extraMinuteCharge = extraMinutes * extraMinuteRate;
  const extraKmCharge = extraKm * extraKmRate;
  const extras = extraMinuteCharge + extraKmCharge;

  const subtotal = selected.price + oneWayCharge + extras;
  const total = Math.max(0, Math.round(subtotal + nightCharge + taxesFee));

  return {
    total,
    breakdown: {
      tripType: params.tripType,
      packageType: 'LOCAL_HOURLY',
      distanceKm: Math.round(km * 100) / 100,
      durationHours: selectedHours,
      packageHours: selected.hours,
      packagePrice: selected.price,
      subtotal: Math.round(subtotal),
      nightCharge,
      oneWayCharge,
      includedKmLimit: Math.round(includedKmLimit * 100) / 100,
      includedMinutesLimit: Math.round(includedMinutesLimit),
      distanceBufferKm: ONE_WAY_DISTANCE_BUFFER_KM,
      timeBufferMinutes: bufferMinutes,
      extraMinuteRate,
      extraKmRate,
      extraMinutes,
      extraKm: Math.round(extraKm * 100) / 100,
      extraMinuteCharge: Math.round(extraMinuteCharge * 100) / 100,
      extraKmCharge: Math.round(extraKmCharge * 100) / 100,
      extras: Math.round(extras * 100) / 100,
      taxesFee,
      total,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
    },
  };
};
