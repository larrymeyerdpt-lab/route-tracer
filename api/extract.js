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
        max_tokens: 4096,
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
                text: `You are a cycling route extraction expert. Analyze this image of a cycling route map/screenshot and extract the route as a series of geographic coordinates.

INSTRUCTIONS:
1. Identify the cycling route shown in the image
2. Identify any location names, road names, landmarks, or geographic features visible
3. Using your knowledge of geography and road networks, determine the real-world coordinates of the route
4. Return waypoints along the route at roughly every 0.5-1 mile interval
5. For each waypoint, estimate the elevation in feet based on your geographic knowledge

IMPORTANT: You must respond with ONLY a valid JSON object, no other text. The format must be exactly:

{
  "route_name": "Name of the route if identifiable",
  "location": "General area (city, state, region)",
  "confidence": 0.0 to 1.0,
  "notes": "Brief description of what you see in the image",
  "waypoints": [
    [latitude, longitude, elevation_in_feet],
    [latitude, longitude, elevation_in_feet]
  ]
}

RULES:
- Latitude and longitude must be decimal degrees (e.g., 40.015, -105.270)
- Elevation must be in feet
- Include at least 20 waypoints for a reasonable route
- If you can identify the exact roads, trace them accurately
- If the image is unclear, make your best estimate and note low confidence
- The first and last waypoints should be the start and end of the visible route
- ONLY return the JSON object, nothing else — no markdown, no code fences, no explanation`
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

    // Interpolate if fewer than 50 waypoints for smoother animation
    let waypoints = routeData.waypoints;
    if (waypoints.length < 50) {
      const interpolated = [];
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const steps = Math.max(3, Math.ceil(6 / (waypoints.length / 30)));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
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
