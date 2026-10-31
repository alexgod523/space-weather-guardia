# SpaceWeather Guardian

A responsive live dashboard based on the product, feature, audience, impact, and architecture details in the source presentation. Team names, institution, and event branding have been left out.

## Run locally on Windows

1. Open PowerShell in this folder.
2. Run `powershell -ExecutionPolicy Bypass -File .\Start-SpaceWeatherGuardian.ps1`.
3. Open [http://127.0.0.1:4173](http://127.0.0.1:4173) in a browser.
4. Keep the PowerShell window open while using the dashboard. Press Ctrl+C in it to stop the local server.

The launcher uses Windows PowerShell only and has no package installation step. The dashboard polls its public data feeds every five minutes. The browser needs internet access for current readings.

## Connected data

- **NOAA SWPC:** planetary Kp and forecast, solar-wind speed, IMF Bz, NOAA scales, official alerts, and OVATION aurora probability.
- **NASA DONKI:** recent notifications across event types.
- **Open-Meteo:** city geocoding and coordinate-specific current cloud cover, visibility, daylight, and time zone.
- **API key:** NOAA's public feeds do not require a key. NASA's `DEMO_KEY` is used by default; a personal NASA key can be added in Settings. The key is stored in this browser's local storage and sent only to `api.nasa.gov` when requesting NASA data.

The NASA link in the request points to documentation, not a key value. NASA's demo key has lower request limits. Automatic polling is every five minutes; manual refresh can make additional requests.

## Working prototype and product blueprint

The browser implementation includes live monitoring, feed refresh, an event timeline, a Kp chart, an interactive 3D orthographic globe for NOAA OVATION aurora probability, sector guidance, a rule-based explainer, configurable thresholds, and optional browser notifications. Drag the globe to rotate, scroll or use the controls to zoom, hover to inspect coordinates and the nearest OVATION cell, and use arrow keys when the globe has keyboard focus. The selected place is marked when it is on the visible hemisphere. The Global map page plots NOAA R, G, and S scale context on a separate interactive world globe; its flare layer follows the sunlit hemisphere, while geomagnetic and solar-radiation layers use broad latitude weighting. It also displays the latest GOES soft X-ray class. Colors indicate broad impact potential, not temperature or a site-specific prediction. The added profession advisor maps typed roles to likely technology dependencies, then combines current global NOAA indicators with the selected place's local time, broad latitude context, altitude profile, and next 24-hour Kp timing. It gives practical checks and official NOAA references; it does not predict individual harm, local outages, flight-route conditions, or radiation dose. Profession text stays in page memory and is not saved or sent to a service. The location card appears first and requests browser location automatically; city/postal search and manual coordinates remain available. It shows the nearest NOAA OVATION grid cell, local modeled cloud and visibility, local time, and low, mid, or high altitude context. Forecasts and event times use the selected place's time zone, with UTC retained on event rows. Local latitude and altitude are broad context only; global NOAA indices are not site-level predictions, and no radiation dose is estimated. A Google Maps URL opens the selected point without a Maps API key.

City searches go to Open-Meteo's geocoding service. Selected browser or manual coordinates are sent to Open-Meteo to fetch local weather and resolve the coordinate time zone; they are not sent to NOAA or NASA. Location and altitude preferences are also held in this tab's session storage and can be cleared from the location card. A manual IANA time zone takes precedence over the API result.

The source presentation also describes a broader product architecture: Next.js/React Native, a grounded LLM API, FastAPI, Supabase, offline caching, and localized alert routing. Those remain labeled as blueprint items; this standalone browser build does not connect to those services or claim to provide an LLM-generated confidence score.

All data is informational. Use official SWPC bulletins and the procedures of your organization for operational decisions.
