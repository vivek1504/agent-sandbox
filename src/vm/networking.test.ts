import { describe, it, expect, beforeEach } from "vitest";
import {
  allocateSlot,
  releaseSlot,
  MAX_SLOTS,
} from "./networking.js";

describe("Networking Slot Allocator", () => {
  const allocated: number[] = [];

  beforeEach(() => {
    while (allocated.length > 0) {
      const slot = allocated.pop();
      if (slot !== undefined) {
        releaseSlot(slot);
      }
    }
  });

  it("allocates sequential slots starting from 1", () => {
    const slot1 = allocateSlot();
    allocated.push(slot1);
    const slot2 = allocateSlot();
    allocated.push(slot2);

    expect(slot1).toBeGreaterThanOrEqual(1);
    expect(slot2).toBe(slot1 + 1);
  });

  it("re-allocates a slot after it has been released", () => {
    const slot1 = allocateSlot();
    const slot2 = allocateSlot();
    allocated.push(slot2);

    releaseSlot(slot1);
    const slotReallocated = allocateSlot();
    allocated.push(slotReallocated);

    expect(slotReallocated).toBe(slot1);
  });

  it("throws an error when all slots are exhausted", () => {
    const tempAllocated: number[] = [];
    try {
      for (let i = 1; i <= MAX_SLOTS; i++) {
        try {
          const s = allocateSlot();
          tempAllocated.push(s);
        } catch {
          break;
        }
      }

      expect(() => allocateSlot()).toThrow(/No available network slots/);
    } finally {
      for (const s of tempAllocated) {
        releaseSlot(s);
      }
    }
  });
});
