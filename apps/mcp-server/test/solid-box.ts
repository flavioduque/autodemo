// ---------------------------------------------------------------------------
// The box of ONE solid block of colour in a frame mask.
//
// The render tests ask "did the corner marker come out square?" of a decoded
// H.264 frame. A plain bounding box over every pixel near the marker's colour
// cannot answer that: the encoder leaves pixels inside the colour tolerance
// far from the marker, and one such pixel drags the box across the frame. The
// first repair — keep only the rows and columns carrying at least 20 matches —
// held on macOS, where the strays were four in 28160. On ubuntu-latest
// (ffmpeg 6.1 / libx264 164, the runner's Chrome) the same frame carried a few
// dozen strays per column across 700 columns of the marker's rows, and the
// marker measured 908x184 (CI run 34604186469).
//
// So the block is found by CONSTRUCTION instead of by threshold: the largest
// 4-connected component of matching pixels. The marker is a filled square
// enclosed by a black border; strays are not connected to it, however many
// there are per row or column, so they cannot widen it. A crop that stretched
// the marker stretches the component with it, which is what is being measured.
// ---------------------------------------------------------------------------

/** Every pixel of one frame that matched a colour: 1 where it did, 0 elsewhere. */
export interface ColorMask {
  width: number;
  height: number;
  data: Uint8Array;
  /** How many pixels matched — `data`'s population count. */
  count: number;
}

export interface Component {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Matching pixels in the component (not the box area). */
  pixels: number;
}

export interface SolidBox extends Component {
  /** How many 4-connected components the mask splits into. */
  components: number;
  /** The second-largest component, so a failure can say what else was in the frame. */
  runnerUp: Component | null;
  /** Matching pixels outside the block: the noise the measurement ignored. */
  stray: number;
}

/**
 * The bounding box of the largest 4-connected component of set pixels.
 *
 * Throws when the mask is empty: "no block" is a finding about the frame, not
 * a zero-sized box to compare ratios of.
 */
export function solidBox(mask: ColorMask): SolidBox {
  const { width, height, data } = mask;
  const seen = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let best: Component | null = null;
  let runnerUp: Component | null = null;
  let components = 0;

  for (let start = 0; start < data.length; start++) {
    if (!data[start] || seen[start]) continue;
    components++;
    let top = height, bottom = -1, left = width, right = -1, pixels = 0;
    let depth = 0;
    stack[depth++] = start;
    seen[start] = 1;
    while (depth > 0) {
      const i = stack[--depth];
      const x = i % width;
      const y = (i - x) / width;
      pixels++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x > 0 && data[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[depth++] = i - 1; }
      if (x + 1 < width && data[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[depth++] = i + 1; }
      if (y > 0 && data[i - width] && !seen[i - width]) { seen[i - width] = 1; stack[depth++] = i - width; }
      if (y + 1 < height && data[i + width] && !seen[i + width]) { seen[i + width] = 1; stack[depth++] = i + width; }
    }
    const found: Component = { left, top, width: right - left + 1, height: bottom - top + 1, pixels };
    if (!best || found.pixels > best.pixels) {
      runnerUp = best;
      best = found;
    } else if (!runnerUp || found.pixels > runnerUp.pixels) {
      runnerUp = found;
    }
  }

  if (!best) throw new Error("no matching pixel in the frame: there is no block to measure");
  return { ...best, components, runnerUp, stray: mask.count - best.pixels };
}

/** One line describing a measurement, for assertion messages. */
export function describeBox(box: SolidBox): string {
  const runnerUp = box.runnerUp
    ? `, runner-up ${box.runnerUp.width}x${box.runnerUp.height} (${box.runnerUp.pixels} px) at (${box.runnerUp.left},${box.runnerUp.top})`
    : "";
  return `${box.width}x${box.height} block of ${box.pixels} px at (${box.left},${box.top}); `
    + `${box.components} component(s), ${box.stray} stray px${runnerUp}`;
}
