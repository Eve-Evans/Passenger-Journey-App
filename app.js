//JavaScript code for Passenger Journey Display App
// This code uses the Google Maps Routes API to calculate driving routes
const $ = (id) => document.getElementById(id);
let RouteClass = null;
let map = null;
let destinationMarker = null;
let routeLines = [];
let availableRoutes = [];
let selectedRouteIndex = 0;
let destinationLocation = null;
let journeyActive = false;
let updateTimer = null;
let stopNames = [];
let isUpdating = false;
let latestRequestId = 0;
let selectedDestinationText = "";
let journeyDestinationName = "";
let journeyDestination = null;

// Baseline is captured once when Start Journey is pressed.
// Delay compares the latest ETA with this original ETA.
let journeyStartedAt = null;
let baselineArrivalAt = null;
const JOURNEY_STORAGE_KEY = "passengerJourneyActiveState";
const routeColours = ["#55d6be", "#ffb84d", "#e879f9", "#60a5fa"];

//---------------------------------------------------------------------------------------------
// Google Maps calls this after the API loads.
async function initGoogleMaps() {
  try {
    const libraries = await Promise.all([
      google.maps.importLibrary("maps"),
      google.maps.importLibrary("routes")
    ]);

    const { Map } = libraries[0];
    RouteClass = libraries[1].Route;

    map = new Map($("map"), {
      center: { lat: 52.2, lng: -1.9 },
      zoom: 7,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true
    });

    window.MapMarker = google.maps.Marker;

    // Allow the user to choose an exact destination by clicking the map.
    map.addListener("click", async (event) => {
      if (journeyActive || !event.latLng) return;

      destinationLocation = event.latLng;

      const lat = event.latLng.lat();
      const lng = event.latLng.lng();

      const coordinates = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

      // Coordinates are for routing only.
      $("destinationInput").value = coordinates;
      selectedDestinationText = coordinates;

      placeDestinationMarker(
        window.MapMarker,
        destinationLocation
      );

      await previewRoutes();
    });

    window.MapPolyline = google.maps.Polyline;
    window.MapMarker = google.maps.Marker;

    setMessage("Google Maps is ready. Search for a destination.");
  } catch (error) {
    console.error(error);
    setMessage(
      "Google Maps could not load. Check your API key and enabled APIs."
    );
  }
}
//---------------------------------------------------------------------------------------------
// Request a screen wake lock to keep the display on during the journey.
let wakeLock = null;

async function requestWakeLock() {
    if (!("wakeLock" in navigator)) {
        console.log("Screen Wake Lock is not supported by this browser.");
        return;
    }

    try {
        wakeLock = await navigator.wakeLock.request("screen");

        wakeLock.addEventListener("release", () => {
            wakeLock = null;
        });
    } catch (error) {
        console.log("Could not keep the screen awake:", error);
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
    }
}

document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && journeyActive) {
        await requestWakeLock();
    }
});
//---------------------------------------------------------------------------------------------
// Expose the initGoogleMaps function to the global scope for the Google Maps API callback.
window.initGoogleMaps = initGoogleMaps;
//---------------------------------------------------------------------------------------------
// Display a status message to the user.
function setMessage(message) {
  $("statusMessage").textContent = message;
}
//---------------------------------------------------------------------------------------------
// Format a Date object as a 24-hour time string (HH:MM).
function clockTime(date) {
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}
//---------------------------------------------------------------------------------------------
// Calculate a future Date object by adding seconds to the current time.
function arrivalFrom(seconds) {
  return new Date(Date.now() + seconds * 1000);
}
//---------------------------------------------------------------------------------------------
// Convert seconds to whole minutes, rounding up and ensuring a minimum of 0.
function minutesFrom(seconds) {
  return Math.max(0, Math.ceil(seconds / 60));
}
//---------------------------------------------------------------------------------------------
// Format a delay in minutes as a string for display.
function formatDelay(minutes) {
  if (minutes > 0) return `+${minutes} MIN`;
  if (minutes < 0) return `${minutes} MIN`;
  return "ON TIME";
}
//---------------------------------------------------------------------------------------------
// Render the arrival delay indicator based on the current predicted arrival time.
function renderDelay(currentArrivalAt) {
  const arrivalDelay = $("arrivalDelay");
  const apology = document.getElementById("delayApology");

  // The arrival delay indicator must exist in the HTML.
  if (!arrivalDelay) return;

  if (!baselineArrivalAt || !currentArrivalAt) {
    arrivalDelay.textContent = "CALCULATING";
    arrivalDelay.className = "arrival-delay unknown";
    return;
  }

  const differenceMinutes = Math.round(
    (currentArrivalAt.getTime() - baselineArrivalAt.getTime()) / 60000
  );

  if (apology) {
      apology.hidden = differenceMinutes <= 1;
  }

  if (differenceMinutes > 1) {
    arrivalDelay.textContent = `+${differenceMinutes} MIN`;
    arrivalDelay.className = "arrival-delay delayed";
  } else if (differenceMinutes < -1) {
    arrivalDelay.textContent = `${differenceMinutes} MIN`;
    arrivalDelay.className = "arrival-delay early";
  } else {
    arrivalDelay.textContent = "ON TIME";
    arrivalDelay.className = "arrival-delay on-time";
  }
}
//---------------------------------------------------------------------------------------------
// Save the current journey state to localStorage for persistence across page reloads.
function saveJourneyState() {
  if (!journeyActive || !journeyStartedAt || !baselineArrivalAt) return;
  try {
    localStorage.setItem(JOURNEY_STORAGE_KEY, JSON.stringify({
      journeyStartedAt: journeyStartedAt.toISOString(),
      baselineArrivalAt: baselineArrivalAt.toISOString(),
      destinationName: journeyDestinationName
    }));
  } catch (error) {
    console.warn("Could not save journey state.", error);
  }
}
//---------------------------------------------------------------------------------------------
// Clear the saved journey state from localStorage when the journey ends.
function clearSavedJourneyState() {
  try {
    localStorage.removeItem(JOURNEY_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear saved journey state.", error);
  }
}
//---------------------------------------------------------------------------------------------
// Retrieve the names and locations of all drop-off stops from the input rows.
function getStopNames() {
  return [...document.querySelectorAll(".stop-input-row")]
    .map((row) => ({
      name: row.querySelector(".stop-name-input").value.trim(),
      location: row._selectedLocation ||
        row.querySelector(".stop-input").value.trim()
    }))
    .filter((stop) => stop.location);
}
//---------------------------------------------------------------------------------------------
// Create a Google Map for a specific stop input row, allowing the user to select a location by clicking on the map. 
function createStopMap(row, mapElement) {
  if (!window.google?.maps || !map) return;

  const stopMap = new google.maps.Map(mapElement, {
    center: map.getCenter(),
    zoom: 10,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false
  });

  row._stopMarker = null;
  row._stopMap = stopMap;

  stopMap.addListener("click", (event) => {
    if (!event.latLng || journeyActive) return;

    const location = event.latLng;
    const lat = location.lat();
    const lng = location.lng();

    row._selectedLocation = location;

    row.querySelector(".stop-input").value =
      `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

    if (row._stopMarker) {
      row._stopMarker.setMap(null);
    }

    row._stopMarker = new google.maps.Marker({
      map: stopMap,
      position: location,
      title:
        row.querySelector(".stop-name-input").value.trim()
        || "Selected stop"
    });

    stopMap.setCenter(location);
    stopMap.setZoom(13);

    setMessage(
      "Stop location selected. Find routes again to update your journey."
    );
  });
}
// ---------------------------------------------------------------------------------------------
// Update the pins on each stop's map based on the calculated route.
function updateStopMapPins(route) {
  const rows = [
    ...document.querySelectorAll(".stop-input-row")
  ];

  rows.forEach((row, index) => {
    const leg = route.legs?.[index];

    // A clicked map location takes priority.
    // Otherwise, use the endpoint from the calculated route.
    const location =
      row._selectedLocation || leg?.endLocation;

    if (!location || !row._stopMap) return;

    if (row._stopMarker) {
      row._stopMarker.setMap(null);
    }

    const stopName =
      row.querySelector(".stop-name-input").value.trim()
      || `Stop ${index + 1}`;

    row._stopMarker = new google.maps.Marker({
      map: row._stopMap,
      position: location,
      title: stopName
    });

    row._stopMap.setCenter(location);
    row._stopMap.setZoom(13);
  });
}
//---------------------------------------------------------------------------------------------
// Add a new drop-off stop input row to the form.
function addStopInput() {
  const row = document.createElement("div");
  row.className = "stop-input-row";
  row._selectedLocation = null;

  const details = document.createElement("details");
  details.className = "stop-dropdown";

  const summary = document.createElement("summary");
  summary.textContent =
    `Drop-off ${$("stopInputs").children.length + 1}`;

  const contents = document.createElement("div");
  contents.className = "stop-dropdown-content";

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Stop display name";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "stop-name-input";
  nameInput.placeholder = "e.g. Pershore Train Station";
  nameInput.required = true;

  const locationLabel = document.createElement("label");
  locationLabel.textContent = "Stop address or map coordinates";

  const locationInput = document.createElement("input");
  locationInput.type = "text";
  locationInput.className = "stop-input";
  locationInput.placeholder = "Enter an address or select the map";
  locationInput.required = true;

  const addressRow = document.createElement("div");
  addressRow.className = "search-row";

  const enterButton = document.createElement("button");
  enterButton.type = "button";
  enterButton.textContent = "Enter";
  enterButton.className = "button primary";

  enterButton.addEventListener("click", async () => {
      const locationInput = row.querySelector(".stop-input");
      const nameInput = row.querySelector(".stop-name-input");

      if (!locationInput || !locationInput.value.trim()) {
          alert("Please enter an address for this stop.");
          locationInput?.focus();
          return;
      }

      if (nameInput && !nameInput.value.trim()) {
          alert("Please enter a name for this stop.");
          nameInput.focus();
          return;
      }

      await previewRoutes();
  });

  addressRow.append(locationInput, enterButton);

  const mapLabel = document.createElement("p");
  mapLabel.className = "help-text";
  mapLabel.textContent = "Click the map to select this stop.";

  const mapElement = document.createElement("div");
  mapElement.className = "journey-map stop-map";
  mapElement.style.height = "220px";

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "button secondary";
  removeButton.textContent = "Remove stop";

  removeButton.addEventListener("click", () => {
    row.remove();
    renumberStopInputs();
  });

  nameInput.addEventListener("input", () => {
    summary.textContent = nameInput.value.trim() ||
      `Drop-off ${[...document.querySelectorAll(".stop-input-row")]
        .indexOf(row) + 1}`;
  });

  contents.append(
    nameLabel,
    nameInput,
    locationLabel,
    addressRow,
    mapLabel,
    mapElement,
    removeButton
  );

  details.append(summary, contents);

  details.addEventListener("toggle", () => {
  if (details.open && row._stopMap) {
    google.maps.event.trigger(row._stopMap, "resize");

    const location =
      row._selectedLocation ||
      row._stopMarker?.getPosition();

    if (location) {
      row._stopMap.setCenter(location);
    }
  }
});

  row.appendChild(details);
  $("stopInputs").appendChild(row);

  createStopMap(row, mapElement);
}
//---------------------------------------------------------------------------------------------
// Renumber the drop-off stop labels after adding or removing stops.
function renumberStopInputs() {
  [...document.querySelectorAll(".stop-input-row")].forEach((row, index) => {
    row.querySelector("label").textContent = `Drop-off ${index + 1}`;
  });
}
//---------------------------------------------------------------------------------------------
$("addStopButton").addEventListener("click", addStopInput);
//---------------------------------------------------------------------------------------------
// Place a marker on the map for the selected destination.
function placeDestinationMarker(MarkerClass, location) {
  if (destinationMarker) {
    destinationMarker.setMap(null);
  }

  destinationMarker = new MarkerClass({
    map: map,
    position: location,
    title: "Selected destination"
  });
}
//---------------------------------------------------------------------------------------------
// Clear any existing route lines from the map.
function clearRouteLines() {
  routeLines.forEach((line) => line.setMap(null));
  routeLines = [];
}
//---------------------------------------------------------------------------------------------
// Draw the available routes on the map and set up click handlers for route selection.
function drawRoutes() {
  clearRouteLines();

  if (!map || !availableRoutes.length) return;

  availableRoutes.forEach((route, index) => {
    if (!route.path) return;

    const line = new window.MapPolyline({
      map,
      path: route.path,
      strokeColor: routeColours[index % routeColours.length],
      strokeOpacity: index === selectedRouteIndex ? 1 : 0.55,
      strokeWeight: index === selectedRouteIndex ? 8 : 5,
      zIndex: index === selectedRouteIndex ? 10 : 1
    });

    line.addListener("click", () => {
      selectedRouteIndex = index;
      renderRouteChoices();
      drawRoutes();
    });

    routeLines.push(line);
  });

  const bounds = new google.maps.LatLngBounds();

  if (destinationMarker) {
    bounds.extend(destinationMarker.getPosition());
  }

  availableRoutes.forEach((route) => {
    (route.path || []).forEach((point) => bounds.extend(point));
  });

  if (!bounds.isEmpty()) {
    map.fitBounds(bounds, 50);
  }
}
//---------------------------------------------------------------------------------------------
// Render the route choice buttons based on the available routes.
function renderRouteChoices() {
  const section = $("routeChoicesSection");
  const container = $("routeChoices");
  const message = $("routeMessage");
  const startButton = $("startJourneyButton");

  container.replaceChildren();

  if (!availableRoutes.length) {
    section.hidden = true;
    startButton.hidden = true;
    startButton.disabled = true;
    return;
  }

  section.hidden = false;
  startButton.hidden = false;
  startButton.disabled = false;

  if (stopNames.length > 0) {
    message.textContent =
      "Drop-off stops are followed in order. Alternative routes may not be available.";
  } else if (availableRoutes.length === 1) {
    message.textContent =
      "Google returned one route for this journey.";
  } else {
    message.textContent =
      "Select a route card or click a coloured line on the map.";
  }

  availableRoutes.forEach((route, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-choice";

    const selected = index === selectedRouteIndex;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));

    const title = document.createElement("strong");
    title.textContent =
      index === 0 ? "Route 1 — Suggested" : `Route ${index + 1}`;

    const duration = document.createElement("span");
    duration.textContent =
      `${minutesFrom((route.durationMillis || 0) / 1000)} min`;

    const distance = document.createElement("span");
    distance.textContent =
      `${((route.distanceMeters || 0) / 1609.344).toFixed(1)} miles`;

    button.append(title, duration, distance);

    button.addEventListener("click", () => {
      selectedRouteIndex = index;
      renderRouteChoices();
      drawRoutes();
    });

    container.appendChild(button);
  });
}
//---------------------------------------------------------------------------------------------
// Get the user's current position using the Geolocation API.
async function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser does not support location services."));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => resolve({
        lat: position.coords.latitude,
        lng: position.coords.longitude
      }),
      (error) => {
        const messages = {
          1: "Location permission was denied. Allow location access in your browser.",
          2: "Your current location is unavailable. Check location settings.",
          3: "Finding your location took too long. Please try again."
        };

        reject(new Error(messages[error.code] ||
          "Could not get your current location."));
      },
      {
        enableHighAccuracy: true,
        timeout: 20000,
        maximumAge: 0
      }
    );
  });
}
//---------------------------------------------------------------------------------------------
// Resolve the destination address or selected map point for routing.
async function resolveDestination(address) {
  const typedAddress = address.trim();

  if (!typedAddress) {
    throw new Error("Please enter a destination.");
  }

  // If the user selected a point on the map, use those exact coordinates.
  if (
    destinationLocation &&
    selectedDestinationText === typedAddress
  ) {
    return destinationLocation;
  }

  // Otherwise, send the typed address directly to Google Routes.
  destinationLocation = null;
  selectedDestinationText = "";

  return typedAddress;
}
//---------------------------------------------------------------------------------------------
// Calculate routes from the origin to the destination, optionally including drop-off stops.
async function calculateRoutes(origin, destination) {
  const request = {
    origin,
    destination,
    travelMode: "DRIVING",
    routingPreference: "TRAFFIC_AWARE",
    departureTime: new Date(Date.now() + 2 * 60 * 1000),
    computeAlternativeRoutes: stopNames.length === 0,
    fields: [
      "path",
      "viewport",
      "durationMillis",
      "distanceMeters",
      "legs"
    ]
  };

  if (stopNames.length > 0) {
    request.intermediates = stopNames.map((stop) => ({
      location: stop.location
    }));
    request.optimizeWaypointOrder = false;
  }

  const response = await RouteClass.computeRoutes(request);

  if (!response.routes || !response.routes.length) {
    throw new Error(
      "No route found. Check the destination and drop-off addresses."
    );
  }

  return response.routes;
}
//---------------------------------------------------------------------------------------------
// Preview the available routes based on the current input and map selection.
async function previewRoutes() {
  if (!RouteClass || journeyActive) return;

  const requestId = ++latestRequestId;
  $("startJourneyButton").disabled = true;

  try {
    const routeDestinationText =
      $("destinationInput").value.trim();

    const displayName =
      $("destinationNameInput").value.trim();

    if (!routeDestinationText) {
      setMessage("Please enter a destination or select a point on the map.");
      return;
    }

    // Detect coordinates such as 51.7520, -1.2577.
    const isCoordinates =
      /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(
        routeDestinationText
      );

    if (!displayName && isCoordinates) {
      setMessage("Please enter a destination name to display.");
      $("destinationNameInput").focus();
      return;
    }

    journeyDestinationName = displayName || routeDestinationText;

    // Resolve the actual address or selected map point.
    journeyDestination = await resolveDestination(
      routeDestinationText
    );

    stopNames = getStopNames();

    setMessage("Finding routes from your current location...");

    const origin = await getCurrentPosition();

    const routes = await calculateRoutes(
      origin,
      journeyDestination
    );

    if (requestId !== latestRequestId || journeyActive) return;

    availableRoutes = routes;
    selectedRouteIndex = 0;

    // Add pins to the individual stop maps.
    updateStopMapPins(availableRoutes[0]);

    map.setCenter(origin);
    drawRoutes();
    renderRouteChoices();

    setMessage(
      `Found ${routes.length} route${routes.length === 1 ? "" : "s"}. ` +
      "Choose one, then press Start Journey."
    );

  } catch (error) {
    if (requestId === latestRequestId) {
      availableRoutes = [];
      renderRouteChoices();
      setMessage(error.message || "Could not find routes.");
      console.error("Route preview error:", error);
    }
  } finally {
    if (requestId === latestRequestId) {
      $("startJourneyButton").disabled =
        availableRoutes.length === 0;
    }
  }
}
//---------------------------------------------------------------------------------------------
// Handle the form submission to preview routes without reloading the page.
$("journeyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  await previewRoutes();
});

$("startJourneyButton").addEventListener("click", async () => {
  if (!availableRoutes.length || journeyActive) return;

  requestWakeLock();

  stopNames = getStopNames();
  journeyActive = true;
  latestRequestId++;

  $("setupScreen").hidden = true;
  $("displayScreen").hidden = false;

  // Show the name entered by the user.
  $("destinationDisplay").textContent =
  journeyDestinationName;


  $("gpsStatus").textContent = "● GPS STARTING";
  $("lastUpdated").textContent = "Finding current location...";

  journeyStartedAt = new Date();
  if ($("journeyStartTime")) {
    $("journeyStartTime").textContent = clockTime(journeyStartedAt);
  }

  const selectedRoute = availableRoutes[selectedRouteIndex];
  const initialSeconds = selectedRoute?.durationMillis != null
    ? selectedRoute.durationMillis / 1000
    : 0;
  baselineArrivalAt = initialSeconds > 0
    ? arrivalFrom(initialSeconds)
    : null;
  renderDelay(baselineArrivalAt);
  saveJourneyState();

  // Do not move the map into the live journey screen.
  // The map remains on the planning screen only.
  await updateJourney();

  clearInterval(updateTimer);
  updateTimer = setInterval(updateJourney, 60000); 
});
//---------------------------------------------------------------------------------------------
// Update the journey estimates based on the current location and selected route.
async function updateJourney() {
  if (!journeyActive || isUpdating || !RouteClass) return;

  isUpdating = true;
  const requestId = ++latestRequestId;
  $("gpsStatus").textContent = "● GPS UPDATING";

  try {
    const origin = await getCurrentPosition();
    const routes = await calculateRoutes(origin, journeyDestination);
    if (!journeyActive || requestId !== latestRequestId) return;

    availableRoutes = routes;

    if (selectedRouteIndex >= routes.length) {
      selectedRouteIndex = 0;
    }

        
    const route = availableRoutes[selectedRouteIndex];

    console.log("Selected route:", route);
    console.log("Route durationMillis:", route.durationMillis);
    console.log("Route legs:", route.legs);

    const legs = route.legs || [];
    const durations = legs.map(
      (leg) => (leg.durationMillis || 0) / 1000
    );

    const totalSeconds = route.durationMillis != null
      ? route.durationMillis / 1000
      : durations.reduce((sum, seconds) => sum + seconds, 0);

    console.log("Total journey seconds:", totalSeconds);

    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
      throw new Error(
        "Google Maps returned no valid journey duration."
      );
    }


    const destinationArrival = arrivalFrom(totalSeconds);

    // Compare the latest predicted final arrival with the first ETA captured
    // when the journey started. This avoids comparing against a moving clock.
    renderDelay(destinationArrival);
    saveJourneyState();

    $("destinationArrival").textContent = clockTime(destinationArrival);

    // Always show the time remaining to the FINAL destination.
    $("remainingLabel").textContent = "TIME REMAINING";
    $("destinationRemaining").textContent =
      `${minutesFrom(totalSeconds)} MIN`;

    $("gpsStatus").textContent = "● GPS ACTIVE";
    $("lastUpdated").textContent =
      `ESTIMATES UPDATED ${clockTime(new Date())}`;

    if (stopNames.length > 0) {
      $("stopsDisplay").hidden = false;
      $("nextStopName").textContent =
        stopNames[0].name || "Next stop";
      renderRemainingStops(stopNames);
      const nextStopSeconds = durations[0] ?? 0;
      const nextStopArrival = arrivalFrom(nextStopSeconds);

      $("nextStopArrival").textContent = clockTime(nextStopArrival);
      $("nextStopRemaining").textContent =
        `${minutesFrom(nextStopSeconds)} MIN`;

      $("stopDestinationArrival").textContent =
        clockTime(destinationArrival);
      $("stopDestinationRemaining").textContent =
        `${minutesFrom(totalSeconds)} MIN REMAINING`;
    } else {
      $("stopsDisplay").hidden = true;
    }
  } catch (error) {
    if (journeyActive && requestId === latestRequestId) {
      $("gpsStatus").textContent = "● GPS / ROUTE ISSUE";
      $("lastUpdated").textContent =
        "Could not refresh the journey estimate: " +
        (error.message || error);

      console.error("Journey update failed:", error);
    }
  } finally {
    isUpdating = false;
  }
}
//---------------------------------------------------------------------------------------------
// Render the list of remaining drop-off stops in the journey display.
function renderRemainingStops(stopNames) {
    const section = document.getElementById("remainingStopsSection");
    const list = document.getElementById("remainingStopsList");

    if (!section || !list) return;

    list.replaceChildren();

    const otherStops = stopNames.slice(1);

    section.hidden = otherStops.length === 0;

    otherStops.forEach((stop, index) => {
        const item = document.createElement("div");
        item.className = "remaining-stop-item";

        const number = document.createElement("span");
        number.textContent = `${index + 2}. `;

        const name = document.createElement("span");
        name.textContent = stop.name;

        item.append(number, name);
        list.appendChild(item);
    });
}
//---------------------------------------------------------------------------------------------
// Handle the "Complete Stop" button click to remove the first stop and update the journey.
$("completeStopButton").addEventListener("click", async () => {
  if (!journeyActive || stopNames.length === 0) return;

  const firstRow = $("stopInputs").querySelector(".stop-input-row");

  if (firstRow) firstRow.remove();

  renumberStopInputs();

  stopNames = getStopNames();

  if (stopNames.length === 0) {
    $("stopsDisplay").hidden = true;
  }

  await updateJourney();
});

$("endJourneyButton").addEventListener("click", () => {
  journeyActive = false;
  latestRequestId++;
  clearInterval(updateTimer);
  updateTimer = null;
  stopNames = [];
  availableRoutes = [];
  selectedRouteIndex = 0;
  isUpdating = false;
  journeyStartedAt = null;
  baselineArrivalAt = null;
  clearSavedJourneyState();

  clearRouteLines();

  if (destinationMarker) {
    destinationMarker.setMap(null);
    destinationMarker = null;
  }

  destinationLocation = null;

  $("setupScreen").insertBefore(
    $("map"),
    $("routeChoicesSection")
  );

  $("setupScreen").hidden = false;
  $("displayScreen").hidden = true;
  $("stopsDisplay").hidden = true;

  $("destinationInput").value = "";
  $("stopInputs").replaceChildren();
  $("routeChoices").replaceChildren();
  $("routeChoicesSection").hidden = true;
  $("startJourneyButton").hidden = true;
  $("startJourneyButton").disabled = true;

  $("destinationDisplay").textContent = "NOT SET";
  $("destinationArrival").textContent = "--:--";
  $("destinationRemaining").textContent = "-- MIN";
  $("gpsStatus").textContent = "● GPS WAITING";
  $("journeyStartTime").textContent = "--:--";
  $("delayValue").textContent = "ON TIME";
  $("delayPanel").className = "delay-panel on-time";
  $("lastUpdated").textContent = "Enter a journey to begin.";

  setMessage("Journey ended. Plan another journey when ready.");
  journeyActive = false;

  // Restore the map for the next journey.
  $("map").style.display = "block";

  releaseWakeLock();
});