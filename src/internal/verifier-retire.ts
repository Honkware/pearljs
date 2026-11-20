// WebAssembly memory never shrinks, so pearljs/verify-proof lets its instance
// go after any call that leaves the memory past this size, and the next call
// loads a fresh one. The steady sizes measured are 14 MiB after V4
// certificates, 29 MiB after V1, 48 MiB after V2 and V3, 21.7 MiB in browsers
// across kinds, and 100 MiB with all three caches loaded over 510 mixed
// certificates: 256 MiB is past every one of them, so honest use never
// reloads, and a proof that drives an allocation past it costs one reload.
// An object so the tests can lower it.
export const retirement = { bytes: 256 * 1024 * 1024 };
