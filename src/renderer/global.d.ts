// Augment window.c2c with strongly typed API.
import type { C2CApi } from "../preload/preload.js";

declare global {
  interface Window {
    c2c: C2CApi;
  }
}

export {};