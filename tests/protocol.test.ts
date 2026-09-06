import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toolSchemas,
  operationSchema,
  rectSchema,
  stable,
  contains,
} from "../packages/protocol/src/index";
test("bounded regions allow negative coordinates and reject excessive reads", () => {
  assert.equal(
    rectSchema.parse({ x: -2, y: -4, width: 128, height: 128 }).x,
    -2,
  );
  assert.equal(
    rectSchema.safeParse({ x: 0, y: 0, width: 129, height: 128 }).success,
    false,
  );
  assert.equal(
    rectSchema.safeParse({ x: 0.5, y: 0, width: 2, height: 2 }).success,
    false,
  );
});
test("cell schema preserves local tile IDs and transformation flags", () => {
  const op = operationSchema.parse({
    op: "set_tiles",
    layerId: 4,
    cells: [
      { x: -1, y: 2, tile: { tilesetId: "set", tileId: 0, flags: 15 } },
      { x: 2, y: 2, tile: null },
    ],
  });
  assert.equal(op.op, "set_tiles");
  assert.equal(
    operationSchema.safeParse({
      op: "set_tiles",
      layerId: 4,
      cells: [{ x: 0, y: 0, tile: { tilesetId: "set", tileId: 0, flags: 16 } }],
    }).success,
    false,
  );
});
test("mutations require explicit target, revision and stable request ID", () => {
  assert.equal(
    toolSchemas.apply_operations.safeParse({ operations: [] }).success,
    false,
  );
  assert.equal(
    toolSchemas.get_editor_state.safeParse({ code: "eval" }).success,
    false,
  );
});
test("property and geometry validation reject unsupported and malformed values", () => {
  assert.equal(
    operationSchema.safeParse({
      op: "set_properties",
      target: "document",
      properties: { value: { type: "enum", value: "foo" } },
    }).success,
    false,
  );
  assert.equal(
    operationSchema.safeParse({
      op: "create_objects",
      layerId: 1,
      objects: [
        {
          shape: "polygon",
          x: 0,
          y: 0,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    }).success,
    false,
  );
  const value = operationSchema.parse({
    op: "set_properties",
    target: "document",
    properties: { one: { type: "float", value: 1 } },
  });
  assert.equal(value.op, "set_properties");
});
test("canonical signatures ignore object insertion order and preserve masks", () => {
  assert.equal(stable({ b: 2, a: [1, 2] }), stable({ a: [1, 2], b: 2 }));
  assert.notEqual(stable([1, 2]), stable([2, 1]));
  const mask = [
    { x: 0, y: 0, width: 2, height: 2 },
    { x: 3, y: 0, width: 1, height: 2 },
  ];
  assert.equal(
    mask.some((r) => contains(r, 2, 1)),
    false,
  );
});
