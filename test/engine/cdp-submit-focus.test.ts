import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { focusedSubmitTargetInPage } from "../../src/engine/cdp/driver.ts";

test("focused submit accepts same-form input or a searchbox and rejects unrelated focus", () => {
  class Input {
    type = "text";
    value = "query";
    disabled = false;
    readOnly = false;
    form: { id: string; ownerDocument: { forms: unknown[] } } | null = null;
    role: string | null = null;
    getAttribute(name: string) {
      return name === "role" ? this.role : null;
    }
  }
  class Textarea extends Input {}
  const active = new Input();
  const document = { activeElement: active };
  const registry = { epoch: 1, refs: new Map([["e1", new WeakRef(active)]]) };
  const check = runInNewContext(`(${focusedSubmitTargetInPage.toString()})`, {
    document,
    __jevpilotObserverRegistry: registry,
    HTMLInputElement: Input,
    HTMLTextAreaElement: Textarea,
  }) as typeof focusedSubmitTargetInPage;
  const form = { id: "search", ownerDocument: { forms: [] } };
  active.form = form;
  assert.equal(check(1, "e1", "form:search", false), true);
  assert.equal(check(1, "e1", "form:other", false), true);
  assert.equal(check(1, "missing", "form:other", false), false);
  active.form = null;
  assert.equal(check(1, "e1", "implicit", false), true);
  assert.equal(check(1, "missing", "implicit", false), false);
  active.form = form;
  active.type = "search";
  assert.equal(check(1, "missing", "form:other", true), true);
  active.type = "text";
  active.role = "searchbox";
  assert.equal(check(1, "missing", undefined, true), true);
  active.value = "";
  assert.equal(check(1, "e1", "form:search", true), false);
  active.value = "query";
  active.disabled = true;
  assert.equal(check(1, "e1", "form:search", true), false);
  document.activeElement = {} as Input;
  assert.equal(check(1, "e1", "form:search", true), false);
});
