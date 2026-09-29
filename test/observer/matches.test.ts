import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesInPage } from "../../src/observer/matches.ts";

test("full-page assertions inspect late text and native control names", () => {
  const globals = globalThis as unknown as {
    document: Document;
    Document: typeof Document;
    HTMLIFrameElement: typeof HTMLIFrameElement;
  };
  const previous = {
    document: globals.document,
    Document: globals.Document,
    HTMLIFrameElement: globals.HTMLIFrameElement,
  };
  class FakeDocument {
    body = { innerText: `${"x".repeat(2000)}Beyond compact` };
    elements: FakeElement[] = [];
    querySelectorAll(): FakeElement[] {
      return this.elements;
    }
    getElementById(): null {
      return null;
    }
  }
  class FakeElement {
    tagName: string;
    textContent: string;
    ownerDocument: FakeDocument;
    shadowRoot = null;
    labels: { textContent: string }[] | null;
    type: string;
    constructor(document: FakeDocument, tag: string, text: string, type = "") {
      this.ownerDocument = document;
      this.tagName = tag;
      this.textContent = text;
      this.type = type;
      this.labels = tag === "INPUT" ? [{ textContent: text }] : null;
    }
    getAttribute(): null {
      return null;
    }
    hasAttribute(): boolean {
      return false;
    }
    closest(): null {
      return null;
    }
  }
  const document = new FakeDocument();
  document.elements = [
    new FakeElement(document, "BUTTON", "Deep result"),
    new FakeElement(document, "INPUT", "Password", "password"),
  ];
  globals.document = document as unknown as Document;
  globals.Document = FakeDocument as unknown as typeof Document;
  globals.HTMLIFrameElement = class {} as typeof HTMLIFrameElement;
  try {
    assert.equal(
      matchesInPage({
        text_present: "Beyond compact",
        element_present: { role: "button", name: "Deep result" },
      }),
      true,
    );
    assert.equal(matchesInPage({ element_present: { role: "input", name: "Password" } }), true);
    assert.equal(matchesInPage({ text_present: "absent" }), false);
    assert.equal(matchesInPage({ element_present: { role: "button", name: "Missing" } }), false);
  } finally {
    globals.document = previous.document;
    globals.Document = previous.Document;
    globals.HTMLIFrameElement = previous.HTMLIFrameElement;
  }
});

test("M6f: page matcher requires a live editable echo before suppressing text", () => {
  const globals = globalThis as unknown as {
    document: Document;
    Document: typeof Document;
    HTMLIFrameElement: typeof HTMLIFrameElement;
  };
  const previous = {
    document: globals.document,
    Document: globals.Document,
    HTMLIFrameElement: globals.HTMLIFrameElement,
  };
  const field = {
    tagName: "INPUT",
    value: "paper",
    shadowRoot: null,
    isContentEditable: false,
  };
  class FakeDocument {
    body = { innerText: "paper suggestion" };
    querySelectorAll(): (typeof field)[] {
      return [field];
    }
  }
  globals.document = new FakeDocument() as unknown as Document;
  globals.Document = FakeDocument as unknown as typeof Document;
  globals.HTMLIFrameElement = class {} as typeof HTMLIFrameElement;
  try {
    assert.equal(matchesInPage({ text_present: "paper" }, ["paper"]), false);
    field.value = "";
    assert.equal(matchesInPage({ text_present: "paper" }, ["paper"]), true);
    field.value = "paper";
    assert.equal(matchesInPage({ text_present: "paper" }, ["p"]), true);
  } finally {
    globals.document = previous.document;
    globals.Document = previous.Document;
    globals.HTMLIFrameElement = previous.HTMLIFrameElement;
  }
});
