"use client";

import { useSyncExternalStore } from "react";
import { getModelState, subscribeModel, type ModelState } from "./kokoro";

const SERVER_STATE: ModelState = { phase: "idle", ratio: 0, detail: "", device: null };

/**
 * Read the on-device model's load state.
 *
 * `useSyncExternalStore` rather than an effect because the download can finish
 * between the first render and the effect firing, and a progress bar that
 * misses its own completion is worse than no progress bar.
 */
export function useModelState(): ModelState {
  return useSyncExternalStore(subscribeModel, getModelState, () => SERVER_STATE);
}
