// Vercel config: increase body size limit
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { image, mediaType } = req.body;
    if (!image) return res.status(400).json({ error: 'No image provided' });

    console.log('Step 1: Asking Claude to identify roads and intersections...');

    // STEP 1: Ask Claude to identify the route as a series of road names and key intersections
    const step1Response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: image },
            },
            {
              type: 'text',
              text: `You are analyzing a screenshot of a cycling/running route displayed on a map app (like Strava, Garmin, Wahoo, Apple Maps, Google Maps, etc).

YOUR TASK: Identify the EXACT sequence of roads, paths, and key intersections the route follows by carefully tracing the highlighted/colored route line on the map.

STEP-BY-STEP:
1. Find the START point (usually marked with a dot, flag, or "S" marker). Note the nearest road/intersection.
2. Follow the highlighted route line carefully. At each intersection or road change, note the new road name.
3. Note every turn: "Turn left onto X", "Turn right onto Y", "Continue straight on Z"
4. Continue until you reach the END point. If it's a loop, the end should be near the start.
5. Identify key intersections as lat/lng waypoints that the route MUST pass through.

READ THE MAP CAREFULLY:
- Look for road names, highway numbers (CO 93, US 36, etc), street names
- Look for city/town names to establish geographic context
- Look for landmarks: parks, reservoirs, mountain names
- Note the approximate scale of the map to estimate distances

RESPOND WITH ONLY THIS JSON:
{
  "route_name": "Descriptive name",
  "location": "City, State",
  "is_loop": true/false,
  "total_miles_estimate": number,
  "confidence": 0.0-1.0,
  "notes": "What you see in the image",
  "start_point": [latitude, longitude],
  "end_point": [latitude, longitude],
  "key_waypoints": [
    {"lat": number, "lng": number, "label": "description/road name", "elevation_ft": number},
    {"lat": number, "lng": number, "label": "description/road name", "elevation_ft": number}
  ],
  "turn_by_turn": [
    "Start at [location]",
    "Head [direction] on [road]",
    "Turn [left/right] onto [road]",
    "Continue on [road] for ~X miles",
    "..."
  ]
}

KEY WAYPOINTS RULES:
- Include 15-40 key waypoints depending on route complexity
- Place waypoints at EVERY turn or road change
- Place waypoints at intersections with named roads
- Place waypoints every 1-2 miles on long straight segments
- Use your geographic knowledge to get accurate lat/lng for known intersections
- Each waypoint should be a real, identifiable point on a real road

CRITICAL: Do NOT just put start and end points. Trace the ENTIRE visible route with waypoints at every significant point along the way.`
            },
          ],
        }],
      }),
    });

    if (!step1Response.ok) {
      const errText = await step1Response.text();
      console.error('Step 1 API error:', step1Response.status, errText);
      return res.status(step1Response.status).json({ error: 'AI API error', details: errText.substring(0, 300) });
    }

    const step1Data = await step1Response.json();
    const textContent = step1Data.content.find(c => c.type === 'text');
    if (!textContent) return res.status(500).json({ error: 'No response from AI' });

    let routeInfo;
    try {
      let cleaned = textContent.text.trim();
      if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      routeInfo = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Parse error:', textContent.text.substring(0, 500));
      return res.status(500).json({ error: 'Failed to parse AI response', raw: textContent.text.substring(0, 500) });
    }

    console.log('Step 1 complete. Route:', routeInfo.route_name, 'Waypoints:', routeInfo.key_waypoints?.length);

    // STEP 2: Build the route using OSRM (free routing engine) to snap to real roads
    const waypoints = routeInfo.key_waypoints;
    if (!waypoints || waypoints.length < 2) {
      return res.status(422).json({ error: 'Could not identify enough waypoints', notes: routeInfo.notes });
    }

    // Build OSRM request with all waypoints
    const coords = waypoints.map(wp => `${wp.lng},${wp.lat}`).join(';');
    const osrmUrl = `https://router.project-osrm.org/route/v1/cycling/${coords}?overview=full&geometries=geojson&steps=false`;

    console.log('Step 2: Routing through OSRM with', waypoints.length, 'waypoints...');

    let routeGeometry;
    try {
      const osrmResp = await fetch(osrmUrl);
      const osrmData = await osrmResp.json();

      if (osrmData.code === 'Ok' && osrmData.routes && osrmData.routes.length > 0) {
        // OSRM returns [lng, lat] — convert to [lat, lng, elev]
        const osrmCoords = osrmData.routes[0].geometry.coordinates;
        console.log('OSRM returned', osrmCoords.length, 'points');

        // Add elevation estimates by interpolating from waypoint elevations
        routeGeometry = osrmCoords.map(coord => {
          const lat = coord[1];
          const lng = coord[0];

          // Find nearest waypoint for elevation estimate
          let minDist = Infinity;
          let nearestElev = 5300;
          for (const wp of waypoints) {
            const d = Math.sqrt((lat - wp.lat) ** 2 + (lng - wp.lng) ** 2);
            if (d < minDist) {
              minDist = d;
              nearestElev = wp.elevation_ft || 5300;
            }
          }
          return [lat, lng, nearestElev];
        });

        // Smooth elevation by averaging with neighbors
        for (let i = 1; i < routeGeometry.length - 1; i++) {
          routeGeometry[i][2] = (routeGeometry[i-1][2] + routeGeometry[i][2] + routeGeometry[i+1][2]) / 3;
        }
      }
    } catch (osrmErr) {
      console.error('OSRM error:', osrmErr.message);
    }

    // Fallback: if OSRM failed, use Claude's waypoints directly with interpolation
    if (!routeGeometry || routeGeometry.length < 10) {
      console.log('OSRM failed or returned too few points, using waypoint interpolation fallback');
      routeGeometry = [];
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const dist = Math.sqrt((b.lat - a.lat) ** 2 + (b.lng - a.lng) ** 2);
        const steps = Math.max(5, Math.round(dist / 0.002)); // ~0.002 degrees ≈ 0.15 miles
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          routeGeometry.push([
            a.lat + (b.lat - a.lat) * t,
            a.lng + (b.lng - a.lng) * t,
            (a.elevation_ft || 5300) + ((b.elevation_ft || 5300) - (a.elevation_ft || 5300)) * t,
          ]);
        }
      }
      routeGeometry.push([
        waypoints[waypoints.length-1].lat,
        waypoints[waypoints.length-1].lng,
        waypoints[waypoints.length-1].elevation_ft || 5300,
      ]);
    }

    console.log('Final route:', routeGeometry.length, 'points');

    return res.status(200).json({
      route_name: routeInfo.route_name || 'Extracted Route',
      location: routeInfo.location || 'Unknown',
      confidence: routeInfo.confidence || 0.5,
      notes: routeInfo.notes || '',
      total_miles_estimate: routeInfo.total_miles_estimate || 0,
      turn_by_turn: routeInfo.turn_by_turn || [],
      waypoints: routeGeometry,
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
