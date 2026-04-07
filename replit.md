# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   └── api-server/         # Express API server
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts, run via `pnpm --filter @workspace/scripts run <script>`
├── pnpm-workspace.yaml     # pnpm workspace (artifacts/*, lib/*, lib/integrations/*, scripts)
├── tsconfig.base.json      # Shared TS options (composite, bundler resolution, es2022)
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references. This means:

- **Always typecheck from the root** — run `pnpm run typecheck` (which runs `tsc --build --emitDeclarationOnly`). This builds the full dependency graph so that cross-package imports resolve correctly. Running `tsc` inside a single package will fail if its dependencies haven't been built yet.
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite...etc, not `tsc`.
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array. `tsc --build` uses this to determine build order and skip up-to-date packages.

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages that define it
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Phaser 3 Game (`artifacts/phaser-game`)

Plain JS Phaser 3 browser game — no React, no UI framework. Served via Vite.

- Entry: `index.html` → `src/main.js`
- Styles: `src/style.css` — pixel-art crisp rendering, centered canvas, black letterbox
- Game config: `src/main.js` — `Phaser.CANVAS` renderer (pixel-art reliable), `pixelArt: true`, `antialias: false`, `roundPixels: true`, `Scale.FIT` / `CENTER_BOTH`
- Scene: `src/scenes/GameScene.js` — contains `preload()`, `create()`, `update()`
- Canvas size: 480 × 270 (change `GAME_WIDTH` / `GAME_HEIGHT` in `main.js`)
- Assets: `public/assets/bg/` (backgrounds), `public/assets/` (sprites)

### CatcherEnemy (`src/systems/CatcherEnemy.js`)

The primary game-over system. A cat-catcher chases the player from the left.

- **State machine**: `'chasing'` → `'catching'` → `'sitting'` → `'done'`
- **Distance**: starts 360 px behind the cat (off-screen). Closes at 8 px/s naturally. Each obstacle collision reduces it by 80 px.
- **Catch sequence**: when distance ≤ 0, the catcher snaps to the cat's X, plays the 2-frame `catcher_catch` animation for 900 ms, then the `sitting_cat` image appears for 1300 ms, then `scene.restart()`.
- **Obstacle integration**: obstacle hits no longer cause instant restart — they call `catcher.onObstacleHit()` and start a 1500 ms per-hit invincibility window, flashing the cat sprite as feedback.
- **Assets**: `public/assets/enemy/catcher_run.png` (4 × 128×128 spritesheet), `public/assets/enemy/catcher_catch.png` (2 × 128×128 spritesheet), `public/assets/cat/sitting_cat.png` (128×128 single frame).
- **Depths**: chasing=15 (behind cat=20), catching=25 (in front), sitting_cat=22.

### ObstacleManager (`src/systems/ObstacleManager.js`)

Spawns and scrolls rooftop obstacles (chimney, antenna, vent, skylight) on valid platform surfaces.

- Callback-driven: PlatformManager calls `onSegmentSpawned(seg)` for each new segment; ObstacleManager places 0–2 obstacles in the safe interior (skips first and last tile of segment to avoid gap edges and landing zones).
- No physics bodies: collision is pure AABB in screen-space each frame inside `update(delta, catSprite)`.
- `this.collision` is set `true` when the cat's physics hitbox overlaps any obstacle; GameScene reads this flag and calls `scene.restart()`.
- **Arcade Physics StaticGroup** (`this.group`, public): ground obstacles (chimney, antenna, vent, bird) are created as physics static images inside this group. Physics collider wired in GameScene (`physics.add.collider(cat.sprite, obstacles.group, cb)`). No manual AABB for ground obstacles.
- **Hitboxes via setSize/setOffset**: full visual width (`hitW = Math.round(128 × scale)`), only 20px tall at the base (`offsetY = Math.round(128 × scale − 20)`, `offsetX = 0`). Cat jump peak `catBottom ≈ 142 < obsTop=175` → always clears.
- **Depths fixed (no dynamic)**:cat depth=30 (always in front), ground obstacles depth=20. Cat always renders on top.
- Minimum spacing `MIN_SPACING = TILE_W (512 px)` between consecutive obstacles.
- Grace period 1500 ms checked in both the physics collider callback (ground) and GameScene.update() (flying bird).
- **Flying bird** (`bird_fly`) — manual AABB only (not in physics group). Enters from left, flies right at 80px/s. Spawns only when no ground obstacle is on screen. Sets `this.collision = true`; GameScene restarts on that flag.

### BackgroundManager (`src/systems/BackgroundManager.js`)

6-layer parallax city-rooftop background system:

| Depth | Layer | Source | Notes |
|-------|-------|---------|-------|
| 0 | Sky gradient (night/day) | generated canvas texture | Night: `#1e1650`→`#5f35cc`; Day: sky blue→peach |
| 1 | Sky tile (night/day) | `sky_night.png` / `sky_day.png` | Clouds, stars |
| 2 | Celestial body | `moon.png` / `sun.png` | Drifts horizontally, wraps |
| 3 | skyline_far | `skyline_far.png` | TileSprite at y=0, height=120, `tilePositionY=105` — shows opaque rows 105–224 in the sky zone, grounded behind buildings_mid |
| 4 | buildings_mid | `buildings_mid.png` | TileSprite at y=`height-256`=14, full 256px — opaque rows 30–140, transparent below → city-glow gradient shows through |
| 5 | roofs_back | `roofs_back.png` | TileSprite at y=14, full 256px — closest foreground layer |

Key design decisions:
- **skyline_far sky-slot trick**: `tilePositionY=105` shifts the first opaque content row to game y=0, showing the distant skyscraper silhouette in the upper sky (game y 0–43), grounded by continuing behind buildings_mid (y 44–120)
- **city-glow gradient**: bright purple at bottom (`#5f35cc`) glows through transparent areas of buildings_mid (below image row 140 = game y 154+) and gaps in roofs_back
- **HMR texture cache fix**: `_buildGradientTexture` calls `textures.remove(key)` before `createCanvas` to prevent stale textures on hot-reload
- `update(delta, worldDelta?)` — scrolls all layers with parallax factors; worldDelta optional (auto-scrolls at 80px/s during dev)
- `setDayNightProgress(0–1)` — cross-fades between night/day gradients, sky tiles, and celestial bodies

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server. Routes live in `src/routes/` and use `@workspace/api-zod` for request and response validation and `@workspace/db` for persistence.

- Entry: `src/index.ts` — reads `PORT`, starts Express
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/index.ts` mounts sub-routers; `src/routes/health.ts` exposes `GET /health` (full path: `/api/health`)
- Depends on: `@workspace/db`, `@workspace/api-zod`
- `pnpm --filter @workspace/api-server run dev` — run the dev server
- `pnpm --filter @workspace/api-server run build` — production esbuild bundle (`dist/index.cjs`)
- Build bundles an allowlist of deps (express, cors, pg, drizzle-orm, zod, etc.) and externalizes the rest

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL. Exports a Drizzle client instance and schema models.

- `src/index.ts` — creates a `Pool` + Drizzle instance, exports schema
- `src/schema/index.ts` — barrel re-export of all models
- `src/schema/<modelname>.ts` — table definitions with `drizzle-zod` insert schemas (no models definitions exist right now)
- `drizzle.config.ts` — Drizzle Kit config (requires `DATABASE_URL`, automatically provided by Replit)
- Exports: `.` (pool, db, schema), `./schema` (schema only)

Production migrations are handled by Replit when publishing. In development, we just use `pnpm --filter @workspace/db run push`, and we fallback to `pnpm --filter @workspace/db run push-force`.

### `lib/api-spec` (`@workspace/api-spec`)

Owns the OpenAPI 3.1 spec (`openapi.yaml`) and the Orval config (`orval.config.ts`). Running codegen produces output into two sibling packages:

1. `lib/api-client-react/src/generated/` — React Query hooks + fetch client
2. `lib/api-zod/src/generated/` — Zod schemas

Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `lib/api-zod` (`@workspace/api-zod`)

Generated Zod schemas from the OpenAPI spec (e.g. `HealthCheckResponse`). Used by `api-server` for response validation.

### `lib/api-client-react` (`@workspace/api-client-react`)

Generated React Query hooks and fetch client from the OpenAPI spec (e.g. `useHealthCheck`, `healthCheck`).

### `scripts` (`@workspace/scripts`)

Utility scripts package. Each script is a `.ts` file in `src/` with a corresponding npm script in `package.json`. Run scripts via `pnpm --filter @workspace/scripts run <script>`. Scripts can import any workspace package (e.g., `@workspace/db`) by adding it as a dependency in `scripts/package.json`.
