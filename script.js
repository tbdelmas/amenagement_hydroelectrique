/* ============================================================
   Gribo-Popoli — logique interactive
   Dépendances : Leaflet, Leaflet.markercluster, data.js (APP_DATA)
   Pour ajouter un point : pousser un objet dans APP_DATA.bornes
   ou APP_DATA.sites (champs min. : id, nom, lat, lng, categorie).
   ============================================================ */

(function () {
  "use strict";

  const D = window.APP_DATA;
  if (!D) {
    document.body.innerHTML = "<p style='padding:2rem;font-family:sans-serif'>Fichier data.js introuvable.</p>";
    return;
  }

  /* ---------- État ---------- */
  const state = {
    view: "map",
    query: "",
    categorie: "all",
    selectedId: null,
    basemap: "satellite",
    ayantsQuery: "",
    ayantsResidence: "",
  };

  /* Index unique de tous les objets cartographiés */
  const places = [];

  D.sites.forEach(function (s) { places.push(s); });
  places.push(D.parcelle);
  D.bornes.forEach(function (b) { places.push(b); });

  const byId = {};
  places.forEach(function (p) { byId[p.id] = p; });

  /* ---------- Helpers ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fold(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  }

  function fmtFr(n, d) {
    if (n == null || n === "") return "—";
    return Number(n).toLocaleString("fr-FR", {
      minimumFractionDigits: d == null ? 2 : d,
      maximumFractionDigits: d == null ? 2 : d,
    });
  }

  function ha(m2) {
    if (m2 == null) return "—";
    return fmtFr(m2 / 10000, 4) + " ha";
  }

  function matchesPlace(p, q, cat) {
    if (cat && cat !== "all" && p.categorie !== cat) return false;
    if (!q) return true;
    const blob = fold([
      p.nom, p.id, p.n, p.borne, p.code, p.exploitant,
      p.territoire, p.sous_type, p.statut, p.description
    ].join(" "));
    return blob.indexOf(q) !== -1;
  }

  function catLabel(c) {
    return { borne: "Borne", parcelle: "Parcelle", infrastructure: "Site" }[c] || c;
  }

  /* ---------- Stats d'en-tête ---------- */
  function renderStats() {
    const haTot = (D.meta.superficie_ayants_m2 || 0) / 10000;
    document.getElementById("top-stats").innerHTML =
      stat(D.meta.n_bornes, "bornes") +
      stat(D.meta.n_ayants, "ayants droit") +
      stat(fmtFr(haTot, 1) + " ha", "Soubouo") +
      stat("112 MW", "Gribo-Popoli");
  }
  function stat(v, l) {
    return '<div class="stat"><b>' + esc(String(v)) + "</b><span>" + esc(l) + "</span></div>";
  }

  /* ---------- Carte ---------- */
  const sat = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tuiles &copy; Esri", maxZoom: 19 }
  );
  const satRef = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}",
    { attribution: "", maxZoom: 19, pane: "overlayPane" }
  );
  const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap",
    maxZoom: 19,
  });
  const light = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OSM &copy; CARTO",
    maxZoom: 19,
  });

  const map = L.map("map", {
    zoomControl: true,
    layers: [sat, satRef],
    worldCopyJump: false,
  });

  const basemaps = {
    satellite: [sat, satRef],
    osm: [osm],
    light: [light],
  };

  function setBasemap(key) {
    state.basemap = key;
    Object.keys(basemaps).forEach(function (k) {
      basemaps[k].forEach(function (ly) { map.removeLayer(ly); });
    });
    basemaps[key].forEach(function (ly) { ly.addTo(map); });
    document.querySelectorAll("[data-basemap]").forEach(function (b) {
      b.classList.toggle("is-active", b.getAttribute("data-basemap") === key);
    });
  }

  /* Couches métier */
  const bornesCluster = L.markerClusterGroup({
    maxClusterRadius: 48,
    disableClusteringAtZoom: 16,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    iconCreateFunction: function (cluster) {
      const n = cluster.getChildCount();
      const size = n < 12 ? "s" : n < 40 ? "m" : "l";
      return L.divIcon({
        html: '<div class="cls cls-' + size + '">' + n + "</div>",
        className: "cls-wrap",
        iconSize: [44, 44],
      });
    },
  });

  const parcelleLayer = L.layerGroup();
  const sitesLayer = L.layerGroup();
  const markersById = {};

  function borneIcon(selected) {
    return L.divIcon({
      className: "",
      html:
        '<div style="width:' + (selected ? 14 : 10) + "px;height:" + (selected ? 14 : 10) +
        "px;border-radius:50%;background:#c4a35a;border:2px solid " +
        (selected ? "#fff" : "#1a1408") +
        ';box-shadow:0 0 0 3px rgba(196,163,90,' + (selected ? "0.45" : "0.25") +
        ');"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function siteIcon(p) {
    const kind = p.sous_type || "dam";
    return L.divIcon({
      className: "",
      html: '<div class="pin ' + esc(kind) + '"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  /* Bornes */
  D.bornes.forEach(function (b) {
    const m = L.marker([b.lat, b.lng], { icon: borneIcon(false), title: b.nom });
    m.on("click", function () { selectPlace(b.id, true); });
    m.bindPopup("<strong>" + esc(b.nom) + "</strong><br>n° " + b.n +
      "<br>" + b.lat.toFixed(6) + ", " + b.lng.toFixed(6));
    markersById[b.id] = m;
    bornesCluster.addLayer(m);
  });

  /* Parcelle GN-001 */
  const ring = D.parcelle.sommets.map(function (s) { return [s.lat, s.lng]; });
  const poly = L.polygon(ring, {
    color: "#7fd1c3",
    weight: 2,
    fillColor: "#7fd1c3",
    fillOpacity: 0.28,
  }).on("click", function () { selectPlace(D.parcelle.id, true); });
  poly.bindPopup("<strong>" + esc(D.parcelle.nom) + "</strong>");
  parcelleLayer.addLayer(poly);

  D.parcelle.sommets.forEach(function (s) {
    const cm = L.circleMarker([s.lat, s.lng], {
      radius: 4,
      color: "#0b1411",
      weight: 1,
      fillColor: "#7fd1c3",
      fillOpacity: 1,
    });
    cm.bindPopup("Sommet " + s.sommet + "<br>X " + s.utm_x + " · Y " + s.utm_y);
    parcelleLayer.addLayer(cm);
  });

  const parcelleCentroid = L.marker([D.parcelle.lat, D.parcelle.lng], {
    icon: L.divIcon({
      className: "",
      html: '<div class="pin" style="background:#7fd1c3;border-radius:3px;transform:none"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    }),
    title: D.parcelle.nom,
  }).on("click", function () { selectPlace(D.parcelle.id, true); });
  markersById[D.parcelle.id] = parcelleCentroid;
  parcelleLayer.addLayer(parcelleCentroid);

  /* Sites */
  D.sites.forEach(function (s) {
    const m = L.marker([s.lat, s.lng], { icon: siteIcon(s), title: s.nom, zIndexOffset: 600 });
    m.on("click", function () { selectPlace(s.id, true); });
    m.bindPopup("<strong>" + esc(s.nom) + "</strong>");
    markersById[s.id] = m;
    sitesLayer.addLayer(m);
  });

  map.addLayer(bornesCluster);
  map.addLayer(parcelleLayer);
  map.addLayer(sitesLayer);

  const allBounds = L.latLngBounds(D.bornes.map(function (b) { return [b.lat, b.lng]; }));
  D.sites.forEach(function (s) { allBounds.extend([s.lat, s.lng]); });
  allBounds.extend([D.parcelle.lat, D.parcelle.lng]);
  map.fitBounds(allBounds, { padding: [40, 40] });

  map.on("mousemove", function (e) {
    document.getElementById("coord-readout").textContent =
      e.latlng.lat.toFixed(6) + "° N  " + Math.abs(e.latlng.lng).toFixed(6) + "° O  ·  WGS84";
  });

  /* ---------- Liste latérale ---------- */
  const listEl = document.getElementById("place-list");

  function renderList() {
    const q = fold(state.query);
    const cat = state.categorie;
    const frag = document.createDocumentFragment();
    let n = 0;

    places.forEach(function (p) {
      if (!matchesPlace(p, q, cat)) return;
      /* Sans recherche, on n'affiche pas les 450 bornes (trop long) :
         sites + parcelle + bornes filtrées uniquement. */
      if (!q && cat === "all" && p.categorie === "borne") return;
      n += 1;
      const el = document.createElement("div");
      el.className = "place cat-" + p.categorie + (p.id === state.selectedId ? " is-selected" : "");
      el.setAttribute("role", "listitem");
      el.dataset.id = p.id;
      const sub = p.categorie === "borne"
        ? p.lat.toFixed(6) + ", " + p.lng.toFixed(6)
        : (p.exploitant || p.sous_type || p.statut || "");
      el.innerHTML =
        '<span class="mark"></span>' +
        '<div><div class="name">' + esc(p.nom) + '</div>' +
        '<div class="sub">' + esc(sub) + "</div></div>" +
        '<div class="tag">' + esc(catLabel(p.categorie)) + "</div>";
      frag.appendChild(el);
    });

    const hiddenBornes = !q && cat === "all" ? D.bornes.length : 0;
    const visibleBornes = (cat === "all" || cat === "borne")
      ? D.bornes.filter(function (b) { return matchesPlace(b, q, cat); }).length
      : 0;

    listEl.innerHTML = "";
    listEl.appendChild(frag);

    if (hiddenBornes && n > 0) {
      const hint = document.createElement("div");
      hint.className = "place";
      hint.style.cursor = "default";
      hint.innerHTML =
        '<span class="mark"></span><div><div class="name">' + hiddenBornes +
        " bornes sur la carte</div><div class=\"sub\">Tapez un n° pour les lister</div></div>";
      listEl.appendChild(hint);
    }

    if (n === 0 && !(hiddenBornes && !q)) {
      listEl.innerHTML = '<p style="color:#8fa39b;padding:12px;font-size:13px">Aucun résultat.</p>';
    }

    const totalMatch = places.filter(function (p) { return matchesPlace(p, q, cat); }).length;
    document.getElementById("list-count").textContent = totalMatch + " élément" + (totalMatch > 1 ? "s" : "");
  }

  listEl.addEventListener("click", function (e) {
    const row = e.target.closest(".place");
    if (!row || !row.dataset.id) return;
    selectPlace(row.dataset.id, true);
  });

  /* ---------- Détail ---------- */
  const detail = document.getElementById("detail");
  const detailBody = document.getElementById("detail-body");

  function kv(label, value) {
    if (value == null || value === "") return "";
    return "<tr><th>" + esc(label) + "</th><td>" + value + "</td></tr>";
  }

  function renderDetail(p) {
    if (!p) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;

    const gmaps = "https://www.google.com/maps?q=" + p.lat + "," + p.lng;
    const geo = p.lat.toFixed(8) + ", " + p.lng.toFixed(8);

    let extra = "";
    if (p.categorie === "borne") {
      extra =
        kv("N° listing", p.n) +
        kv("Identifiant borne", p.borne) +
        kv("Latitude DMS", esc(p.lat_dms)) +
        kv("Longitude DMS", esc(p.lng_dms)) +
        kv("UTM X (Easting)", fmtFr(p.utm_x, 2) + " m") +
        kv("UTM Y (Northing)", fmtFr(p.utm_y, 2) + " m") +
        kv("Statut", esc(p.statut));
    } else if (p.categorie === "parcelle") {
      extra =
        kv("Code", esc(p.code)) +
        kv("Exploitant", esc(p.exploitant)) +
        kv("Droit coutumier", esc(p.detenteur_coutumier)) +
        kv("Territoire", esc(p.territoire)) +
        kv("Sous-préfecture", esc(p.sous_prefecture)) +
        kv("Département", esc(p.departement)) +
        kv("Sommets", p.n_sommets) +
        kv("CRS origine", esc(p.crs)) +
        kv("Échelle du plan", esc(p.echelle)) +
        kv("Voisins indiqués", esc((p.voisins || []).join(" · ")));
    } else {
      extra =
        kv("Type", esc(p.sous_type)) +
        kv("Statut", esc(p.statut)) +
        kv("Puissance", p.puissance_mw ? p.puissance_mw + " MW" : "") +
        kv("Cours d'eau", esc(p.cours_eau)) +
        kv("Maître d'ouvrage", esc(p.maitre_ouvrage)) +
        kv("Études", esc(p.etudes));
    }

    const alerte = p.alerte ? '<div class="alert">' + esc(p.alerte) + "</div>" : "";

    detailBody.innerHTML =
      '<p class="kicker">' + esc(catLabel(p.categorie)) + "</p>" +
      "<h2>" + esc(p.nom) + "</h2>" +
      alerte +
      (p.description ? "<p>" + esc(p.description) + "</p>" : "") +
      '<table class="kv">' +
        kv("Latitude", p.lat.toFixed(8) + " °") +
        kv("Longitude", p.lng.toFixed(8) + " °") +
        kv("WGS84", esc(geo)) +
        extra +
        kv("Source", esc(p.source)) +
      "</table>" +
      '<div class="actions">' +
        '<button type="button" class="btn primary" id="btn-copy">Copier WGS84</button>' +
        '<a class="btn" href="' + gmaps + '" target="_blank" rel="noopener">Google Maps</a>' +
      "</div>";

    const copyBtn = document.getElementById("btn-copy");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(geo).then(function () {
          copyBtn.textContent = "Copié";
          setTimeout(function () { copyBtn.textContent = "Copier WGS84"; }, 1200);
        });
      });
    }
  }

  function selectPlace(id, fly) {
    const p = byId[id];
    if (!p) return;
    state.selectedId = id;
    renderDetail(p);
    renderList();

    document.querySelectorAll(".place").forEach(function (el) {
      el.classList.toggle("is-selected", el.dataset.id === id);
    });

    const m = markersById[id];
    if (fly && p.lat != null) {
      const z = p.categorie === "borne" ? 17 : 15;
      map.flyTo([p.lat, p.lng], Math.max(map.getZoom(), z), { duration: 0.7 });
      if (m) {
        if (bornesCluster.hasLayer(m)) bornesCluster.zoomToShowLayer(m, function () {
          m.openPopup();
        });
        else m.openPopup();
      } else if (p.categorie === "parcelle") {
        poly.openPopup();
      }
    }
  }

  document.getElementById("detail-close").addEventListener("click", function () {
    state.selectedId = null;
    detail.hidden = true;
    renderList();
  });

  /* ---------- Recherche / filtres ---------- */
  const search = document.getElementById("search");
  const clearBtn = document.getElementById("btn-clear-search");

  search.addEventListener("input", function () {
    state.query = search.value.trim();
    clearBtn.hidden = !state.query;
    renderList();
  });
  clearBtn.addEventListener("click", function () {
    search.value = "";
    state.query = "";
    clearBtn.hidden = true;
    renderList();
    search.focus();
  });

  document.getElementById("filters").addEventListener("click", function (e) {
    const btn = e.target.closest("[data-cat]");
    if (!btn) return;
    state.categorie = btn.getAttribute("data-cat");
    document.querySelectorAll("#filters .chip").forEach(function (c) {
      c.classList.toggle("is-active", c === btn);
    });
    renderList();
  });

  document.getElementById("btn-fit").addEventListener("click", function () {
    map.fitBounds(allBounds, { padding: [40, 40] });
  });

  document.getElementById("ly-bornes").addEventListener("change", function (e) {
    if (e.target.checked) map.addLayer(bornesCluster); else map.removeLayer(bornesCluster);
  });
  document.getElementById("ly-parcelle").addEventListener("change", function (e) {
    if (e.target.checked) map.addLayer(parcelleLayer); else map.removeLayer(parcelleLayer);
  });
  document.getElementById("ly-sites").addEventListener("change", function (e) {
    if (e.target.checked) map.addLayer(sitesLayer); else map.removeLayer(sitesLayer);
  });

  document.querySelector(".basemap-switch").addEventListener("click", function (e) {
    const btn = e.target.closest("[data-basemap]");
    if (btn) setBasemap(btn.getAttribute("data-basemap"));
  });

  /* ---------- GeoJSON ---------- */
  document.getElementById("btn-geojson").addEventListener("click", function () {
    const fc = {
      type: "FeatureCollection",
      name: "Bornes Gribo-Popoli",
      crs: { type: "name", properties: { name: "EPSG:4326" } },
      features: D.bornes.map(function (b) {
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [b.lng, b.lat] },
          properties: {
            n: b.n, borne: b.borne, statut: b.statut,
            lat_dms: b.lat_dms, lng_dms: b.lng_dms,
            utm_x: b.utm_x, utm_y: b.utm_y, utm_zone: "29N"
          }
        };
      })
    };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bornes-gribo-popoli.geojson";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------- Vues ---------- */
  function setView(name) {
    state.view = name;
    document.querySelectorAll(".view-switch button").forEach(function (b) {
      const on = b.getAttribute("data-view") === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll(".workspace").forEach(function (w) {
      const on = w.id === "view-" + name;
      w.classList.toggle("is-active", on);
      w.hidden = !on;
    });
    if (name === "map") setTimeout(function () { map.invalidateSize(); }, 80);
    closeSidebar();
  }

  document.querySelector(".view-switch").addEventListener("click", function (e) {
    const btn = e.target.closest("[data-view]");
    if (btn) setView(btn.getAttribute("data-view"));
  });

  /* ---------- Sidebar mobile ---------- */
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("backdrop");
  document.getElementById("btn-sidebar").addEventListener("click", function () {
    const open = !sidebar.classList.contains("is-open");
    sidebar.classList.toggle("is-open", open);
    backdrop.hidden = !open;
  });
  backdrop.addEventListener("click", closeSidebar);
  function closeSidebar() {
    sidebar.classList.remove("is-open");
    backdrop.hidden = true;
  }

  /* ---------- Table ayants droit ---------- */
  const tbody = document.querySelector("#ayants-table tbody");
  const resSel = document.getElementById("ayants-residence");
  const residences = Array.from(new Set(D.ayants.map(function (a) { return a.residence; }))).sort();
  residences.forEach(function (r) {
    const o = document.createElement("option");
    o.value = r; o.textContent = r;
    resSel.appendChild(o);
  });

  function renderAyants() {
    const q = fold(state.ayantsQuery);
    const res = state.ayantsResidence;
    const frag = document.createDocumentFragment();
    let n = 0, surf = 0;
    D.ayants.forEach(function (a) {
      if (res && a.residence !== res) return;
      if (q) {
        const blob = fold([a.code, a.nom, a.residence, a.culture, a.heritiers, a.detenteur_coutumier].join(" "));
        if (blob.indexOf(q) === -1) return;
      }
      n += 1;
      surf += a.superficie_m2 || 0;
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + a.n + "</td>" +
        '<td class="mono">' + esc(a.code) + "</td>" +
        "<td>" + esc(a.nom) + "</td>" +
        "<td>" + esc(a.residence) + "</td>" +
        '<td class="mono">' + fmtFr(a.superficie_m2, 2) + " m²<br>" + ha(a.superficie_m2) + "</td>" +
        "<td>" + esc(a.culture) + "</td>" +
        "<td>" + esc(a.heritiers || "—") + "</td>" +
        "<td>" + esc(a.detenteur_coutumier || "—") + "</td>";
      frag.appendChild(tr);
    });
    tbody.innerHTML = "";
    tbody.appendChild(frag);
    document.getElementById("ayants-foot").textContent =
      n + " parcelle" + (n > 1 ? "s" : "") + " · " + fmtFr(surf, 0) + " m² · " + ha(surf) +
      "  —  les parcelles SO-… n’ont pas de GPS dans le listing (voir l’onglet Données).";
  }

  document.getElementById("ayants-search").addEventListener("input", function (e) {
    state.ayantsQuery = e.target.value.trim();
    renderAyants();
  });
  resSel.addEventListener("change", function (e) {
    state.ayantsResidence = e.target.value;
    renderAyants();
  });

  /* ---------- Infos sources ---------- */
  const ul = document.getElementById("info-sources");
  (D.meta.sources || []).forEach(function (s) {
    const li = document.createElement("li");
    li.textContent = s;
    ul.appendChild(li);
  });

  /* ---------- Raccourci / ---------- */
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      setView("map");
      search.focus();
    }
    if (e.key === "Escape") {
      detail.hidden = true;
      closeSidebar();
    }
  });

  /* ---------- Init ---------- */
  renderStats();
  renderList();
  renderAyants();
})();
