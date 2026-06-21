import { Router, Request, Response } from 'express';
import { TripShareService } from '../services/tripShare.service';
import { logger } from '../utils/logger';

const router = Router();

// SECURITY: HTML-escape user-provided strings before embedding in SSR HTML
const escapeHtml = (str: string): string =>
  String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * GET /track/:shareToken
 * Serves a self-contained HTML tracking page for shared trips.
 * No authentication required — public access for family/friends.
 */
router.get('/track/:shareToken', async (req: Request, res: Response) => {
  const { shareToken } = req.params;

  try {
    const trip = await TripShareService.getPublicTracking(shareToken);
    const apiVersion = process.env.API_VERSION || 'v1';
    // Use a separate web-specific key that has Maps JS API enabled with no referrer restrictions
    // Falls back to the same key as mobile (which may have restrictions)
    const googleMapsKey = process.env.GOOGLE_MAPS_WEB_KEY || process.env.GOOGLE_MAPS_API_KEY || '';
    const appScheme = 'drively';
    const baseUrl = process.env.APP_URL || process.env.API_URL || 'https://v2.kurnm.click';

    // Determine trip state
    const isActive = !['COMPLETED', 'CANCELLED'].includes(trip.status);
    const statusLabels: Record<string, string> = {
      REQUESTED: 'Finding a driver…',
      SEARCHING: 'Finding a driver…',
      ACCEPTED: 'Driver assigned',
      DRIVER_ARRIVING: 'Driver is on the way',
      ARRIVED: 'Driver has arrived',
      STARTED: 'Trip in progress',
      IN_PROGRESS: 'Trip in progress',
      COMPLETED: 'Trip completed',
      CANCELLED: 'Trip cancelled',
    };
    const statusLabel = statusLabels[trip.status] || trip.status;

    const statusColors: Record<string, string> = {
      REQUESTED: '#f59e0b',
      SEARCHING: '#f59e0b',
      ACCEPTED: '#f59e0b',
      DRIVER_ARRIVING: '#f59e0b',
      ARRIVED: '#10b981',
      STARTED: '#3b82f6',
      IN_PROGRESS: '#3b82f6',
      COMPLETED: '#10b981',
      CANCELLED: '#ef4444',
    };
    const statusColor = statusColors[trip.status] || '#6b7280';

    const driverName = trip.driver
      ? escapeHtml(`${trip.driver.firstName} ${trip.driver.lastName || ''}`.trim())
      : '';
    const vehicleInfo = trip.driver?.vehicle
      ? escapeHtml(`${[trip.driver.vehicle.color, trip.driver.vehicle.make, trip.driver.vehicle.model].filter(Boolean).join(' ')}`.trim())
      : '';
    const licensePlate = trip.driver?.vehicle?.licensePlate ? escapeHtml(trip.driver.vehicle.licensePlate) : '';
    const driverLat = trip.driver?.currentLocation?.latitude;
    const driverLng = trip.driver?.currentLocation?.longitude;
    const pickupLat = trip.pickup?.latitude;
    const pickupLng = trip.pickup?.longitude;
    const dropLat = trip.drop?.latitude;
    const dropLng = trip.drop?.longitude;

    // Use currentETA from DB — this is updated live every 8s by Google Maps API
    // via locationHandlers.ts calculateETA() — same value shown to customer and driver in the app.
    // Falls back to driverETA (booking creation estimate) if currentETA is not set.
    const liveETA = trip.currentETA
      ? Number(trip.currentETA)
      : trip.driverETA
        ? Number(trip.driverETA)
        : null;

    // Show ETA for all active statuses, hide only for COMPLETED/CANCELLED
    // Pre-trip: shows driver arrival ETA; During trip: shows estimated drop-off ETA
    const showETA = liveETA && liveETA > 0 && !['COMPLETED', 'CANCELLED'].includes(trip.status);
    const etaContext = ['STARTED', 'IN_PROGRESS'].includes(trip.status) ? 'to drop' : 'away';

    const ogDescription = driverName
      ? escapeHtml(`${trip.customerName}'s ride with ${driverName} — track live on Drively`)
      : escapeHtml(`Track ${trip.customerName}'s ride live on Drively`);

    // Build static map URL as guaranteed fallback (works without JS)
    const staticMapMarkers = [
      pickupLat && pickupLng ? `color:green|${pickupLat},${pickupLng}` : '',
      dropLat && dropLng ? `color:red|${dropLat},${dropLng}` : '',
      driverLat && driverLng ? `color:0xC9A84C|label:D|${driverLat},${driverLng}` : '',
    ].filter(Boolean).map(m => `&markers=${encodeURIComponent(m)}`).join('');
    const staticMapUrl = googleMapsKey
      ? `https://maps.googleapis.com/maps/api/staticmap?size=600x300&scale=2&maptype=roadmap&style=element:geometry|color:0x1d1d1d&style=element:labels.text.fill|color:0x757575${staticMapMarkers}&key=${googleMapsKey}`
      : '';


    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Track Ride — Drively</title>
  <meta name="description" content="${ogDescription}">

  <!-- Open Graph for WhatsApp / iMessage / social previews -->
  <meta property="og:title" content="🚗 Track My Drively Ride">
  <meta property="og:description" content="${ogDescription}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${baseUrl}/track/${shareToken}">
  <meta property="og:site_name" content="Drively">

  <!-- Smart deep link: try to open app, fall back to web page -->
  <script>
    (function() {
      var deepLink = 'drively://track/${shareToken}';
      var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobile) {
        // Try to open app
        var appOpened = false;
        var t = setTimeout(function() {
          if (!appOpened) {
            // App not installed or failed — stay on web page
            document.getElementById('webFallback') && (document.getElementById('webFallback').style.display = 'block');
          }
        }, 1500);
        // Listen for blur = app opened successfully
        window.addEventListener('blur', function() { appOpened = true; clearTimeout(t); });
        window.location.href = deepLink;
      }
    })();
  </script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">

  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --bg: #0A0A0A;
      --surface: #141414;
      --card: #1A1A1A;
      --border: rgba(255,255,255,0.06);
      --gold: #C9A84C;
      --gold-dim: rgba(201,168,76,0.15);
      --text-primary: #F5F5F5;
      --text-secondary: #8A8A8A;
      --text-muted: #555;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text-primary);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
    }

    /* ── Header ───────────────────────────────── */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .header-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header-brand .logo {
      width: 28px;
      height: 28px;
      background: linear-gradient(135deg, #C9A84C, #e8d48b);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 900;
      font-size: 14px;
      color: #0A0A0A;
    }
    .header-brand span {
      font-weight: 800;
      font-size: 18px;
      background: linear-gradient(135deg, #C9A84C, #e8d48b);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .header .open-app {
      background: var(--gold);
      color: #0A0A0A;
      border: none;
      padding: 8px 16px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 13px;
      cursor: pointer;
      text-decoration: none;
      transition: transform 0.15s;
    }
    .header .open-app:active {
      transform: scale(0.96);
    }

    /* ── Map ──────────────────────────────────── */
    #map {
      width: 100%;
      height: 45vh;
      min-height: 280px;
      background: #111;
    }

    /* ── Status Banner ────────────────────────── */
    .status-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      background: ${statusColor};
      transition: background 0.4s ease;
    }
    .status-banner .status-label {
      font-weight: 700;
      font-size: 15px;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .status-banner .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #fff;
    }
    .status-banner .eta-badge {
      background: rgba(255,255,255,0.25);
      padding: 6px 14px;
      border-radius: 10px;
      font-weight: 800;
      font-size: 16px;
      color: #fff;
    }
    .status-banner .eta-badge small {
      font-size: 11px;
      font-weight: 600;
      opacity: 0.85;
      margin-left: 2px;
    }

    @keyframes pulse-dot {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .status-banner.active .status-dot {
      animation: pulse-dot 1.5s ease-in-out infinite;
    }

    /* ── Content ──────────────────────────────── */
    .content {
      flex: 1;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      max-width: 600px;
      margin: 0 auto;
      width: 100%;
    }

    /* ── Driver Card ──────────────────────────── */
    .driver-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .driver-avatar {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--gold-dim), rgba(201,168,76,0.05));
      border: 2px solid rgba(201,168,76,0.25);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: 800;
      color: var(--gold);
      overflow: hidden;
      flex-shrink: 0;
    }
    .driver-avatar img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      border-radius: 50%;
    }
    .driver-details {
      flex: 1;
      min-width: 0;
    }
    .driver-name {
      font-size: 17px;
      font-weight: 800;
      color: var(--text-primary);
    }
    .vehicle-info {
      font-size: 13px;
      color: var(--text-secondary);
      margin-top: 3px;
    }
    .plate-badge {
      display: inline-block;
      margin-top: 6px;
      background: rgba(255,255,255,0.06);
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 1.2px;
      color: var(--text-primary);
    }

    /* ── Route Card ───────────────────────────── */
    .route-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
    }
    .route-point {
      display: flex;
      align-items: flex-start;
      gap: 12px;
    }
    .route-point + .route-point {
      margin-top: 14px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .route-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      margin-top: 4px;
      flex-shrink: 0;
    }
    .route-dot.pickup { background: #10b981; }
    .route-dot.drop { background: #ef4444; }
    .route-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .route-address {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      margin-top: 2px;
      line-height: 1.4;
    }

    /* ── Trip Ended Overlay ────────────────────── */
    .ended-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(10,10,10,0.92);
      z-index: 200;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 16px;
      text-align: center;
      padding: 24px;
    }
    .ended-overlay.show { display: flex; }
    .ended-icon { font-size: 56px; }
    .ended-title { font-size: 24px; font-weight: 800; }
    .ended-sub { font-size: 14px; color: var(--text-secondary); max-width: 280px; line-height: 1.5; }

    /* ── Footer ───────────────────────────────── */
    .footer {
      padding: 16px;
      text-align: center;
    }
    .footer .download-btn {
      display: inline-block;
      background: linear-gradient(135deg, #C9A84C, #e8d48b);
      color: #0A0A0A;
      text-decoration: none;
      padding: 14px 28px;
      border-radius: 14px;
      font-weight: 800;
      font-size: 15px;
      transition: transform 0.15s;
    }
    .footer .download-btn:active { transform: scale(0.96); }
    .footer p {
      margin-top: 10px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .no-driver {
      text-align: center;
      padding: 20px;
      color: var(--text-secondary);
      font-size: 14px;
    }

    /* ── Last updated ─────────────────────────── */
    .last-updated {
      text-align: center;
      font-size: 11px;
      color: var(--text-muted);
      padding-bottom: 4px;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <div class="header-brand">
      <div class="logo">D</div>
      <span>Drively</span>
    </div>
    <a class="open-app" href="${appScheme}://track/${shareToken}" id="openAppBtn">Open in App</a>
  </div>

  <!-- Map: Static image loads immediately, JS interactive map replaces it if key works -->
  <div id="mapWrap" style="position:relative;width:100%;height:45vh;min-height:280px;background:#111;overflow:hidden;">
    ${staticMapUrl
      ? `<img id="staticMap" src="${staticMapUrl}" style="width:100%;height:100%;object-fit:cover;display:block;" alt="Map" onerror="this.style.display='none'">`
      : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:13px;">🗺️ Map loading…</div>`
    }
    <div id="map" style="position:absolute;inset:0;"></div>
  </div>

  <!-- Status Banner -->
  <div class="status-banner ${isActive ? 'active' : ''}" id="statusBanner">
    <div class="status-label">
      <div class="status-dot"></div>
      <span id="statusText">${statusLabel}</span>
    </div>
    ${showETA
      ? `<div class="eta-badge" id="etaBadge">${liveETA}<small>${etaContext.toUpperCase()}</small></div>`
      : `<div class="eta-badge" id="etaBadge" style="display:none"></div>`
    }
  </div>

  <!-- Content -->
  <div class="content">
    ${trip.driver ? `
    <div class="driver-card" id="driverCard">
      <div class="driver-avatar" id="driverAvatar">
        ${trip.driver.profileImage
          ? `<img src="${trip.driver.profileImage}" alt="${driverName}"
               onerror="this.style.display='none';this.parentNode.innerText='${driverName.charAt(0).toUpperCase()}'"
             >`
          : driverName.charAt(0).toUpperCase()
        }
      </div>
      <div class="driver-details">
        <div class="driver-name" id="driverName">${driverName}</div>
        ${vehicleInfo ? `<div class="vehicle-info" id="vehicleInfo">${vehicleInfo}</div>` : ''}
        ${licensePlate ? `<div class="plate-badge" id="plateBadge">${licensePlate}</div>` : ''}
      </div>
    </div>
    ` : `<div class="no-driver" id="driverCard">Searching for a driver…</div>`}

    <div class="route-card">
      <div class="route-point">
        <div class="route-dot pickup"></div>
        <div>
          <div class="route-label">Pickup</div>
          <div class="route-address" id="pickupAddr">${escapeHtml(trip.pickupAddress || 'Pickup location')}</div>
        </div>
      </div>
      ${trip.dropAddress ? `
      <div class="route-point">
        <div class="route-dot drop"></div>
        <div>
          <div class="route-label">Drop-off</div>
          <div class="route-address" id="dropAddr">${escapeHtml(trip.dropAddress)}</div>
        </div>
      </div>` : ''}
    </div>

    <div class="last-updated" id="lastUpdated">Live tracking</div>
  </div>

  <!-- Footer -->
  <div class="footer">
    <a class="download-btn" href="https://play.google.com/store/apps/details?id=com.drively.app" target="_blank">
      📲 Get Drively App
    </a>
    <p>Book a professional driver for your car</p>
  </div>

  <!-- Trip Ended Overlay -->
  <div class="ended-overlay" id="endedOverlay">
    <div class="ended-icon" id="endedIcon">✅</div>
    <div class="ended-title" id="endedTitle">Trip Completed</div>
    <div class="ended-sub" id="endedSub">${escapeHtml(trip.customerName)}'s ride has been completed safely.</div>
  </div>

  <script>
    (function() {
      const SHARE_TOKEN = '${shareToken}';
      const API_BASE = '${baseUrl}/api/${apiVersion}';
      const POLL_INTERVAL = 5000;
      const GOOGLE_MAPS_KEY = '${googleMapsKey}';

      let map, driverMarker, pickupMarker, dropMarker;
      let pollTimer = null;
      let tripEnded = false;

      // ── Initial data from server render ──
      let currentData = ${JSON.stringify({
        status: trip.status,
        driverETA: trip.driverETA,
        driverLat,
        driverLng,
        pickupLat,
        pickupLng,
        dropLat,
        dropLng,
        driverName,
        vehicleInfo,
        licensePlate,
        driverPhoto: trip.driver?.profileImage || null,
      })};

      const STATUS_LABELS = {
        REQUESTED: 'Finding a driver…',
        SEARCHING: 'Finding a driver…',
        ACCEPTED: 'Driver assigned',
        DRIVER_ARRIVING: 'Driver is on the way',
        ARRIVED: 'Driver has arrived',
        STARTED: 'Trip in progress',
        IN_PROGRESS: 'Trip in progress',
        COMPLETED: 'Trip completed',
        CANCELLED: 'Trip cancelled',
      };

      const STATUS_COLORS = {
        REQUESTED: '#f59e0b',
        SEARCHING: '#f59e0b',
        ACCEPTED: '#f59e0b',
        DRIVER_ARRIVING: '#f59e0b',
        ARRIVED: '#10b981',
        STARTED: '#3b82f6',
        IN_PROGRESS: '#3b82f6',
        COMPLETED: '#10b981',
        CANCELLED: '#ef4444',
      };

      // ── Initialize Google Map ──
      window.initMap = function() {
        const center = currentData.driverLat && currentData.driverLng
          ? { lat: currentData.driverLat, lng: currentData.driverLng }
          : currentData.pickupLat && currentData.pickupLng
            ? { lat: currentData.pickupLat, lng: currentData.pickupLng }
            : { lat: 17.385, lng: 78.4867 }; // Default Hyderabad

        map = new google.maps.Map(document.getElementById('map'), {
          center: center,
          zoom: 14,
          disableDefaultUI: true,
          zoomControl: true,
          styles: [
            { elementType: 'geometry', stylers: [{ color: '#1d1d1d' }] },
            { elementType: 'labels.text.stroke', stylers: [{ color: '#1d1d1d' }] },
            { elementType: 'labels.text.fill', stylers: [{ color: '#757575' }] },
            { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2c2c2c' }] },
            { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#8a8a8a' }] },
            { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e0e0e' }] },
            { featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] },
            { featureType: 'transit', stylers: [{ visibility: 'off' }] },
          ],
        });

        // Pickup marker
        if (currentData.pickupLat && currentData.pickupLng) {
          pickupMarker = new google.maps.Marker({
            position: { lat: currentData.pickupLat, lng: currentData.pickupLng },
            map: map,
            title: 'Pickup',
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#10b981',
              fillOpacity: 1,
              strokeColor: '#fff',
              strokeWeight: 2,
            },
          });
        }

        // Drop marker
        if (currentData.dropLat && currentData.dropLng) {
          dropMarker = new google.maps.Marker({
            position: { lat: currentData.dropLat, lng: currentData.dropLng },
            map: map,
            title: 'Drop-off',
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              scale: 8,
              fillColor: '#ef4444',
              fillOpacity: 1,
              strokeColor: '#fff',
              strokeWeight: 2,
            },
          });
        }

        // Driver marker
        if (currentData.driverLat && currentData.driverLng) {
          driverMarker = new google.maps.Marker({
            position: { lat: currentData.driverLat, lng: currentData.driverLng },
            map: map,
            title: 'Driver',
            icon: {
              url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
                '<circle cx="20" cy="20" r="18" fill="%23C9A84C" stroke="%23fff" stroke-width="3"/>' +
                '<text x="20" y="26" text-anchor="middle" font-size="18" font-weight="bold" fill="%230A0A0A">🚗</text>' +
                '</svg>'
              ),
              scaledSize: new google.maps.Size(40, 40),
              anchor: new google.maps.Point(20, 20),
            },
            zIndex: 999,
          });
        }

        // Fit bounds to show all markers
        fitBounds();

        // Start polling
        if (!tripEnded) {
          pollTimer = setInterval(pollStatus, POLL_INTERVAL);
        }
      };

      function fitBounds() {
        if (!map) return;
        const bounds = new google.maps.LatLngBounds();
        let hasPoints = false;

        if (currentData.pickupLat && currentData.pickupLng) {
          bounds.extend({ lat: currentData.pickupLat, lng: currentData.pickupLng });
          hasPoints = true;
        }
        if (currentData.dropLat && currentData.dropLng) {
          bounds.extend({ lat: currentData.dropLat, lng: currentData.dropLng });
          hasPoints = true;
        }
        if (currentData.driverLat && currentData.driverLng) {
          bounds.extend({ lat: currentData.driverLat, lng: currentData.driverLng });
          hasPoints = true;
        }

        if (hasPoints) {
          map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
        }
      }

      // ── Poll for updates ──
      async function pollStatus() {
        if (tripEnded) return;

        try {
          const res = await fetch(API_BASE + '/bookings/track/' + SHARE_TOKEN);
          if (!res.ok) return;
          const json = await res.json();
          if (!json.success || !json.data) return;

          const d = json.data;

          // Update status
          const statusText = document.getElementById('statusText');
          const statusBanner = document.getElementById('statusBanner');
          if (statusText) statusText.textContent = STATUS_LABELS[d.status] || d.status;
          if (statusBanner) statusBanner.style.background = STATUS_COLORS[d.status] || '#6b7280';

          // Active status animation
          if (['COMPLETED', 'CANCELLED'].includes(d.status)) {
            statusBanner && statusBanner.classList.remove('active');
          } else {
            statusBanner && statusBanner.classList.add('active');
          }

          // Update ETA — show for all active statuses.
          // Pre-trip: driver arrival ETA; During trip: estimated drop-off ETA.
          const etaBadge = document.getElementById('etaBadge');
          if (etaBadge) {
            const hideETA = ['COMPLETED', 'CANCELLED'].includes(d.status);
            const eta = d.currentETA ?? d.driverETA ?? null;
            const etaCtx = ['STARTED', 'IN_PROGRESS'].includes(d.status) ? 'TO DROP' : 'AWAY';
            if (!hideETA && eta && eta > 0) {
              etaBadge.innerHTML = Math.round(eta) + '<small>' + etaCtx + '</small>';
              etaBadge.style.display = '';
            } else {
              etaBadge.style.display = 'none';
            }
          }

          // Update driver position on map
          const dLat = d.driver?.currentLocation?.latitude;
          const dLng = d.driver?.currentLocation?.longitude;
          if (dLat && dLng && map) {
            const pos = { lat: dLat, lng: dLng };
            currentData.driverLat = dLat;
            currentData.driverLng = dLng;

            if (driverMarker) {
              driverMarker.setPosition(pos);
            } else {
              driverMarker = new google.maps.Marker({
                position: pos,
                map: map,
                title: 'Driver',
                icon: {
                  url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +
                    '<circle cx="20" cy="20" r="18" fill="%23C9A84C" stroke="%23fff" stroke-width="3"/>' +
                    '<text x="20" y="26" text-anchor="middle" font-size="18" font-weight="bold" fill="%230A0A0A">🚗</text>' +
                    '</svg>'
                  ),
                  scaledSize: new google.maps.Size(40, 40),
                  anchor: new google.maps.Point(20, 20),
                },
                zIndex: 999,
              });
            }
            // Pan to driver
            map.panTo(pos);
          }

          // Update driver info if it appeared
          const driverCard = document.getElementById('driverCard');
          if (d.driver && driverCard && driverCard.classList.contains('no-driver')) {
            // Rebuild driver card
            const name = (d.driver.firstName + ' ' + (d.driver.lastName || '')).trim();
            const veh = d.driver.vehicle ? (d.driver.vehicle.color + ' ' + d.driver.vehicle.make + ' ' + d.driver.vehicle.model).trim() : '';
            const plate = d.driver.vehicle?.licensePlate || '';
            const initial = name.charAt(0).toUpperCase();
            const avatar = d.driver.profileImage ? '<img src="' + d.driver.profileImage + '" alt="' + name + '">' : initial;

            driverCard.className = 'driver-card';
            driverCard.innerHTML =
              '<div class="driver-avatar">' + avatar + '</div>' +
              '<div class="driver-details">' +
                '<div class="driver-name">' + name + '</div>' +
                (veh ? '<div class="vehicle-info">' + veh + '</div>' : '') +
                (plate ? '<div class="plate-badge">' + plate + '</div>' : '') +
              '</div>';
          }

          // Update timestamp
          const lastUpdated = document.getElementById('lastUpdated');
          if (lastUpdated) {
            const now = new Date();
            lastUpdated.textContent = 'Updated ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          }

          // Check if trip ended
          if (d.status === 'COMPLETED' || d.status === 'CANCELLED') {
            tripEnded = true;
            clearInterval(pollTimer);
            showEndedOverlay(d.status);
          }
        } catch (err) {
          // Silent fail — will retry on next poll
        }
      }

      function showEndedOverlay(status) {
        const overlay = document.getElementById('endedOverlay');
        const icon = document.getElementById('endedIcon');
        const title = document.getElementById('endedTitle');
        const sub = document.getElementById('endedSub');
        if (!overlay) return;

        if (status === 'CANCELLED') {
          icon.textContent = '❌';
          title.textContent = 'Trip Cancelled';
          sub.textContent = 'This ride has been cancelled.';
        } else {
          icon.textContent = '✅';
          title.textContent = 'Trip Completed!';
          sub.textContent = 'The ride has been completed safely. Thank you for tracking!';
        }
        overlay.classList.add('show');
      }

      // ── Check if already ended ──
      if (${!isActive}) {
        tripEnded = true;
        setTimeout(function() { showEndedOverlay('${trip.status}'); }, 500);
      }
    })();
  </script>

  ${googleMapsKey ? `<script async defer src="https://maps.googleapis.com/maps/api/js?key=${googleMapsKey}&callback=initMap"></script>` : `<script>
    document.getElementById('map').innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#555;font-size:14px;">Map unavailable</div>';
  </script>`}
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    // Permissive CSP for this public share page — needs Google Maps, Cloudinary, inline scripts
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com https://fonts.googleapis.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.gstatic.com; " +
      "img-src 'self' data: blob: https://maps.googleapis.com https://maps.gstatic.com https://res.cloudinary.com https://khms0.googleapis.com https://khms1.googleapis.com https://khms0.google.com https://khms1.google.com https://cbks0.googleapis.com https://cbks1.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "connect-src 'self' https://maps.googleapis.com https://v2.kurnm.click; " +
      "frame-src 'none';"
    );
    res.send(html);
  } catch (error: any) {
    logger.warn('Trip share web page error', { shareToken, error: error?.message });

    // Serve a friendly error page
    const errorHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tracking Unavailable — Drively</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    body {
      margin: 0; padding: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; flex-direction: column;
      background: #0A0A0A; color: #F5F5F5;
      font-family: 'Inter', sans-serif; text-align: center; padding: 24px;
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h1 { font-size: 22px; font-weight: 800; margin-bottom: 8px; }
    p { font-size: 14px; color: #8A8A8A; max-width: 300px; line-height: 1.5; }
    .btn {
      margin-top: 24px; display: inline-block;
      background: linear-gradient(135deg, #C9A84C, #e8d48b);
      color: #0A0A0A; text-decoration: none;
      padding: 14px 28px; border-radius: 14px;
      font-weight: 800; font-size: 15px;
    }
  </style>
</head>
<body>
  <div class="icon">🔗</div>
  <h1>Tracking Link Unavailable</h1>
  <p>This tracking link may have expired or the trip has ended. Trip sharing links are only active during an ongoing ride.</p>
  <a class="btn" href="https://play.google.com/store/apps/details?id=com.drively.app">Get Drively App</a>
</body>
</html>`;

    res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8').send(errorHtml);
  }
});

export default router;
