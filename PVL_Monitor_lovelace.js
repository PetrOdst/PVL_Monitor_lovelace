const DEFAULT_ENTITIES = {
  water_level: "sensor.vd_slapy_pvl_reservoir_slapy_water_level",
  inflow: "sensor.vd_slapy_pvl_reservoir_slapy_inflow",
  outflow: "sensor.vd_slapy_pvl_reservoir_slapy_outflow",
  volume: "sensor.vd_slapy_pvl_reservoir_slapy_volume",
  precipitation_24h: "sensor.vd_slapy_pvl_reservoir_slapy_precipitation_24h",
  air_temperature: "sensor.vd_slapy_pvl_reservoir_slapy_air_temperature",
  reference_difference: null,
};

const ENTITY_OPTIONS = {
  water_level: "level_entity",
  inflow: "inflow_entity",
  outflow: "outflow_entity",
  volume: "volume_entity",
  precipitation_24h: "precipitation_24h_entity",
  air_temperature: "air_temperature_entity",
  reference_difference: "reference_difference_entity",
};

const METRICS = [
  ["inflow", "Přítok", "m³/s", 2],
  ["outflow", "Odtok", "m³/s", 2],
  ["volume", "Objem nádrže", "mil. m³", 2],
  ["precipitation_24h", "Srážky za 24 hodin", "mm", 1],
  ["air_temperature", "Teplota vzduchu", "°C", 1],
];

const SVG_NS = "http://www.w3.org/2000/svg";

class PVLReservoirCard extends HTMLElement {
  setConfig(config) {
    if (!config || typeof config !== "object") {
      throw new Error("A card configuration is required.");
    }

    const minLevel = Number(config.min_level ?? 220);
    const maxLevel = Number(config.max_level ?? 273);
    if (!Number.isFinite(minLevel) || !Number.isFinite(maxLevel) || minLevel >= maxLevel) {
      throw new Error("min_level and max_level must be finite numbers, and min_level must be lower.");
    }

    const legacyEntities = config.entities && typeof config.entities === "object" ? config.entities : {};
    const entities = {};
    Object.entries(ENTITY_OPTIONS).forEach(([key, option]) => {
      const configured = config[option] ?? legacyEntities[key] ?? DEFAULT_ENTITIES[key];
      entities[key] = typeof configured === "string" && configured.trim() ? configured.trim() : null;
    });

    this._config = {
      name: typeof config.name === "string" && config.name.trim() ? config.name.trim() : "VD Slapy",
      minLevel,
      maxLevel,
      entities,
      showHistory: config.show_history !== false,
    };
    this._period = this._period || "day";
    this._lastWaterState = undefined;
    this._historyRequestId = (this._historyRequestId || 0) + 1;
    this._build();
  }

  set hass(hass) {
    this._hass = hass;
    this._updateValues();
  }

  get hass() {
    return this._hass;
  }

  getCardSize() {
    return this._config?.showHistory ? 7 : 4;
  }

  static getStubConfig() {
    return {
      type: "custom:pvl-reservoir-card",
      name: "VD Slapy",
      level_entity: DEFAULT_ENTITIES.water_level,
      inflow_entity: DEFAULT_ENTITIES.inflow,
      outflow_entity: DEFAULT_ENTITIES.outflow,
      volume_entity: DEFAULT_ENTITIES.volume,
      precipitation_24h_entity: DEFAULT_ENTITIES.precipitation_24h,
      air_temperature_entity: DEFAULT_ENTITIES.air_temperature,
      min_level: 220,
      max_level: 273,
    };
  }

  _build() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          color: var(--primary-text-color);
          --pvl-blue: var(--info-color, #2589c8);
          --pvl-blue-deep: #176da8;
          --pvl-surface: var(--secondary-background-color, rgba(127, 127, 127, 0.08));
          --pvl-line: var(--divider-color, rgba(127, 127, 127, 0.24));
        }
        ha-card {
          overflow: hidden;
          padding: clamp(16px, 3vw, 24px);
          border-radius: var(--ha-card-border-radius, 16px);
        }
        .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
        .eyebrow { color: var(--secondary-text-color); font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
        h2 { margin: 4px 0 0; font-size: clamp(1.15rem, 2vw, 1.4rem); font-weight: 650; }
        .source { color: var(--secondary-text-color); font-size: 0.82rem; white-space: nowrap; }
        .overview { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 0.85fr); gap: clamp(18px, 4vw, 38px); align-items: stretch; }
        .level-panel { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 18px; align-items: center; min-height: 210px; }
        .gauge-wrap { display: flex; flex-direction: column; align-items: center; gap: 7px; height: 190px; }
        .gauge-label { color: var(--secondary-text-color); font-size: 0.72rem; font-variant-numeric: tabular-nums; }
        .gauge { position: relative; flex: 1; width: 28px; overflow: hidden; border: 1px solid var(--pvl-line); border-radius: 999px; background: var(--pvl-surface); }
        .gauge-fill { position: absolute; right: 0; bottom: 0; left: 0; height: 0%; border-radius: inherit; background: linear-gradient(0deg, var(--pvl-blue-deep), var(--pvl-blue) 72%, #76c7ee); transition: height 500ms ease; }
        .gauge-fill::before { position: absolute; top: 0; right: -12%; left: -12%; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, 0.55); content: ""; }
        .level-number { min-width: 0; }
        .level-label { color: var(--secondary-text-color); font-size: 0.9rem; }
        .level-value { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-top: 3px; font-size: clamp(2.45rem, 6vw, 4.1rem); font-weight: 700; letter-spacing: -0.055em; line-height: 1.12; font-variant-numeric: tabular-nums; }
        .level-unit { color: var(--secondary-text-color); font-size: 0.98rem; font-weight: 500; letter-spacing: 0; }
        .range-note { min-height: 1.2em; margin-top: 8px; color: var(--secondary-text-color); font-size: 0.82rem; }
        .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; align-content: center; }
        .metric { min-width: 0; padding: 13px 14px; border: 1px solid var(--pvl-line); border-radius: 12px; background: var(--pvl-surface); }
        .metric-label { color: var(--secondary-text-color); font-size: 0.78rem; }
        .metric-value { overflow: hidden; margin-top: 5px; font-size: clamp(1.05rem, 2vw, 1.3rem); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .metric-unit { color: var(--secondary-text-color); font-size: 0.76rem; font-weight: 450; }
        .updated { display: flex; align-items: center; gap: 7px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--pvl-line); color: var(--secondary-text-color); font-size: 0.8rem; }
        .updated svg { flex: 0 0 auto; width: 15px; height: 15px; color: var(--pvl-blue); }
        .section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--pvl-line); }
        .reference-row, .chart-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
        .section[hidden] { display: none; }
        .section-title { margin: 0; font-size: 0.9rem; font-weight: 600; }
        button { min-height: 36px; padding: 6px 10px; border: 1px solid var(--pvl-line); border-radius: 9px; color: var(--primary-text-color); background: var(--ha-card-background, var(--card-background-color, var(--primary-background-color))); font: inherit; cursor: pointer; }
        button:focus-visible { outline: 2px solid var(--pvl-blue); outline-offset: 2px; }
        .difference { color: var(--pvl-blue-deep); font-weight: 700; font-variant-numeric: tabular-nums; }
        .periods { display: flex; gap: 6px; }
        .periods button { min-height: 32px; padding: 4px 9px; color: var(--secondary-text-color); font-size: 0.78rem; }
        .periods button[aria-pressed="true"] { border-color: var(--pvl-blue); color: var(--primary-text-color); background: color-mix(in srgb, var(--pvl-blue) 14%, var(--ha-card-background, var(--card-background-color, white))); }
        .chart { min-height: 110px; margin-top: 12px; }
        .chart svg { display: block; width: 100%; height: 150px; overflow: visible; }
        .chart-grid { stroke: var(--pvl-line); stroke-width: 1; }
        .chart-line { fill: none; stroke: var(--pvl-blue); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
        .chart-point { fill: var(--pvl-blue); stroke: var(--ha-card-background, var(--card-background-color, white)); stroke-width: 2; }
        .chart-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--secondary-text-color); font-size: 0.75rem; }
        .empty { margin: 12px 0; color: var(--secondary-text-color); font-size: 0.85rem; }
        @media (max-width: 560px) {
          .overview { grid-template-columns: 1fr; gap: 14px; }
          .level-panel { min-height: 178px; }
          .gauge-wrap { height: 166px; }
          .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        @media (max-width: 360px) {
          ha-card { padding: 14px; }
          .header { align-items: flex-start; flex-direction: column; gap: 4px; }
          .metrics { grid-template-columns: 1fr; }
        }
        @media (prefers-reduced-motion: reduce) { .gauge-fill { transition: none; } }
      </style>
      <ha-card>
        <div class="header">
          <div><div class="eyebrow">PVL · Vltava</div><h2 id="card-title"></h2></div>
          <div class="source">Vodní dílo Slapy</div>
        </div>
        <div class="overview">
          <section class="level-panel" aria-label="Aktuální výška hladiny">
            <div class="gauge-wrap" role="img" id="gauge-description">
              <span class="gauge-label" id="gauge-max"></span>
              <div class="gauge"><div class="gauge-fill" id="gauge-fill"></div></div>
              <span class="gauge-label" id="gauge-min"></span>
            </div>
            <div class="level-number">
              <div class="level-label">Výška hladiny</div>
              <div class="level-value"><span id="level-value">—</span><span class="level-unit">m n. m.</span></div>
              <div class="range-note" id="range-note"></div>
            </div>
          </section>
          <div class="metrics" id="metrics"></div>
        </div>
        <div class="updated" id="updated">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8Zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67Z"/></svg>
          <span id="updated-text">Čas měření není dostupný</span>
        </div>
        <section class="section" id="reference-section" hidden>
          <div class="reference-row">
            <h3 class="section-title">Rozdíl od referenční hladiny</h3>
            <span class="difference" id="difference">—</span>
          </div>
        </section>
        <section class="section" id="history-section">
          <div class="chart-heading"><h3 class="section-title">Vývoj hladiny</h3><div class="periods" aria-label="Období grafu">
            <button type="button" data-period="hour" aria-pressed="false">1 hodina</button>
            <button type="button" data-period="day" aria-pressed="true">24 hodin</button>
          </div></div>
          <div class="chart" id="chart"><p class="empty">Načítám historii…</p></div>
        </section>
      </ha-card>`;

    this.shadowRoot.querySelector("#card-title").textContent = this._config.name;
    this.shadowRoot.querySelector("#gauge-min").textContent = `${this._format(this._config.minLevel, 1)} m`;
    this.shadowRoot.querySelector("#gauge-max").textContent = `${this._format(this._config.maxLevel, 1)} m`;
    this.shadowRoot.querySelector("#history-section").hidden = !this._config.showHistory;
    this._renderMetrics();
    this.shadowRoot.querySelector("#reference-section").hidden = !this._config.entities.reference_difference;
    this.shadowRoot.querySelectorAll(".periods button").forEach((button) => {
      button.addEventListener("click", () => {
        this._period = button.dataset.period;
        this.shadowRoot.querySelectorAll(".periods button").forEach((item) => {
          item.setAttribute("aria-pressed", String(item === button));
        });
        this._loadHistory();
      });
    });
    this._updateValues();
  }

  _renderMetrics() {
    const container = this.shadowRoot.querySelector("#metrics");
    container.replaceChildren();
    METRICS.forEach(([key, label, unit, precision]) => {
      const metric = document.createElement("div");
      metric.className = "metric";
      const metricLabel = document.createElement("div");
      metricLabel.className = "metric-label";
      metricLabel.textContent = label;
      const value = document.createElement("div");
      value.className = "metric-value";
      value.dataset.metric = key;
      value.textContent = "—";
      const metricUnit = document.createElement("span");
      metricUnit.className = "metric-unit";
      metricUnit.textContent = ` ${unit}`;
      value.append(metricUnit);
      metric.append(metricLabel, value);
      container.append(metric);
    });
  }

  _entityState(key) {
    const entityId = this._config.entities[key];
    return entityId ? this._hass?.states?.[entityId] : undefined;
  }

  _numericState(key) {
    const state = this._entityState(key)?.state;
    if (state === undefined || state === null || state === "" || state === "unknown" || state === "unavailable") {
      return null;
    }
    const value = Number(state);
    return Number.isFinite(value) ? value : null;
  }

  _unit(key, fallback = "") {
    return this._entityState(key)?.attributes?.unit_of_measurement || fallback;
  }

  _levelInMeters(value, unit = this._unit("water_level", "m")) {
    if (unit === "ft" || unit === "feet") return value * 0.3048;
    if (unit === "cm") return value / 100;
    if (unit === "mm") return value / 1000;
    if (unit === "km") return value * 1000;
    return value;
  }

  _volumeInMillionCubicMeters(value, unit = this._unit("volume", "m³")) {
    const cubicMetersPerUnit = {
      "m³": 1,
      m3: 1,
      "ft³": 0.028316846592,
      ft3: 0.028316846592,
      L: 0.001,
      gal: 0.003785411784,
      "UK gal": 0.00454609,
    }[unit];
    return cubicMetersPerUnit === undefined ? null : value * cubicMetersPerUnit / 1_000_000;
  }

  _format(value, digits = 2) {
    return new Intl.NumberFormat(this._locale(), {
      maximumFractionDigits: digits,
      minimumFractionDigits: 0,
    }).format(value);
  }

  _locale() {
    return this._hass?.locale?.language || "cs-CZ";
  }

  _updateValues() {
    if (!this._config || !this.shadowRoot) return;

    const rawLevel = this._numericState("water_level");
    const level = rawLevel === null ? null : this._levelInMeters(rawLevel);
    const levelValue = this.shadowRoot.querySelector("#level-value");
    const fill = this.shadowRoot.querySelector("#gauge-fill");
    const gauge = this.shadowRoot.querySelector("#gauge-description");
    const rangeNote = this.shadowRoot.querySelector("#range-note");

    if (level === null) {
      levelValue.textContent = "—";
      fill.style.height = "0%";
      rangeNote.textContent = this._config.entities.water_level ? "Hodnota není dostupná" : "Není nastavena entita hladiny";
      gauge.setAttribute("aria-label", "Výška hladiny není dostupná");
    } else {
      levelValue.textContent = this._format(level, 2);
      const percentage = (level - this._config.minLevel) / (this._config.maxLevel - this._config.minLevel) * 100;
      fill.style.height = `${Math.min(100, Math.max(0, percentage))}%`;
      rangeNote.textContent = level < this._config.minLevel
        ? "Hladina je pod nastaveným rozsahem"
        : level > this._config.maxLevel
          ? "Hladina je nad nastaveným rozsahem"
          : "";
      gauge.setAttribute("aria-label", `Hladina ${this._format(level, 2)} metrů, rozsah ${this._format(this._config.minLevel, 1)} až ${this._format(this._config.maxLevel, 1)} metrů`);
    }

    METRICS.forEach(([key, _label, fallbackUnit, precision]) => {
      const target = this.shadowRoot.querySelector(`[data-metric="${key}"]`);
      const value = this._numericState(key);
      const unit = this._unit(key, fallbackUnit);
      let formatted = "—";
      let displayUnit = unit;
      if (value !== null) {
        if (key === "volume") {
          const volume = this._volumeInMillionCubicMeters(value);
          if (volume !== null) {
            formatted = this._format(volume, precision);
            displayUnit = "mil. m³";
          } else {
            formatted = this._format(value, precision);
          }
        } else {
          formatted = this._format(value, precision);
        }
      }
      target.replaceChildren(document.createTextNode(formatted));
      const unitNode = document.createElement("span");
      unitNode.className = "metric-unit";
      unitNode.textContent = ` ${displayUnit}`;
      target.append(unitNode);
      target.title = value === null ? "Hodnota není dostupná" : `${formatted} ${displayUnit}`;
    });

    this._updateMeasurementTime();
    this._updateDifference();

    const currentState = this._entityState("water_level");
    const waterState = currentState?.last_updated;
    if (this._config.showHistory && waterState && waterState !== this._lastWaterState) {
      this._lastWaterState = waterState;
      this._loadHistory();
    }
  }

  _updateMeasurementTime() {
    const entity = this._entityState("water_level");
    const measurementTime = entity?.attributes?.measurement_time;
    const lastUpdated = entity?.last_updated;
    const sourceIsMeasurementTime = Boolean(measurementTime);
    const timestamp = measurementTime || lastUpdated;
    const updatedText = this.shadowRoot.querySelector("#updated-text");
    if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) {
      updatedText.textContent = "Čas měření není dostupný";
      return;
    }
    const formatted = new Intl.DateTimeFormat(this._locale(), {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
    updatedText.textContent = `${sourceIsMeasurementTime ? "Čas měření PVL" : "Aktualizováno v Home Assistantu"}: ${formatted}`;
  }

  _updateDifference() {
    const target = this.shadowRoot.querySelector("#difference");
    const difference = this._numericState("reference_difference");
    if (difference === null) {
      target.textContent = "—";
      return;
    }
    const sign = difference > 0 ? "+" : difference < 0 ? "−" : "";
    target.textContent = `${sign}${this._format(Math.abs(difference), 2)} m`;
  }

  async _loadHistory() {
    const chart = this.shadowRoot?.querySelector("#chart");
    const entityId = this._config?.entities?.water_level;
    if (!chart || !this._hass || !entityId) return;

    const requestId = ++this._historyRequestId;
    this._showChartMessage("Načítám historii…");
    const end = new Date();
    const duration = this._period === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const start = new Date(end.getTime() - duration);
    const query = new URLSearchParams({
      filter_entity_id: entityId,
      end_time: end.toISOString(),
      no_attributes: "1",
      significant_changes_only: "0",
    });
    const path = `history/period/${encodeURIComponent(start.toISOString())}?${query}`;

    try {
      const result = await this._hass.callApi("GET", path);
      if (requestId !== this._historyRequestId) return;
      const entries = Array.isArray(result?.[0]) ? result.flat() : result;
      const unit = this._unit("water_level", "m");
      const points = (Array.isArray(entries) ? entries : [])
        .map((entry) => ({
          time: new Date(entry.last_updated || entry.last_changed).getTime(),
          value: this._levelInMeters(Number(entry.state), unit),
        }))
        .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
      this._drawChart(points);
    } catch (_error) {
      if (requestId === this._historyRequestId) this._showChartMessage("Historii se nepodařilo načíst.");
    }
  }

  _showChartMessage(message) {
    const chart = this.shadowRoot?.querySelector("#chart");
    if (!chart) return;
    const paragraph = document.createElement("p");
    paragraph.className = "empty";
    paragraph.textContent = message;
    chart.replaceChildren(paragraph);
  }

  _drawChart(points) {
    const chart = this.shadowRoot.querySelector("#chart");
    if (points.length === 0) {
      this._showChartMessage("Pro toto období zatím nejsou v Recorderu žádné hodnoty.");
      return;
    }

    const width = 640;
    const height = 150;
    const padX = 8;
    const padY = 12;
    const values = points.map((point) => point.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      min -= 0.05;
      max += 0.05;
    }
    const firstTime = points[0].time;
    const lastTime = points[points.length - 1].time;
    const duration = Math.max(1, lastTime - firstTime);
    const coordinates = points.map((point) => [
      padX + ((point.time - firstTime) / duration) * (width - padX * 2),
      height - padY - ((point.value - min) / (max - min)) * (height - padY * 2),
    ]);

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Vývoj hladiny za ${this._period === "hour" ? "poslední hodinu" : "posledních 24 hodin"}`);
    const grid = document.createElementNS(SVG_NS, "line");
    grid.setAttribute("class", "chart-grid");
    grid.setAttribute("x1", String(padX));
    grid.setAttribute("x2", String(width - padX));
    grid.setAttribute("y1", String(height / 2));
    grid.setAttribute("y2", String(height / 2));
    svg.append(grid);

    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("class", "chart-line");
    line.setAttribute("points", coordinates.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" "));
    svg.append(line);

    const [lastX, lastY] = coordinates[coordinates.length - 1];
    const point = document.createElementNS(SVG_NS, "circle");
    point.setAttribute("class", "chart-point");
    point.setAttribute("cx", lastX.toFixed(1));
    point.setAttribute("cy", lastY.toFixed(1));
    point.setAttribute("r", "4");
    svg.append(point);

    const timeFormat = new Intl.DateTimeFormat(this._locale(), { hour: "2-digit", minute: "2-digit" });
    const meta = document.createElement("div");
    meta.className = "chart-meta";
    const startLabel = document.createElement("span");
    startLabel.textContent = timeFormat.format(new Date(firstTime));
    const stats = document.createElement("span");
    stats.textContent = `${this._format(min, 2)}–${this._format(max, 2)} m · ${points.length} záznamů`;
    const endLabel = document.createElement("span");
    endLabel.textContent = timeFormat.format(new Date(lastTime));
    meta.append(startLabel, stats, endLabel);
    chart.replaceChildren(svg, meta);
  }
}

if (!customElements.get("pvl-reservoir-card")) {
  customElements.define("pvl-reservoir-card", PVLReservoirCard);
}

window.customCards = window.customCards || [];
window.customCards.push({
  type: "pvl-reservoir-card",
  name: "PVL Reservoir Monitor",
  description: "Current reservoir level and hydrological data for VD Slapy.",
  preview: true,
});
