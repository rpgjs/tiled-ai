// IDs observed in the pinned RPGJS atlas. This recipe is demo-specific.
export function houseOperations(tilesetId) {
  const cells = [],
    decor = [],
    ground = [];
  const put = (array, x, y, tileId) =>
    array.push({ x, y, tile: { tilesetId, tileId, flags: 0 } });
  const roof = [579, 579, 579, 587];
  for (let y = 0; y < 4; y++)
    for (let x = 2; x < 10; x++) put(cells, x, y + 2, roof[y]);
  for (let y = 6; y < 9; y++)
    for (let x = 2; x < 10; x++) put(cells, x, y, y === 8 ? 392 : 384);
  put(cells, 5, 7, 391);
  put(cells, 5, 8, 399);
  for (const x of [3, 7]) {
    put(decor, x, 6, 596);
    put(decor, x, 7, 604);
  }
  for (let y = 9; y < 14; y++) {
    put(ground, 5, y, 5);
    put(ground, 6, y, 5);
  }
  for (const [x, y] of [
    [0, 1],
    [10, 1],
    [0, 10],
    [10, 10],
  ]) {
    put(decor, x, y, 8);
    put(decor, x + 1, y, 9);
    put(decor, x, y + 1, 16);
    put(decor, x + 1, y + 1, 17);
  }
  for (const [x, y, id] of [
    [2, 10, 52],
    [3, 11, 53],
    [8, 10, 54],
    [9, 11, 55],
    [2, 12, 40],
    [8, 12, 40],
  ])
    put(decor, x, y, id);
  return [
    { op: "set_tiles", layerId: 1, cells: ground },
    { op: "set_tiles", layerId: 2, cells },
    { op: "set_tiles", layerId: 3, cells: decor },
    {
      op: "create_objects",
      layerId: 4,
      objects: [
        {
          name: "House body",
          className: "Collision",
          x: 64,
          y: 64,
          width: 256,
          height: 192,
          properties: { collision: { type: "bool", value: true } },
        },
        {
          name: "Left facade",
          className: "Collision",
          x: 64,
          y: 256,
          width: 96,
          height: 32,
          properties: { collision: { type: "bool", value: true } },
        },
        {
          name: "Right facade",
          className: "Collision",
          x: 192,
          y: 256,
          width: 128,
          height: 32,
          properties: { collision: { type: "bool", value: true } },
        },
      ],
    },
  ];
}
