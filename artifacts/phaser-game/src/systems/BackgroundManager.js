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

// Night sky gradient colour stops (top → bottom).
//
// Key constraint from pixel analysis:
//   skyline_far silhouette = ~#0d1125 (dark navy, almost black)
//   buildings_mid transparent below image row 140 → game y 154+
//
// Strategy: make the gradient genuinely bright (not near-black) so:
//   1. City-glow purple (#5f35cc) in lower canvas is visible through
//      rooftop gaps and the transparent zone below buildings_mid.
//   2. The upper sky is lighter than before so the skyline silhouette
//      that is shown in the sky zone (via tilePositionY) stands out.
const NIGHT_GRADIENT = [
  [0.00, "#1e1650"],   // medium dark purple-blue (zenith)
  [0.45, "#2d1a88"],   // medium purple (mid-sky)
  [0.75, "#4525b0"],   // brighter purple (horizon)
  [1.00, "#5f35cc"],   // strong city glow (ground level)
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

    // ── City layers ────────────────────────────────────────────────────
    // All source images are 1024 × 256 px (native pixel art size).
    //
    // Measured opaque content zones (from raw RGBA pixel analysis):
    //   skyline_far  : image rows 105–255  (151 px tall, near-black ~#0d1125)
    //   buildings_mid: image rows  30–140  (111 px, then transparent below 140)
    //   roofs_back   : image rows  54–253  (200 px, bright white ridge lines)
    //
    // Layout strategy for visibility:
    //
    //   a) skyline_far is shown in a 50 px SKY SLOT at the top of the
    //      canvas (y = 0–50), using tilePositionY=105 to shift the opaque
    //      content (starting at image row 105) into this visible zone.
    //      The medium-blue gradient gives enough contrast for the dark navy
    //      silhouette to read as a distant cityscape.
    //
    //   b) buildings_mid and roofs_back sit at their natural layerY position
    //      (y = height - 256 = 14).  Because buildings_mid is transparent
    //      below image row 140 (game y ≈ 154), the city-glow gradient
    //      (#5f35cc at the bottom) glows through in rooftop gaps, creating
    //      vivid depth in the lower canvas.
    //
    // The net vertical zones seen by the viewer:
    //   y 0–44  : sky (gradient + clouds/stars) + skyline silhouette
    //   y 44–50 : skyline + buildings start
    //   y 50–68 : buildings only (rooftops haven't started)
    //   y 68–154: buildings + foreground rooftops in front
    //   y 154+  : city-glow gradient visible through rooftop gaps

    const layerY     = height - 256;   // 14 px for a 270-tall canvas

    // skyline_far slot: extends from y=0 down to y=SKY_SLOT_H.
    // The slot is taller than the clear-sky zone (game y 0–44) so that the
    // silhouette continues BEHIND buildings_mid in the overlap zone (y 44–120),
    // grounding the distant city instead of letting it float.
    //
    // Visual zones with SKY_SLOT_H=120, tilePositionY=105:
    //   game y 0–43   → skyline rows 105–148  (tops, fully visible in clear sky)
    //   game y 44–119 → skyline rows 149–224  (hidden behind buildings_mid depth 4)
    const SKY_SLOT_H            = 120; // px
    const SKYLINE_CONTENT_START = 105; // first opaque image row in skyline_far.png

    // 4. skyline_far — distant city silhouette in the sky/upper zone.
    this._skylineFar = this.scene.add
      .tileSprite(0, 0, width, SKY_SLOT_H, "skyline_far")
      .setOrigin(0, 0)
      .setDepth(3);
    this._skylineFar.tilePositionY = SKYLINE_CONTENT_START;

    // 5. buildings_mid — apartment facades in their natural position.
    //    Rows 30–140 produce the lit-window building zone.
    //    Transparent below row 140, allowing the gradient to show through.
    this._buildings = this.scene.add
      .tileSprite(0, layerY, width, 256, "buildings_mid")
      .setOrigin(0, 0)
      .setDepth(4);

    // 6. roofs_back — foreground rooftop layer (rows 54–253, depth 5).
    //    Bright white ridge highlights stand out clearly against buildings.
    //    Transparent gaps in rooftops reveal the city-glow gradient below.
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
    // Remove a stale texture from a previous scene run (happens on HMR reload).
    if (this.scene.textures.exists(key)) {
      this.scene.textures.remove(key);
    }
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
