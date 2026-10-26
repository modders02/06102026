/**
 * Conservative visual haze verifier. Unlike gray-pixel counting, this
 * compares texture in THE SAME fixed background regions across time.
 * A gray wall, uniform clothing, or a global exposure shift cannot by itself
 * establish smoke. This is heuristic evidence, not a trained smoke classifier.
 *
 * The monitor MUST require verified=true before emitting smoke history.
 * Use a physical smoke alarm for actual life-safety monitoring.
 */
export interface HazeTile {
  mean: number;
  texture: number;
  edges: number;
  saturation: number;
}
export interface HazeVerificationState {
  reference: Array<HazeTile | null> | null;
  warmupFrames: number;
  evidenceFrames: number;
  clearFrames: number;
  sceneChangeFrames: number;
  active: boolean;
  width: number;
  height: number;
}
export interface HazeVerificationResult {
  verified: boolean;
  /** Cross-frame texture disappearance, not color-palette coverage. */
  textureLossRatio: number;
  matchingTiles: number;
  evidenceFrames: number;
  reason: string;
}

const GRID_X = 12;
const GRID_Y = 8;
const REQUIRED_WARMUP_FRAMES = 4;
const REQUIRED_EVIDENCE_FRAMES = 5;
const MIN_REFERENCE_TILES = 12;
const MIN_MATCH_SHARE = 0.58;
const MIN_BACKGROUND_SHARE = 0.42;
const TILE_STEP = 3;
const CLEAR_FRAMES = 4;

export function createHazeVerificationState(): HazeVerificationState {
  return {
    reference: null,
    warmupFrames: 0,
    evidenceFrames: 0,
    clearFrames: 0,
    sceneChangeFrames: 0,
    active: false,
    width: 0,
    height: 0,
  };
}

function tileOverlapsPerson(
  x: number, y: number, w: number, h: number,
  persons: readonly (readonly number[])[],
): boolean {
  for (const p of persons) {
    if (p.length < 4) continue;
    const px = p[0] - 4, py = p[1] - 4;
    const pw = p[2] + 8, ph = p[3] + 8;
    const commonWidth = Math.max(0, Math.min(x + w, px + pw) - Math.max(x, px));
    const commonHeight = Math.max(0, Math.min(y + h, py + ph) - Math.max(y, py));
    if (commonWidth * commonHeight > w * h * 0.10) return true;
  }
  return false;
}

function extractTile(
  frame: ImageData,
  x: number, y: number, w: number, h: number,
): HazeTile | null {
  const { data, width } = frame;
  let count = 0, sum = 0, squares = 0, edge = 0, edgeSamples = 0, sat = 0;
  for (let yy = y; yy < y + h; yy += TILE_STEP) {
    for (let xx = x; xx < x + w; xx += TILE_STEP) {
      const index = (yy * width + xx) * 4;
      const r = data[index], g = data[index + 1], b = data[index + 2];
      const value = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const biggest = Math.max(r, g, b), smallest = Math.min(r, g, b);
      sum += value;
      squares += value * value;
      sat += biggest > 0 ? (biggest - smallest) / biggest : 0;
      count++;
      if (xx + TILE_STEP < x + w) {
        const adjacent = (yy * width + xx + TILE_STEP) * 4;
        const next = (0.299 * data[adjacent] + 0.587 * data[adjacent + 1]
          + 0.114 * data[adjacent + 2]) / 255;
        edge += Math.abs(next - value);
        edgeSamples++;
      }
    }
  }
  if (count < 8) return null;
  const mean = sum / count;
  return {
    mean,
    texture: Math.sqrt(Math.max(0, squares / count - mean * mean)),
    edges: edge / Math.max(1, edgeSamples),
    saturation: sat / count,
  };
}

function extractGrid(
  frame: ImageData,
  persons: readonly (readonly number[])[],
): Array<HazeTile | null> {
  const output: Array<HazeTile | null> = [];
  for (let row = 0; row < GRID_Y; row++) {
    const y = Math.floor(row * frame.height / GRID_Y);
    const yEnd = Math.floor((row + 1) * frame.height / GRID_Y);
    for (let column = 0; column < GRID_X; column++) {
      const x = Math.floor(column * frame.width / GRID_X);
      const xEnd = Math.floor((column + 1) * frame.width / GRID_X);
      const w = xEnd - x, h = yEnd - y;
      output.push(w < 9 || h < 9 || tileOverlapsPerson(x, y, w, h, persons)
        ? null : extractTile(frame, x, y, w, h));
    }
  }
  return output;
}

export function verifyTemporalSmokeHaze(
  frame: ImageData,
  persons: readonly (readonly number[])[],
  state: HazeVerificationState,
): HazeVerificationResult {
  if (frame.width < 120 || frame.height < 80 || frame.data.length < frame.width * frame.height * 4) {
    return { verified: false, textureLossRatio: 0, matchingTiles: 0,
      evidenceFrames: 0, reason: 'insufficient video resolution' };
  }
  if (state.width !== frame.width || state.height !== frame.height) {
    Object.assign(state, createHazeVerificationState(), {
      width: frame.width, height: frame.height,
    });
  }
  const current = extractGrid(frame, persons);
  const visible = current.filter((tile): tile is HazeTile => tile !== null).length;
  const enoughBackground = visible >= GRID_X * GRID_Y * MIN_BACKGROUND_SHARE;
  if (!enoughBackground) {
    state.evidenceFrames = 0;
    state.clearFrames++;
    if (state.clearFrames >= CLEAR_FRAMES) state.active = false;
    return { verified: false, textureLossRatio: 0, matchingTiles: 0,
      evidenceFrames: 0, reason: 'too much of the view is obstructed' };
  }

  if (!state.reference || state.warmupFrames < REQUIRED_WARMUP_FRAMES) {
    if (!state.reference) state.reference = current.map(tile => tile && { ...tile });
    else {
      // Do not allow moving foreground objects to define the background.
      // Missing tiles retain null references until the stream restarts.
      state.reference = state.reference.map((tile, index) => {
        const next = current[index];
        if (!tile || !next) return tile;
        const weight = 1 / (state.warmupFrames + 1);
        return {
          mean: tile.mean * (1 - weight) + next.mean * weight,
          texture: tile.texture * (1 - weight) + next.texture * weight,
          edges: tile.edges * (1 - weight) + next.edges * weight,
          saturation: tile.saturation * (1 - weight) + next.saturation * weight,
        };
      });
    }
    state.warmupFrames++;
    return { verified: false, textureLossRatio: 0, matchingTiles: 0,
      evidenceFrames: 0, reason: 'learning unobstructed scene reference' };
  }

  let eligible = 0, occluded = 0, brightening = 0, darkening = 0, totalDifference = 0;
  for (let i = 0; i < current.length; i++) {
    const baseline = state.reference[i], sample = current[i];
    // Flat ceilings and walls have no distinctive texture to occlude.
    if (!sample || !baseline || baseline.texture < 0.028 || baseline.edges < 0.018) continue;
    eligible++;
    const delta = sample.mean - baseline.mean;
    totalDifference += Math.abs(delta);
    const loss = sample.texture / baseline.texture;
    const edgeLoss = sample.edges / baseline.edges;
    if (loss < 0.61 && edgeLoss < 0.69 && Math.abs(delta) >= 0.04
        && sample.saturation <= baseline.saturation + 0.10) {
      occluded++;
      if (delta > 0) brightening++;
      else darkening++;
    }
  }
  const ratio = eligible ? occluded / eligible : 0;
  const sameDirection = occluded > 0 && Math.max(brightening, darkening) / occluded >= 0.7;
  const strong = eligible >= MIN_REFERENCE_TILES && occluded >= 9
    && ratio >= MIN_MATCH_SHARE && sameDirection;
  const candidate = strong && enoughBackground;
  state.evidenceFrames = candidate ? Math.min(REQUIRED_EVIDENCE_FRAMES, state.evidenceFrames + 1) : 0;

  if (candidate && state.evidenceFrames >= REQUIRED_EVIDENCE_FRAMES) {
    state.active = true;
    state.clearFrames = 0;
  } else if (state.active) {
    // Do not clear genuine steady haze just because the early rising edge has
    // left the rolling window; require several truly recovered background frames.
    state.clearFrames = ratio >= 0.40 ? 0 : state.clearFrames + 1;
    if (state.clearFrames >= CLEAR_FRAMES) {
      state.active = false;
      state.clearFrames = 0;
    }
  }

  // A wholesale scene rearrangement (camera moved) invalidates the reference.
  // Don't re-baseline a verified cloud; don't treat a single exposure jump as
  // smoke, because exposure preserves tile texture.
  if (!state.active && !candidate
      && eligible >= MIN_REFERENCE_TILES && totalDifference / eligible > 0.25) {
    state.sceneChangeFrames++;
    if (state.sceneChangeFrames >= 9) {
      Object.assign(state, createHazeVerificationState(), {
        width: frame.width, height: frame.height,
      });
    }
  } else state.sceneChangeFrames = 0;

  return {
    verified: state.active && enoughBackground,
    textureLossRatio: ratio,
    matchingTiles: eligible,
    evidenceFrames: state.evidenceFrames,
    reason: state.active ? 'sustained cross-frame background texture loss'
      : !eligible ? 'background contains no reliable reference texture'
      : candidate ? 'waiting for sustained haze confirmation'
      : 'no corroborated obscuring haze',
  };
}
