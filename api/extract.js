// Vercel config: increase body size limit to 10MB
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured. Add ANTHROPIC_API_KEY in Vercel Environment Variables.' });
  }

  try {
    const { image, mediaType } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    console.log('Received image, base64 length:', image.length, 'mediaType:', mediaType);

    // Call Claude Vision API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: image,
                },
              },
              {
                type: 'text',
                text: `You are an expert cycling route analyst. Your job is to look at this screenshot of a cycling route on a map and precisely trace the route as GPS coordinates.

CRITICAL ANALYSIS STEPS:
1. STUDY THE ROUTE SHAPE: Look carefully at the highlighted/colored line on the map. Note every curve, turn, and direction change. Is it a loop? An out-and-back? A point-to-point ride?
2. IDENTIFY LANDMARKS: Read all visible text — city names, road numbers, highway labels, park names, neighborhoods, water features. These anchor your coordinates.
3. IDENTIFY THE START AND END POINTS: Look for markers (dots, flags, pins) indicating where the ride begins and ends.
4. TRACE THE EXACT PATH: Follow the colored route line segment by segment. At every point where the route changes direction (turns at intersections, curves along roads), place a waypoint.
5. USE REAL ROADS: Match the route to actual roads you know exist in this area. The route follows real roads — use your geographic knowledge to snap waypoints to known road paths.

WAYPOINT DENSITY REQUIREMENTS:
- Place a waypoint at EVERY turn, curve, or direction change
- On straight road segments, place waypoints every 0.25–0.5 miles
- For a typical 20-mile route, you should generate 60–120 waypoints
- For a typical 40-mile route, you should generate 120–200 waypoints
- MORE WAYPOINTS = BETTER. When in doubt, add more points along the route.

ELEVATION:
- Use your knowledge of the terrain in this area to estimate elevation at each point
- Colorado Front Range: Louisville ~5,300ft, Boulder ~5,430ft, foothills rise to 6,000-9,000ft
- Note significant climbs and descents

RESPOND WITH ONLY THIS JSON (no markdown, no code fences, no explanation):

{
  "route_name": "Descriptive name based on roads/area",
  "location": "City, State",
  "total_miles_estimate": estimated total distance,
  "confidence": 0.0 to 1.0,
  "notes": "Describe the route shape and key roads identified",
  "waypoints": [
    [latitude, longitude, elevation_feet],
    [latitude, longitude, elevation_feet]
  ]
}

COMMON MISTAKES TO AVOID:
- Do NOT just connect start and end with a straight line
- Do NOT skip large portions of the route
- Do NOT generate only 10-20 waypoints for a long route
- Do NOT ignore curves and turns visible in the route line
- TRACE the actual visible colored line on the map, point by point`
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', response.status, errText);
      return res.status(response.status).json({
        error: 'AI API error (status ' + response.status + ')',
        details: errText.substring(0, 300),
      });
    }

    const data = await response.json();

    // Extract the text content from Claude's response
    const textContent = data.content.find(c => c.type === 'text');
    if (!textContent) {
      return res.status(500).json({ error: 'No text response from AI' });
    }

    let routeData;
    try {
      // Clean the response — remove code fences if present
      let cleaned = textContent.text.trim();
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      routeData = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse AI response:', textContent.text.substring(0, 500));
      return res.status(500).json({
        error: 'Failed to parse route data from AI response',
        raw: textContent.text.substring(0, 500),
      });
    }

    // Validate the response has waypoints
    if (!routeData.waypoints || !Array.isArray(routeData.waypoints) || routeData.waypoints.length < 2) {
      return res.status(422).json({
        error: 'AI could not extract a valid route from this image',
        notes: routeData.notes || 'No details available',
      });
    }

    // Smooth interpolation for animation — ensure at least 100 points
    let waypoints = routeData.waypoints;
    if (waypoints.length < 100) {
      const interpolated = [];
      const targetPoints = Math.max(150, waypoints.length * 3);
      const stepsPerSeg = Math.ceil(targetPoints / waypoints.length);
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        for (let s = 0; s < stepsPerSeg; s++) {
          const t = s / stepsPerSeg;
          interpolated.push([
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t,
          ]);
        }
      }
      interpolated.push(waypoints[waypoints.length - 1]);
      waypoints = interpolated;
    }

    console.log('Route extracted:', routeData.route_name, waypoints.length, 'waypoints');

    return res.status(200).json({
      route_name: routeData.route_name || 'Extracted Route',
      location: routeData.location || 'Unknown',
      confidence: routeData.confidence || 0.5,
      notes: routeData.notes || '',
      waypoints: waypoints,
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Server error: ' + err.message });
  }
}
