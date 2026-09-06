// Qt's ECMAScript runtime lacks these standard library methods even when the
// bundle syntax has been lowered by esbuild.
if (!Object.entries)
  Object.entries = (o: object) =>
    Object.keys(o).map((k) => [k, (o as Record<string, unknown>)[k]]) as any;
if (!Object.values)
  Object.values = (o: object) =>
    Object.keys(o).map((k) => (o as Record<string, unknown>)[k]) as any;
if (!Object.fromEntries)
  Object.fromEntries = (entries: Iterable<readonly [PropertyKey, unknown]>) => {
    const result: Record<PropertyKey, unknown> = {};
    for (const [k, v] of entries)
      Object.defineProperty(result, k, {
        value: v,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    return result;
  };
if (!Array.prototype.flatMap)
  Object.defineProperty(Array.prototype, "flatMap", {
    value: function (
      this: unknown[],
      f: (value: unknown, index: number, array: unknown[]) => unknown,
    ) {
      return this.reduce<unknown[]>((a, v, i) => a.concat(f(v, i, this)), []);
    },
    configurable: true,
    writable: true,
  });
