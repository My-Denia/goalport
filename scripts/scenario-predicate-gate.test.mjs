import assert from "node:assert/strict";
import test from "node:test";
import { predicateBindingErrors } from "./verify.mjs";

test("predicate gate rejects unbound duplicate and generic reports", () => {
  const id = "QUA-03";
  assert.ok(predicateBindingErrors({ predicateSet: "OTHER", predicates: [`${id}:a`, `${id}:b`] }, id).length > 0);
  assert.ok(predicateBindingErrors({ predicateSet: id, predicates: [`${id}:same`, `${id}:same`] }, id).length > 0);
  assert.ok(predicateBindingErrors({ predicateSet: id, predicates: [`${id}:generic-a`, `${id}:generic-b`] }, id).length > 0);
});

test("predicate gate accepts a bound unique semantic set", () => {
  assert.deepEqual(
    predicateBindingErrors(
      { predicateSet: "SAF-02", predicates: ["SAF-02:authority-denies-commit", "SAF-02:authority-denies-push"] },
      "SAF-02"
    ),
    []
  );
});
