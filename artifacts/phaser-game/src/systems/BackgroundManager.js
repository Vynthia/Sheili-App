import Phaser from "phaser";

// ---------------------------------------------------------------------------
// Parallax factors: how much each layer moves relative to the world scroll.
// Lower = further away / slower.
// ---------------------------------------------------------------------------
const PARALLAX = {
  sky:         0.04,   // clouds barely drift
  celestial:   0.01,   // moon / sun are almost fixed
  skylineFar:  0.12,
  buildings:   0.30,
  roofsBack:   0.55,
};

// Auto-scroll speed used when there is no gameplay driving the camera.
// Replace with the real world-delta value once the player is moving.
const AUTO_SCROLL_PX_PER_SEC = 80;

// Night sky gradient colour stops (top → bottom)
const NIGHT_GRADIENT = [
  [0.00, "#06000f"],
  [0.45, "#0e0135"],
  [1.00, "#1c0d4a"],
];

// Day sky gradient colour stops (top → bottom)
const DAY_GRADIENT = [
  [0.00, "#5eaee8"],
  [0.55, "#a8d4f5"],
  [1.00, "#fce4b0"],
];

// ---------------------------------------------------------------------------

export class BackgroundManager {
  /**
   * @param {Phaser.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // Whether the scene is currently in night mode.
    this._isNight = true;

    this._create();
  }

  // ── Private: initial object creation ──────────────────────────────────────

  _create() {
    const { width, height } = this.scene.scale;

    // 1. Sky gradient — rendered into a canvas texture so it's a real gradient,
    //    not a flat colour.  Redrawn when switching day ↔ night.
    this._buildGradientTexture("sky_gradient_night", NIGHT_GRADIENT, width, height);
    this._buildGradientTexture("sky_gradient_day",   DAY_GRADIENT,   width, height);

    this._skyGradientNight = this.scene.add
      .image(0, 0, "sky_gradient_night")
      .setOrigin(0, 0)
      .setDepth(0);

    this._skyGradientDay = this.scene.add
      .image(0, 0, "sky_gradient_day")
      .setOrigin(0, 0)
      .setDepth(0)
      .setAlpha(0);

    // 2. Cloud / star overlay — TileSprites so they tile seamlessly.
    //    The images are 1024 × 256; position them flush with the top.
    this._skyNight = this.scene.add
      .tileSprite(0, 0, width, 256, "sky_night")
      .setOrigin(0, 0)
      .setDepth(1);

    this._skyDay = this.scene.add
      .tileSprite(0, 0, width, 256, "sky_day")
      .setOrigin(0, 0)
      .setDepth(1)
      .setAlpha(0);

    // 3. Moon and sun — single images that drift slowly across the upper sky.
    //    Moon is visible at night, sun during the day.
    this._moon = this.scene.add
      .image(80, 38, "moon")
      .setOrigin(0.5, 0.5)
      .setDepth(2);

    this._sun = this.scene.add
      .image(400, 34, "sun")
      .setOrigin(0.5, 0.5)
      .setDepth(2)
      .setAlpha(0);

    // The image is 128 × 128 at native scale — fine for pixel art (no scaling).

    // 4–6. City layers — TileSprites anchored to the bottom of the canvas.
    //      The images are all 1024 × 256, so bottom-aligning places their
    //      detail exactly at the canvas edge.
    const layerY = height - 256;

    this._skylineFar = this.scene.add
      .tileSprite(0, layerY, width, 256, "skyline_far")
      .setOrigin(0, 0)
      .setDepth(3);

    this._buildings = this.scene.add
      .tileSprite(0, layerY, width, 256, "buildings_mid")
      .setOrigin(0, 0)
      .setDepth(4);

    this._roofsBack = this.scene.add
      .tileSprite(0, layerY, width, 256, "roofs_back")
      .setOrigin(0, 0)
      .setDepth(5);
  }

  // ── Private: texture helpers ───────────────────────────────────────────────

  /**
   * Bake a vertical linear gradient into a named Phaser canvas texture.
   * @param {string} key
   * @param {Array<[number, string]>} stops  [[position, colour], …]
   * @param {number} w
   * @param {number} h
   */
  _buildGradientTexture(key, stops, w, h) {
    const tex = this.scene.textures.createCanvas(key, w, h);
    const ctx = tex.getContext();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    for (const [pos, colour] of stops) {
      grad.addColorStop(pos, colour);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    tex.refresh();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Call every frame from the scene's update().
   *
   * @param {number} delta   Phaser delta time in milliseconds.
   * @param {number} [worldDelta]  Optional: pixels the world scrolled this
   *   frame (supplied by gameplay once implemented). Falls back to a constant
   *   auto-scroll so the parallax is visible during development.
   */
  update(delta, worldDelta) {
    const scroll =
      worldDelta !== undefined
        ? worldDelta
        : AUTO_SCROLL_PX_PER_SEC * (delta / 1000);

    // Cloud / star layers
    this._skyNight.tilePositionX += scroll * PARALLAX.sky;
    this._skyDay.tilePositionX   += scroll * PARALLAX.sky;

    // Celestial bodies drift horizontally; Y stays fixed.
    const celestialDrift = scroll * PARALLAX.celestial;
    this._moon.x += celestialDrift;
    this._sun.x  += celestialDrift;

    // Wrap moon and sun so they never disappear off-screen permanently.
    const { width } = this.scene.scale;
    if (this._moon.x > width  + 80) this._moon.x = -80;
    if (this._sun.x  > width  + 80) this._sun.x  = -80;

    // City parallax layers
    this._skylineFar.tilePositionX += scroll * PARALLAX.skylineFar;
    this._buildings.tilePositionX  += scroll * PARALLAX.buildings;
    this._roofsBack.tilePositionX  += scroll * PARALLAX.roofsBack;
  }

  /**
   * Cross-fade between night and day states.
   * Progress: 0 = fully night, 1 = fully day.
   * @param {number} progress  0 – 1
   */
  setDayNightProgress(progress) {
    const p = Phaser.Math.Clamp(progress, 0, 1);

    this._skyGradientNight.setAlpha(1 - p);
    this._skyGradientDay.setAlpha(p);

    this._skyNight.setAlpha(1 - p);
    this._skyDay.setAlpha(p);

    this._moon.setAlpha(1 - p);
    this._sun.setAlpha(p);

    this._isNight = p < 0.5;
  }
}
