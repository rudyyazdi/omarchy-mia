/** Throws unless every limit is a positive integer: a NaN cap would bound nothing, a zero buffer never holds. */
export const assertLimits = (limits: Record<string, number>): void => {
  for (const [name, value] of Object.entries(limits))
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive integer, got ${value}`);
};
