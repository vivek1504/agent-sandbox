import { describe, it, expect, beforeEach } from "vitest";
import {
  allocateSlot,
  releaseSlot,
  MAX_SLOTS,
  recoverUsedSlots,
} from "./networking.js";

describe("networking slot management", () => {
  beforeEach(() => {
    // Release slots
    for (let i = 1; i <= MAX_SLOTS; i++) {
      releaseSlot(i);
    }
  });

  it("allocates sequential slots starting from 1", () => {
    const slot1 = allocateSlot();
    const slot2 = allocateSlot();
    const slot3 = allocateSlot();

    expect(slot1).toBe(1);
    expect(slot2).toBe(2);
    expect(slot3).toBe(3);
  });

  it("reuses released slots", () => {
    const s1 = allocateSlot(); // 1
    const s2 = allocateSlot(); // 2
    const s3 = allocateSlot(); // 3

    releaseSlot(s2); // release 2

    const sNew = allocateSlot();
    expect(sNew).toBe(2); // reuses slot 2
  });

  it("throws error when max slots capacity is reached", () => {
    const allocated: number[] = [];
    for (let i = 1; i <= MAX_SLOTS; i++) {
      allocated.push(allocateSlot());
    }

    expect(allocated.length).toBe(MAX_SLOTS);
    expect(() => allocateSlot()).toThrow(`No available network slots (max ${MAX_SLOTS} concurrent VMs)`);
  });

  it("recoverUsedSlots resets usedSlots when OS command fails or is mockable", () => {
    allocateSlot();
    allocateSlot();
    expect(() => recoverUsedSlots()).not.toThrow();
  });
});
