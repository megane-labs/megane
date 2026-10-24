import { describe, it, expect } from "vitest";
import { FpsCounter } from "@/renderer/FpsCounter";

describe("FpsCounter", () => {
  it("reports 0 before the first window closes", () => {
    const c = new FpsCounter(500);
    expect(c.fps).toBe(0);
    // First tick only seeds the baseline timestamp.
    c.tick(0);
    expect(c.fps).toBe(0);
    // A few frames within the window — still no computed value yet.
    c.tick(100);
    c.tick(200);
    expect(c.fps).toBe(0);
  });

  it("computes fps once a full window elapses", () => {
    const c = new FpsCounter(500);
    c.tick(0); // seed
    // 30 frames spread evenly to exactly 500ms → 60 fps.
    for (let i = 1; i <= 30; i++) {
      c.tick((500 / 30) * i);
    }
    expect(Math.round(c.fps)).toBe(60);
  });

  it("recomputes on each subsequent window and resets the frame count", () => {
    const c = new FpsCounter(1000);
    c.tick(0); // seed
    // Window 1: 10 frames over 1000ms → 10 fps.
    for (let i = 1; i <= 10; i++) c.tick(100 * i);
    expect(Math.round(c.fps)).toBe(10);
    // Window 2: 30 frames over the next 1000ms → 30 fps (count reset, no carry-over).
    for (let i = 1; i <= 30; i++) c.tick(1000 + (1000 / 30) * i);
    expect(Math.round(c.fps)).toBe(30);
  });

  it("holds the last value until the next window closes", () => {
    const c = new FpsCounter(500);
    c.tick(0);
    for (let i = 1; i <= 30; i++) c.tick((500 / 30) * i);
    const first = c.fps;
    // A couple more frames that do not yet complete the next window.
    c.tick(510);
    c.tick(520);
    expect(c.fps).toBe(first);
  });

  it("counts only drawn frames, so an idle viewer reads 0", () => {
    const c = new FpsCounter(500);
    c.tick(0);
    // 10 animation frames over 500ms, of which 5 were drawn → 10 fps.
    for (let i = 1; i <= 10; i++) c.tick(50 * i, i % 2 === 0);
    expect(c.fps).toBe(10);
    // A window of skipped frames only (nothing changed on screen).
    for (let i = 1; i <= 10; i++) c.tick(500 + 50 * i, false);
    expect(c.fps).toBe(0);
  });

  it("defaults to a 500ms window", () => {
    const c = new FpsCounter();
    c.tick(0);
    for (let i = 1; i <= 30; i++) c.tick((500 / 30) * i);
    expect(Math.round(c.fps)).toBe(60);
  });
});
